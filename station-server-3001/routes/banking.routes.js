const express = require('express');
const logger = require('../utils/logger')('BankingRoutes');
const db = require('../utils/db');
const { offlineAuthMiddleware, requireRole } = require('../middleware/offline-auth');

const router = express.Router();

/**
 * @swagger
 * tags:
 *   name: Banking
 *   description: Cash banking workflow for Advanced (RFID) shifts — cash counts and bank deposits
 */

/*
 * Architecture notes
 * ------------------
 *   - Banking is wired to `rfid_shifts` + `rfid_shift_cashup` (the Advanced Shift tables),
 *     NOT the legacy `shifts` / `shift_cashup` tables.
 *   - `rfid_shifts.status` values: open, closed, reconciled.
 *       - `reconciled` is set automatically when every attendant has cashed up
 *         (see checkAutoReconcile in rfid-shifts.routes.js). It does NOT mean banked.
 *   - Whether a shift has been banked is derived from `banking_cash_counts.shift_id`.
 *   - Default list filter: status='reconciled' AND no cash count yet → "ready to bank".
 */

const DEPOSIT_FIELDS = `id, shift_id, company_id, station_id, reference, bank, amount,
  deposited_by_user_id, deposited_by_name, status, notes,
  recorded_at, confirmed_at`;

// ════════════════════════════════════════════════════════════════════════════
//  SHIFTS READY FOR BANKING
// ════════════════════════════════════════════════════════════════════════════

/**
 * @swagger
 * /api/banking/shifts:
 *   get:
 *     summary: List RFID shifts ready for banking (reconciled and not yet banked)
 *     description: |
 *       Returns RFID shifts with totals aggregated from `rfid_shift_cashup`.
 *       Default filter: `status='reconciled'` AND no banking cash count yet.
 *       Pass `include_banked=true` to also return shifts that have already been banked.
 *     tags: [Banking]
 *     parameters:
 *       - in: query
 *         name: station_id
 *         schema: { type: string, format: uuid }
 *       - in: query
 *         name: status
 *         schema: { type: string, enum: [closed, reconciled] }
 *         description: Override default status filter (default is "reconciled" only)
 *       - in: query
 *         name: include_banked
 *         schema: { type: boolean, default: false }
 *       - in: query
 *         name: from
 *         schema: { type: string, format: date-time }
 *       - in: query
 *         name: to
 *         schema: { type: string, format: date-time }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 100 }
 *       - in: query
 *         name: offset
 *         schema: { type: integer, default: 0 }
 *     responses:
 *       200:
 *         description: List of bankable RFID shifts
 */
router.get('/shifts', async (req, res) => {
  try {
    const {
      station_id,
      status,
      include_banked,
      from,
      to,
      limit = 100,
      offset = 0,
    } = req.query;

    const params = [];
    let p = 0;
    const where = [];

    if (status) {
      where.push(`s.status = $${++p}`);
      params.push(status);
    } else {
      where.push(`s.status = 'reconciled'`);
    }

    if (!['1', 'true', 'yes'].includes(String(include_banked).toLowerCase())) {
      where.push(`bcc.id IS NULL`);
    }

    if (station_id) { where.push(`s.station_id = $${++p}`); params.push(station_id); }
    if (from)       { where.push(`s.start_datetime >= $${++p}`); params.push(from); }
    if (to)         { where.push(`s.start_datetime <= $${++p}`); params.push(to); }

    const query = `
      SELECT
        s.id,
        s.company_id,
        s.station_id,
        s.start_datetime,
        s.end_datetime,
        s.status AS shift_status,
        u.full_name AS manager_name,
        COALESCE(c.pts_grand_total,    0) AS total_sales,
        COALESCE(c.total_card,         0) AS card_sales,
        COALESCE(c.total_mobile,       0) AS mobile_money,
        COALESCE(c.total_debtor,       0) AS account_sales,
        COALESCE(c.total_cash,         0) AS expected_cash,
        COALESCE(c.grand_variance,     0) AS cashup_variance,
        COALESCE(c.attendants_cashed_up, 0) AS attendants_cashed_up,
        bcc.cash_counted,
        bcc.variance AS banking_variance,
        (bcc.id IS NOT NULL) AS is_banked,
        CASE WHEN bcc.id IS NOT NULL THEN 'banked' ELSE s.status END AS status,
        'SFT-' || to_char(s.start_datetime, 'YYYYMMDD') || '-' ||
          lpad(
            row_number() OVER (
              PARTITION BY s.station_id, date_trunc('day', s.start_datetime)
              ORDER BY s.start_datetime
            )::text, 3, '0'
          ) AS shift_number
      FROM rfid_shifts s
      LEFT JOIN users u ON u.id = s.created_by
      LEFT JOIN LATERAL (
        SELECT
          SUM(pts_total)       AS pts_grand_total,
          SUM(declared_card)   AS total_card,
          SUM(declared_mobile) AS total_mobile,
          SUM(declared_debtor) AS total_debtor,
          SUM(declared_cash)   AS total_cash,
          SUM(variance)        AS grand_variance,
          COUNT(*)             AS attendants_cashed_up
        FROM rfid_shift_cashup
        WHERE shift_id = s.id
      ) c ON TRUE
      LEFT JOIN banking_cash_counts bcc ON bcc.shift_id = s.id
      WHERE ${where.join(' AND ')}
      ORDER BY s.start_datetime DESC
      LIMIT $${++p} OFFSET $${++p}
    `;
    params.push(parseInt(limit), parseInt(offset));

    const rows = (await db.query(query, params)).rows;

    res.json({ success: true, count: rows.length, shifts: rows });
  } catch (error) {
    logger.error('Error listing bankable shifts', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /api/banking/shifts/{id}:
 *   get:
 *     summary: Get a single RFID shift with totals and saved cash count
 *     tags: [Banking]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Shift totals + cash count (if recorded)
 *       404:
 *         description: Shift not found
 */
router.get('/shifts/:id', async (req, res) => {
  try {
    const shiftId = req.params.id;

    const shift = await db.query(
      `SELECT s.*, u.full_name AS manager_name
         FROM rfid_shifts s
         LEFT JOIN users u ON u.id = s.created_by
        WHERE s.id = $1`, [shiftId]
    );
    if (shift.rows.length === 0) return res.status(404).json({ error: 'Shift not found' });

    const totals = await db.query(
      `SELECT
         COALESCE(SUM(pts_total),       0) AS total_sales,
         COALESCE(SUM(declared_card),   0) AS card_sales,
         COALESCE(SUM(declared_mobile), 0) AS mobile_money,
         COALESCE(SUM(declared_debtor), 0) AS account_sales,
         COALESCE(SUM(declared_cash),   0) AS expected_cash,
         COALESCE(SUM(variance),        0) AS cashup_variance,
         COUNT(*)                          AS attendants_cashed_up
       FROM rfid_shift_cashup WHERE shift_id = $1`, [shiftId]
    );

    const cashups = await db.query(
      `SELECT id, attendant_id, tag_number, attendant_name,
              pts_total, pts_volume, pts_count,
              declared_cash, declared_card, declared_mobile, declared_debtor,
              declared_total, variance, notes, created_at
         FROM rfid_shift_cashup
        WHERE shift_id = $1
        ORDER BY created_at`, [shiftId]
    );

    const count = await db.query(
      `SELECT id, denominations, cash_counted, expected_cash, variance,
              counted_by, counted_by_name, notes, created_at, updated_at
         FROM banking_cash_counts WHERE shift_id = $1`, [shiftId]
    );

    res.json({
      success: true,
      shift: shift.rows[0],
      totals: totals.rows[0],
      cashups: cashups.rows,
      cash_count: count.rows[0] || null,
    });
  } catch (error) {
    logger.error('Error fetching bankable shift', error);
    res.status(500).json({ error: error.message });
  }
});

// ════════════════════════════════════════════════════════════════════════════
//  CASH COUNT (per shift)
// ════════════════════════════════════════════════════════════════════════════

/**
 * @swagger
 * /api/banking/shifts/{id}/cash-count:
 *   post:
 *     summary: Save (or replace) the denomination cash count for an RFID shift
 *     description: |
 *       Upserts one cash count row per shift. `cash_counted` is computed server-side
 *       from `denominations` if not supplied (parses the numeric value out of the key).
 *       `expected_cash` = SUM(rfid_shift_cashup.declared_cash) across all attendants
 *       on the shift. `variance = cash_counted - expected_cash`.
 *
 *       Does NOT modify `rfid_shifts.status` — `reconciled` there already means
 *       "all attendants cashed up" and is owned by the cashup flow.
 *     tags: [Banking]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [denominations]
 *             properties:
 *               denominations:
 *                 type: object
 *                 description: |
 *                   Map of denomination label or value → count.
 *                   Either `{ "5 Kwacha (Note)": 12, ... }` or `{ "5": 12, ... }`.
 *               cash_counted:
 *                 type: number
 *                 description: Optional override (otherwise computed from denominations)
 *               notes:
 *                 type: string
 *     responses:
 *       201:
 *         description: Cash count saved
 *       400:
 *         description: Shift is still open or denominations missing
 *       404:
 *         description: Shift not found
 */
router.post('/shifts/:id/cash-count', offlineAuthMiddleware, requireRole('admin', 'manager'), async (req, res) => {
  try {
    const shiftId = req.params.id;
    const { denominations, cash_counted, notes } = req.body;

    if (!denominations || typeof denominations !== 'object') {
      return res.status(400).json({ error: 'denominations object is required' });
    }

    const shift = await db.query('SELECT id, status FROM rfid_shifts WHERE id = $1', [shiftId]);
    if (shift.rows.length === 0) return res.status(404).json({ error: 'Shift not found' });
    if (shift.rows[0].status === 'open') {
      return res.status(400).json({ error: 'Cannot count cash for an open shift' });
    }

    // Compute total from denominations if not supplied. Supports both
    // `{ "5 Kwacha (Note)": 12 }` and `{ "5": 12 }` shapes — anything where
    // the label/key contains a numeric value works.
    let counted = Number(cash_counted);
    if (!Number.isFinite(counted)) {
      counted = 0;
      for (const [label, qty] of Object.entries(denominations)) {
        const match = String(label).match(/[\d.]+/);
        const value = match ? parseFloat(match[0]) : NaN;
        const count = Number(qty);
        if (Number.isFinite(value) && Number.isFinite(count)) {
          counted += value * count;
        }
      }
    }

    // Expected cash = SUM(declared_cash) across all per-attendant cashups
    const exp = await db.query(
      `SELECT COALESCE(SUM(declared_cash), 0) AS expected_cash
         FROM rfid_shift_cashup WHERE shift_id = $1`, [shiftId]
    );
    const expected = parseFloat(exp.rows[0].expected_cash) || 0;
    const variance = counted - expected;

    const result = await db.query(
      `INSERT INTO banking_cash_counts
         (shift_id, denominations, cash_counted, expected_cash, variance,
          counted_by, counted_by_name, notes, synced)
       VALUES ($1, $2::jsonb, $3, $4, $5, $6, $7, $8, FALSE)
       ON CONFLICT (shift_id) DO UPDATE SET
         denominations   = EXCLUDED.denominations,
         cash_counted    = EXCLUDED.cash_counted,
         expected_cash   = EXCLUDED.expected_cash,
         variance        = EXCLUDED.variance,
         counted_by      = EXCLUDED.counted_by,
         counted_by_name = EXCLUDED.counted_by_name,
         notes           = EXCLUDED.notes,
         updated_at      = now(),
         synced          = FALSE
       RETURNING *`,
      [
        shiftId,
        JSON.stringify(denominations),
        counted,
        expected,
        variance,
        req.user?.id || null,
        req.user?.full_name || req.user?.username || null,
        notes || null,
      ]
    );

    logger.info(`✅ Cash count saved for rfid_shift ${shiftId}: counted=${counted}, expected=${expected}, variance=${variance}`);
    res.status(201).json({ success: true, cash_count: result.rows[0] });
  } catch (error) {
    logger.error('Error saving cash count', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /api/banking/shifts/{id}/cash-count:
 *   get:
 *     summary: Get the saved cash count for an RFID shift
 *     tags: [Banking]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Saved cash count
 *       404:
 *         description: No cash count recorded for this shift
 */
router.get('/shifts/:id/cash-count', async (req, res) => {
  try {
    const result = await db.query(
      `SELECT * FROM banking_cash_counts WHERE shift_id = $1`, [req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'No cash count recorded' });
    res.json({ success: true, cash_count: result.rows[0] });
  } catch (error) {
    logger.error('Error fetching cash count', error);
    res.status(500).json({ error: error.message });
  }
});

// ════════════════════════════════════════════════════════════════════════════
//  DEPOSITS (CRUD)
// ════════════════════════════════════════════════════════════════════════════

/**
 * @swagger
 * /api/banking/deposits:
 *   get:
 *     summary: List bank deposits
 *     tags: [Banking]
 *     parameters:
 *       - in: query
 *         name: station_id
 *         schema: { type: string, format: uuid }
 *       - in: query
 *         name: shift_id
 *         schema: { type: string, format: uuid }
 *         description: Filters by rfid_shifts.id
 *       - in: query
 *         name: status
 *         schema: { type: string, enum: [pending, confirmed, queried] }
 *       - in: query
 *         name: bank
 *         schema: { type: string }
 *       - in: query
 *         name: from
 *         schema: { type: string, format: date-time }
 *       - in: query
 *         name: to
 *         schema: { type: string, format: date-time }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 100 }
 *       - in: query
 *         name: offset
 *         schema: { type: integer, default: 0 }
 *     responses:
 *       200:
 *         description: List of deposits
 */
router.get('/deposits', async (req, res) => {
  try {
    const { station_id, shift_id, status, bank, from, to, limit = 100, offset = 0 } = req.query;

    let query = `SELECT ${DEPOSIT_FIELDS} FROM banking_deposits WHERE 1=1`;
    const params = [];
    let p = 0;

    if (station_id) { query += ` AND station_id = $${++p}`; params.push(station_id); }
    if (shift_id)   { query += ` AND shift_id   = $${++p}`; params.push(shift_id); }
    if (status)     { query += ` AND status     = $${++p}`; params.push(status); }
    if (bank)       { query += ` AND bank ILIKE $${++p}`;   params.push(`%${bank}%`); }
    if (from)       { query += ` AND recorded_at >= $${++p}`; params.push(from); }
    if (to)         { query += ` AND recorded_at <= $${++p}`; params.push(to); }

    query += ` ORDER BY recorded_at DESC LIMIT $${++p} OFFSET $${++p}`;
    params.push(parseInt(limit), parseInt(offset));

    const result = await db.query(query, params);
    res.json({ success: true, count: result.rows.length, deposits: result.rows });
  } catch (error) {
    logger.error('Error listing deposits', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /api/banking/deposits/{id}:
 *   get:
 *     summary: Get a single deposit
 *     tags: [Banking]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Deposit record
 *       404:
 *         description: Not found
 */
router.get('/deposits/:id', async (req, res) => {
  try {
    const result = await db.query(
      `SELECT ${DEPOSIT_FIELDS} FROM banking_deposits WHERE id = $1`, [req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Deposit not found' });
    res.json({ success: true, deposit: result.rows[0] });
  } catch (error) {
    logger.error('Error fetching deposit', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /api/banking/deposits:
 *   post:
 *     summary: Record a new bank deposit
 *     tags: [Banking]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [reference, bank, amount]
 *             properties:
 *               shift_id:   { type: string, format: uuid, description: "rfid_shifts.id" }
 *               company_id: { type: string, format: uuid }
 *               station_id: { type: string, format: uuid }
 *               reference:  { type: string }
 *               bank:       { type: string }
 *               amount:     { type: number }
 *               deposited_by_name: { type: string }
 *               notes:      { type: string }
 *               status:
 *                 type: string
 *                 enum: [pending, confirmed, queried]
 *                 default: pending
 *     responses:
 *       201:
 *         description: Deposit recorded
 */
router.post('/deposits', offlineAuthMiddleware, requireRole('admin', 'manager'), async (req, res) => {
  try {
    const {
      shift_id, company_id, station_id,
      reference, bank, amount,
      deposited_by_name, notes, status = 'pending',
    } = req.body;

    if (!reference || !bank || amount === undefined || amount === null) {
      return res.status(400).json({ error: 'reference, bank, and amount are required' });
    }
    if (Number(amount) < 0) {
      return res.status(400).json({ error: 'amount must be non-negative' });
    }
    if (!['pending', 'confirmed', 'queried'].includes(status)) {
      return res.status(400).json({ error: 'status must be one of: pending, confirmed, queried' });
    }

    // Derive company_id / station_id from the rfid_shift if available and not provided
    let resolvedCompanyId = company_id || null;
    let resolvedStationId = station_id || null;
    if (shift_id && (!resolvedCompanyId || !resolvedStationId)) {
      const s = await db.query('SELECT company_id, station_id FROM rfid_shifts WHERE id = $1', [shift_id]);
      if (s.rows.length > 0) {
        resolvedCompanyId = resolvedCompanyId || s.rows[0].company_id;
        resolvedStationId = resolvedStationId || s.rows[0].station_id;
      }
    }

    const result = await db.query(
      `INSERT INTO banking_deposits
         (shift_id, company_id, station_id, reference, bank, amount,
          deposited_by_user_id, deposited_by_name, status, notes,
          recorded_at, confirmed_at, synced)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, now(),
               CASE WHEN $9 = 'confirmed' THEN now() ELSE NULL END,
               FALSE)
       RETURNING ${DEPOSIT_FIELDS}`,
      [
        shift_id || null, resolvedCompanyId, resolvedStationId,
        reference, bank, amount,
        req.user?.id || null,
        deposited_by_name || req.user?.full_name || req.user?.username || null,
        status, notes || null,
      ]
    );

    logger.info(`✅ Deposit recorded: ${reference} @ ${bank} = ${amount} (${status})`);
    res.status(201).json({ success: true, deposit: result.rows[0] });
  } catch (error) {
    logger.error('Error recording deposit', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /api/banking/deposits/{id}:
 *   put:
 *     summary: Update a deposit (status change, correction, etc.)
 *     tags: [Banking]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               reference: { type: string }
 *               bank:      { type: string }
 *               amount:    { type: number }
 *               status:
 *                 type: string
 *                 enum: [pending, confirmed, queried]
 *               notes:     { type: string }
 *               deposited_by_name: { type: string }
 *     responses:
 *       200:
 *         description: Deposit updated
 *       404:
 *         description: Not found
 */
router.put('/deposits/:id', offlineAuthMiddleware, requireRole('admin', 'manager'), async (req, res) => {
  try {
    const { reference, bank, amount, status, notes, deposited_by_name } = req.body;
    const updates = [];
    const params = [];
    let p = 1;

    if (reference !== undefined)         { updates.push(`reference = $${p++}`);         params.push(reference); }
    if (bank !== undefined)              { updates.push(`bank = $${p++}`);              params.push(bank); }
    if (amount !== undefined)            { updates.push(`amount = $${p++}`);            params.push(amount); }
    if (notes !== undefined)             { updates.push(`notes = $${p++}`);             params.push(notes); }
    if (deposited_by_name !== undefined) { updates.push(`deposited_by_name = $${p++}`); params.push(deposited_by_name); }
    if (status !== undefined) {
      if (!['pending', 'confirmed', 'queried'].includes(status)) {
        return res.status(400).json({ error: 'status must be one of: pending, confirmed, queried' });
      }
      updates.push(`status = $${p++}`);
      params.push(status);
      // Set/clear confirmed_at to match the new status
      updates.push(`confirmed_at = CASE WHEN $${p++}::text = 'confirmed' THEN COALESCE(confirmed_at, now()) ELSE NULL END`);
      params.push(status);
    }

    if (updates.length === 0) return res.status(400).json({ error: 'No fields to update' });

    updates.push('synced = FALSE');
    params.push(req.params.id);

    const query = `UPDATE banking_deposits SET ${updates.join(', ')} WHERE id = $${p} RETURNING ${DEPOSIT_FIELDS}`;
    const result = await db.query(query, params);

    if (result.rows.length === 0) return res.status(404).json({ error: 'Deposit not found' });

    logger.info(`✅ Deposit updated: ${result.rows[0].id} (status: ${result.rows[0].status})`);
    res.json({ success: true, deposit: result.rows[0] });
  } catch (error) {
    logger.error('Error updating deposit', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /api/banking/deposits/{id}:
 *   delete:
 *     summary: Delete a deposit
 *     tags: [Banking]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Deposit deleted
 *       404:
 *         description: Not found
 */
router.delete('/deposits/:id', offlineAuthMiddleware, requireRole('admin'), async (req, res) => {
  try {
    const result = await db.query(
      `DELETE FROM banking_deposits WHERE id = $1 RETURNING id`,
      [req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Deposit not found' });

    logger.info(`✅ Deposit deleted: ${result.rows[0].id}`);
    res.json({ success: true, message: 'Deposit deleted' });
  } catch (error) {
    logger.error('Error deleting deposit', error);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
