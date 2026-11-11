const express = require('express');
const logger = require('../utils/logger')('ShiftsRoutes');
const db = require('../utils/db');
const { offlineAuthMiddleware, requireRole } = require('../middleware/offline-auth');

const router = express.Router();

/**
 * @swagger
 * tags:
 *   name: Shifts
 *   description: Shift management, attendant assignment, PTS sales pull, and cash-up
 */

// ─────────────────────────────────────────────
//  SHIFT CRUD
// ─────────────────────────────────────────────

/**
 * @swagger
 * /api/shifts:
 *   get:
 *     summary: List shifts
 *     tags: [Shifts]
 *     parameters:
 *       - in: query
 *         name: station_id
 *         schema: { type: string, format: uuid }
 *       - in: query
 *         name: status
 *         schema: { type: string, enum: [open, closed, reconciled] }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 50 }
 *       - in: query
 *         name: offset
 *         schema: { type: integer, default: 0 }
 *     responses:
 *       200:
 *         description: List of shifts
 */
router.get('/', async (req, res) => {
    try {
        const { station_id, status, limit = 50, offset = 0 } = req.query;
        let query = `SELECT * FROM shifts WHERE 1=1`;
        const params = [];
        let p = 0;

        if (station_id) { query += ` AND station_id = $${++p}`; params.push(station_id); }
        if (status) { query += ` AND status = $${++p}`; params.push(status); }

        query += ` ORDER BY created_at DESC LIMIT $${++p} OFFSET $${++p}`;
        params.push(parseInt(limit), parseInt(offset));

        const result = await db.query(query, params);
        res.json({ success: true, count: result.rows.length, shifts: result.rows });
    } catch (error) {
        logger.error('Error fetching shifts', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * @swagger
 * /api/shifts/{id}:
 *   get:
 *     summary: Get a single shift with attendants
 *     tags: [Shifts]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Shift details with assigned attendants
 *       404:
 *         description: Shift not found
 */
router.get('/:id', async (req, res) => {
    try {
        const shift = await db.query('SELECT * FROM shifts WHERE id = $1', [req.params.id]);
        if (shift.rows.length === 0) return res.status(404).json({ error: 'Shift not found' });

        const attendants = await db.query(
            `SELECT sa.*, a.full_name, a.phone
       FROM shift_attendants sa
       LEFT JOIN attendants a ON sa.attendant_id = a.id
       WHERE sa.shift_id = $1 ORDER BY sa.pump_id`, [req.params.id]
        );

        res.json({
            success: true,
            shift: shift.rows[0],
            attendants: attendants.rows
        });
    } catch (error) {
        logger.error('Error fetching shift', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * @swagger
 * /api/shifts:
 *   post:
 *     summary: Open a new shift
 *     tags: [Shifts]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [company_id, station_id]
 *             properties:
 *               company_id:
 *                 type: string
 *                 format: uuid
 *               station_id:
 *                 type: string
 *                 format: uuid
 *     responses:
 *       201:
 *         description: Shift opened
 */
router.post('/', offlineAuthMiddleware, requireRole('admin', 'manager'), async (req, res) => {
    try {
        const { company_id, station_id, attendant_mode = 'manual' } = req.body;

        if (!company_id || !station_id) {
            return res.status(400).json({ error: 'Missing required fields: company_id, station_id' });
        }

        // Validate attendant_mode
        if (!['manual', 'rfid'].includes(attendant_mode)) {
            return res.status(400).json({ error: 'attendant_mode must be "manual" or "rfid"' });
        }

        // Check for existing open shift at this station
        const existing = await db.query(
            `SELECT id FROM shifts WHERE station_id = $1 AND status = 'open'`, [station_id]
        );
        if (existing.rows.length > 0) {
            return res.status(409).json({
                error: 'An open shift already exists for this station',
                shift_id: existing.rows[0].id
            });
        }

        const result = await db.query(
            `INSERT INTO shifts (company_id, station_id, start_datetime, status, attendant_mode, created_by, created_at, synced)
       VALUES ($1, $2, now(), 'open', $3, $4, now(), FALSE)
       RETURNING *`,
            [company_id, station_id, attendant_mode, req.user?.id || null]
        );

        logger.info(`✅ Shift opened: ${result.rows[0].id} (mode: ${attendant_mode})`);
        res.status(201).json({ success: true, shift: result.rows[0] });
    } catch (error) {
        logger.error('Error opening shift', error);
        res.status(500).json({ error: error.message });
    }
});

// ─────────────────────────────────────────────
//  ASSIGN ATTENDANTS TO PUMPS
// ─────────────────────────────────────────────

/**
 * @swagger
 * /api/shifts/{id}/attendants:
 *   post:
 *     summary: Assign attendants to pumps for this shift
 *     tags: [Shifts]
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
 *             required: [assignments]
 *             properties:
 *               assignments:
 *                 type: array
 *                 items:
 *                   type: object
 *                   required: [attendant_id, pump_id]
 *                   properties:
 *                     attendant_id:
 *                       type: string
 *                       format: uuid
 *                     pump_id:
 *                       type: integer
 *           example:
 *             assignments:
 *               - attendant_id: "uuid-1"
 *                 pump_id: 1
 *               - attendant_id: "uuid-2"
 *                 pump_id: 2
 *     responses:
 *       201:
 *         description: Attendants assigned
 */
router.post('/:id/attendants', offlineAuthMiddleware, requireRole('admin', 'manager'), async (req, res) => {
    try {
        const shiftId = req.params.id;
        const { assignments } = req.body;

        if (!assignments || !Array.isArray(assignments) || assignments.length === 0) {
            return res.status(400).json({ error: 'assignments array is required' });
        }

        // Verify shift exists and is open
        const shift = await db.query('SELECT id, status, attendant_mode FROM shifts WHERE id = $1', [shiftId]);
        if (shift.rows.length === 0) return res.status(404).json({ error: 'Shift not found' });
        if (shift.rows[0].status !== 'open') {
            return res.status(400).json({ error: 'Cannot assign attendants to a closed shift' });
        }
        if (shift.rows[0].attendant_mode === 'rfid') {
            return res.status(400).json({ error: 'Cannot manually assign attendants in RFID mode. Attendants are auto-assigned when they scan their card.' });
        }

        const inserted = [];
        for (const a of assignments) {
            if (!a.attendant_id || a.pump_id === undefined) continue;

            const result = await db.query(
                `INSERT INTO shift_attendants (shift_id, attendant_id, pump_id, created_at)
         VALUES ($1, $2, $3, now())
         ON CONFLICT DO NOTHING
         RETURNING *`,
                [shiftId, a.attendant_id, a.pump_id]
            );
            if (result.rows.length > 0) inserted.push(result.rows[0]);
        }

        logger.info(`✅ Assigned ${inserted.length} attendants to shift ${shiftId}`);
        res.status(201).json({ success: true, count: inserted.length, assignments: inserted });
    } catch (error) {
        logger.error('Error assigning attendants', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * @swagger
 * /api/shifts/{id}/attendants:
 *   get:
 *     summary: Get attendants assigned to this shift
 *     tags: [Shifts]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: List of attendant-pump assignments
 */
router.get('/:id/attendants', async (req, res) => {
    try {
        const result = await db.query(
            `SELECT sa.id, sa.shift_id, sa.attendant_id, sa.pump_id,
              a.full_name, a.phone
       FROM shift_attendants sa
       LEFT JOIN attendants a ON sa.attendant_id = a.id
       WHERE sa.shift_id = $1 ORDER BY sa.pump_id`, [req.params.id]
        );
        res.json({ success: true, count: result.rows.length, attendants: result.rows });
    } catch (error) {
        logger.error('Error fetching shift attendants', error);
        res.status(500).json({ error: error.message });
    }
});

// ─────────────────────────────────────────────
//  SWITCH ATTENDANT MODE (manual ↔ rfid)
// ─────────────────────────────────────────────

/**
 * @swagger
 * /api/shifts/{id}/mode:
 *   patch:
 *     summary: Switch attendant mode for an open shift
 *     tags: [Shifts]
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
 *             required: [attendant_mode]
 *             properties:
 *               attendant_mode:
 *                 type: string
 *                 enum: [manual, rfid]
 *     responses:
 *       200:
 *         description: Mode switched
 */
router.patch('/:id/mode', offlineAuthMiddleware, requireRole('admin', 'manager'), async (req, res) => {
    try {
        const shiftId = req.params.id;
        const { attendant_mode } = req.body;

        if (!['manual', 'rfid'].includes(attendant_mode)) {
            return res.status(400).json({ error: 'attendant_mode must be "manual" or "rfid"' });
        }

        const shift = await db.query('SELECT id, status, attendant_mode FROM shifts WHERE id = $1', [shiftId]);
        if (shift.rows.length === 0) return res.status(404).json({ error: 'Shift not found' });
        if (shift.rows[0].status !== 'open') {
            return res.status(400).json({ error: 'Cannot change mode on a closed shift' });
        }

        const result = await db.query(
            'UPDATE shifts SET attendant_mode = $1 WHERE id = $2 RETURNING *',
            [attendant_mode, shiftId]
        );

        logger.info(`✅ Shift ${shiftId} mode changed: ${shift.rows[0].attendant_mode} → ${attendant_mode}`);
        res.json({ success: true, shift: result.rows[0] });
    } catch (error) {
        logger.error('Error switching shift mode', error);
        res.status(500).json({ error: error.message });
    }
});

// ─────────────────────────────────────────────
//  CLOSE SHIFT — pull PTS transactions
// ─────────────────────────────────────────────

/**
 * @swagger
 * /api/shifts/{id}/close:
 *   post:
 *     summary: Close a shift and pull PTS transactions for all pumps
 *     description: |
 *       Closes the shift, queries PTS-2 for transactions on ALL pumps during
 *       the shift period (start_datetime to now), and stores them in shift_pts_sales.
 *     tags: [Shifts]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Shift closed and PTS transactions stored
 */
router.post('/:id/close', offlineAuthMiddleware, requireRole('admin', 'manager'), async (req, res) => {
    try {
        const shiftId = req.params.id;

        // Get the shift
        const shift = await db.query('SELECT * FROM shifts WHERE id = $1', [shiftId]);
        if (shift.rows.length === 0) return res.status(404).json({ error: 'Shift not found' });
        if (shift.rows[0].status !== 'open') {
            return res.status(400).json({ error: 'Shift is already closed' });
        }

        const shiftData = shift.rows[0];
        const endTime = new Date();

        // Close the shift in DB
        await db.query(
            `UPDATE shifts SET end_datetime = $1, status = 'closed', synced = FALSE WHERE id = $2`,
            [endTime, shiftId]
        );

        let totalTransactions = 0;

        // ── Query external PTS API for all pump transactions during the shift ──
        try {
            const axios = require('axios');

            const startDt = new Date(shiftData.start_datetime);
            const pad = (n) => String(n).padStart(2, '0');
            const formatDt = (d) =>
                `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;

            const apiUrl = `https://api.z360solutuons.uk/api/pts/reports/pump-transactions?pump=0&start=${formatDt(startDt)}&end=${formatDt(endTime)}`;
            logger.info(`📡 Shift close — querying external PTS API: ${apiUrl}`);

            const apiResponse = await axios.get(apiUrl, { timeout: 20000 });
            const responseData = apiResponse.data;
            const txnList = Array.isArray(responseData) ? responseData : (responseData.data || responseData.transactions || []);

            logger.info(`📡 Got ${txnList.length} transactions from external API`);

            // Store each transaction in pts_sales_records
            for (const txn of txnList) {
                await db.query(
                    `INSERT INTO pts_sales_records (
                        shift_id, date_time, date_time_start, pump, nozzle,
                        fuel_grade_id, fuel_grade_name, transaction_no, user_id_pts,
                        volume, amount, price, total_volume, total_amount,
                        tc_volume, flow_rate, is_offline, is_paid, tag
                    ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19)`,
                    [
                        shiftId,
                        txn.DateTime || null,
                        txn.DateTimeStart || null,
                        txn.Pump || 0,
                        txn.Nozzle || null,
                        txn.FuelGradeId || null,
                        txn.FuelGradeName || null,
                        txn.Transaction || null,
                        txn.UserId || null,
                        txn.Volume || 0,
                        txn.Amount || 0,
                        txn.Price || 0,
                        txn.TotalVolume || 0,
                        txn.TotalAmount || 0,
                        txn.TCVolume || 0,
                        txn.FlowRate || 0,
                        txn.IsOffline || false,
                        txn.IsPaid || false,
                        txn.Tag || ''
                    ]
                );
                totalTransactions++;
            }

            logger.info(`✅ Stored ${totalTransactions} PTS sales records for shift ${shiftId}`);
        } catch (ptsError) {
            logger.warn(`⚠️ PTS API query failed: ${ptsError.message} — shift still closed, no PTS records stored`);
        }

        // Return the closed shift
        const updated = await db.query('SELECT * FROM shifts WHERE id = $1', [shiftId]);

        res.json({
            success: true,
            message: `Shift closed. ${totalTransactions} PTS sales records stored.`,
            shift: updated.rows[0],
            pts_records_stored: totalTransactions,
        });
    } catch (error) {
        logger.error('Error closing shift', error);
        res.status(500).json({ error: error.message });
    }
});

// ─────────────────────────────────────────────
//  PTS SALES FOR A SHIFT
// ─────────────────────────────────────────────

/**
 * @swagger
 * /api/shifts/{id}/pts-sales:
 *   get:
 *     summary: Get PTS sales data for a shift
 *     tags: [Shifts]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *       - in: query
 *         name: pump_id
 *         schema: { type: integer }
 *         description: Filter by pump number
 *     responses:
 *       200:
 *         description: PTS sales for the shift
 */
router.get('/:id/pts-sales', async (req, res) => {
    try {
        const { pump_id } = req.query;

        // Get the shift to determine start_datetime
        const shiftResult = await db.query('SELECT * FROM shifts WHERE id = $1', [req.params.id]);
        if (shiftResult.rows.length === 0) {
            return res.status(404).json({ error: 'Shift not found' });
        }

        const shiftData = shiftResult.rows[0];
        const startDt = new Date(shiftData.start_datetime);
        // If shift is closed, use the shift's end_datetime; otherwise use current time
        const endDt = shiftData.end_datetime ? new Date(shiftData.end_datetime) : new Date();

        // Format dates for the external API (YYYY-MM-DDTHH:mm:ss)
        const formatDt = (d) => {
            const pad = (n) => String(n).padStart(2, '0');
            return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
        };

        const pumpParam = pump_id !== undefined ? parseInt(pump_id) : 0; // 0 = all pumps
        const apiUrl = `https://api.z360solutuons.uk/api/pts/reports/pump-transactions?pump=${pumpParam}&start=${formatDt(startDt)}&end=${formatDt(endDt)}`;

        logger.info(`📡 Querying external PTS API: ${apiUrl}`);

        const axios = require('axios');
        const apiResponse = await axios.get(apiUrl, { timeout: 15000 });
        const transactions = apiResponse.data;

        // Build pump totals from the API response
        const pumpTotalsMap = {};
        const txnList = Array.isArray(transactions) ? transactions : (transactions.transactions || transactions.data || []);

        for (const txn of txnList) {
            const pump = txn.Pump || txn.pump || 0;
            if (!pumpTotalsMap[pump]) {
                pumpTotalsMap[pump] = { pump, txn_count: 0, total_amount: 0, total_volume: 0 };
            }
            pumpTotalsMap[pump].txn_count++;
            pumpTotalsMap[pump].total_amount += parseFloat(txn.Amount || txn.amount || 0);
            pumpTotalsMap[pump].total_volume += parseFloat(txn.Volume || txn.volume || 0);
        }

        const pumpTotals = Object.values(pumpTotalsMap).sort((a, b) => a.pump - b.pump);

        res.json({
            success: true,
            source: 'external_api',
            api_url: apiUrl,
            shift_start: startDt.toISOString(),
            query_end: endDt.toISOString(),
            count: txnList.length,
            pump_totals: pumpTotals,
            transactions: txnList
        });
    } catch (error) {
        logger.error('Error fetching shift PTS sales from external API', error);
        res.status(500).json({
            error: error.message,
            hint: 'Failed to query external PTS API. Check network connectivity and API availability.'
        });
    }
});

// ─────────────────────────────────────────────
//  PTS SALES RECORDS (stored on shift close)
// ─────────────────────────────────────────────

/**
 * @swagger
 * /api/shifts/{id}/pts-sales-records:
 *   get:
 *     summary: Get stored PTS sales records for a closed shift
 *     description: |
 *       Returns the PTS transaction records that were fetched from the external API
 *       and stored in pts_sales_records when the shift was closed.
 *     tags: [Shifts]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *       - in: query
 *         name: pump
 *         schema: { type: integer }
 *         description: Filter by pump number
 *     responses:
 *       200:
 *         description: Stored PTS sales records
 */
router.get('/:id/pts-sales-records', async (req, res) => {
    try {
        const { pump } = req.query;

        // Verify shift exists
        const shiftResult = await db.query('SELECT id, status, start_datetime, end_datetime FROM shifts WHERE id = $1', [req.params.id]);
        if (shiftResult.rows.length === 0) {
            return res.status(404).json({ error: 'Shift not found' });
        }

        let query = `SELECT * FROM pts_sales_records WHERE shift_id = $1`;
        const params = [req.params.id];

        if (pump !== undefined) {
            query += ` AND pump = $2`;
            params.push(parseInt(pump));
        }

        query += ` ORDER BY date_time ASC`;

        const result = await db.query(query, params);

        // Build pump totals summary
        const pumpTotalsMap = {};
        for (const rec of result.rows) {
            const p = rec.pump;
            if (!pumpTotalsMap[p]) {
                pumpTotalsMap[p] = { pump: p, fuel_grade: rec.fuel_grade_name, txn_count: 0, total_volume: 0, total_amount: 0 };
            }
            pumpTotalsMap[p].txn_count++;
            pumpTotalsMap[p].total_volume += parseFloat(rec.volume) || 0;
            pumpTotalsMap[p].total_amount += parseFloat(rec.amount) || 0;
        }

        res.json({
            success: true,
            source: 'stored_records',
            shift: shiftResult.rows[0],
            count: result.rows.length,
            pump_totals: Object.values(pumpTotalsMap).sort((a, b) => a.pump - b.pump),
            records: result.rows,
        });
    } catch (error) {
        logger.error('Error fetching PTS sales records', error);
        res.status(500).json({ error: error.message });
    }
});

// ─────────────────────────────────────────────
//  CASH-UP (per pump reconciliation)
// ─────────────────────────────────────────────

/**
 * @swagger
 * /api/shifts/{id}/cashup:
 *   post:
 *     summary: Submit cash-up for a pump in this shift
 *     description: |
 *       Manager declares how the pump total breaks down into payment types.
 *       System auto-calculates declared_total and variance vs PTS total.
 *       If debtor_id is provided, debtor balance is updated.
 *     tags: [Shifts]
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
 *             required: [pump_id]
 *             properties:
 *               pump_id:
 *                 type: integer
 *               attendant_id:
 *                 type: string
 *                 format: uuid
 *               declared_card:
 *                 type: number
 *                 default: 0
 *               declared_mobile:
 *                 type: number
 *                 default: 0
 *               declared_debtor:
 *                 type: number
 *                 default: 0
 *               debtor_id:
 *                 type: string
 *                 format: uuid
 *                 description: Required when declared_debtor > 0
 *               declared_cash:
 *                 type: number
 *                 default: 0
 *     responses:
 *       201:
 *         description: Cash-up recorded
 */
router.post('/:id/cashup', offlineAuthMiddleware, requireRole('admin', 'manager'), async (req, res) => {
    try {
        const shiftId = req.params.id;
        const {
            pump_id,
            attendant_id,
            declared_card = 0,
            declared_mobile = 0,
            declared_debtor = 0,
            debtor_id,
            declared_cash = 0
        } = req.body;

        if (pump_id === undefined) {
            return res.status(400).json({ error: 'pump_id is required' });
        }

        // Calculate PTS total for this pump in this shift
        const ptsTotalResult = await db.query(
            `SELECT COALESCE(SUM(amount), 0) as pts_total
             FROM pts_sales_records WHERE shift_id = $1 AND pump = $2`,
            [shiftId, pump_id]
        );
        const ptsTotal = parseFloat(ptsTotalResult.rows[0].pts_total);

        // Calculate declared total and variance
        const declaredTotal = parseFloat(declared_card) + parseFloat(declared_mobile) +
            parseFloat(declared_debtor) + parseFloat(declared_cash);
        const variance = declaredTotal - ptsTotal;

        // Insert cash-up record
        const result = await db.query(
            `INSERT INTO shift_cashup (
        shift_id, pump_id, attendant_id, pts_total,
        declared_card, declared_mobile, declared_debtor, debtor_id,
        declared_cash, declared_total, variance, created_at
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,now())
      RETURNING *`,
            [
                shiftId, pump_id, attendant_id || null, ptsTotal,
                declared_card, declared_mobile, declared_debtor, debtor_id || null,
                declared_cash, declaredTotal, variance
            ]
        );

        // Update debtor balance if debtor is specified
        if (debtor_id && parseFloat(declared_debtor) > 0) {
            try {
                await db.query(
                    `UPDATE debtors SET current_balance = current_balance + $1 WHERE id = $2`,
                    [declared_debtor, debtor_id]
                );
                logger.info(`✅ Updated debtor ${debtor_id} balance +${declared_debtor}`);
            } catch (debtorErr) {
                logger.warn(`⚠️ Debtor balance update failed: ${debtorErr.message}`);
            }
        }

        logger.info(`✅ Cash-up recorded: shift=${shiftId} pump=${pump_id} variance=${variance}`);

        // Auto-reconcile: check if all assigned pumps have been cashed up
        let reconciled = false;
        try {
            const assignedPumps = await db.query(
                'SELECT DISTINCT pump_id FROM shift_attendants WHERE shift_id = $1', [shiftId]
            );
            const cashedUpPumps = await db.query(
                'SELECT DISTINCT pump_id FROM shift_cashup WHERE shift_id = $1', [shiftId]
            );
            const assignedSet = new Set(assignedPumps.rows.map(r => r.pump_id));
            const cashedUpSet = new Set(cashedUpPumps.rows.map(r => r.pump_id));
            if (assignedSet.size > 0 && [...assignedSet].every(p => cashedUpSet.has(p))) {
                await db.query(
                    "UPDATE shifts SET status = 'reconciled' WHERE id = $1 AND status = 'closed'", [shiftId]
                );
                reconciled = true;
                logger.info(`✅ Shift ${shiftId} auto-reconciled — all pumps cashed up`);
            }
        } catch (reconErr) {
            logger.warn(`⚠️ Auto-reconcile check failed: ${reconErr.message}`);
        }

        res.status(201).json({
            success: true,
            cashup: result.rows[0],
            reconciled,
            summary: {
                pts_total: ptsTotal,
                declared_total: declaredTotal,
                variance: variance,
                status: variance === 0 ? 'matched' : (variance > 0 ? 'over' : 'short')
            }
        });
    } catch (error) {
        logger.error('Error submitting cash-up', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * @swagger
 * /api/shifts/{id}/cashup:
 *   get:
 *     summary: Get all cash-up records for a shift
 *     tags: [Shifts]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Cash-up records for the shift
 */
router.get('/:id/cashup', async (req, res) => {
    try {
        const cashups = await db.query(
            `SELECT c.*, a.full_name as attendant_name, d.company_name as debtor_name
       FROM shift_cashup c
       LEFT JOIN attendants a ON c.attendant_id = a.id
       LEFT JOIN debtors d ON c.debtor_id = d.id
       WHERE c.shift_id = $1
       ORDER BY c.pump_id`, [req.params.id]
        );

        // Grand totals
        const totals = await db.query(
            `SELECT COALESCE(SUM(pts_total), 0) as total_pts,
              COALESCE(SUM(declared_card), 0) as total_card,
              COALESCE(SUM(declared_mobile), 0) as total_mobile,
              COALESCE(SUM(declared_debtor), 0) as total_debtor,
              COALESCE(SUM(declared_cash), 0) as total_cash,
              COALESCE(SUM(declared_total), 0) as total_declared,
              COALESCE(SUM(variance), 0) as total_variance
       FROM shift_cashup WHERE shift_id = $1`, [req.params.id]
        );

        res.json({
            success: true,
            count: cashups.rows.length,
            cashups: cashups.rows,
            totals: totals.rows[0]
        });
    } catch (error) {
        logger.error('Error fetching cash-ups', error);
        res.status(500).json({ error: error.message });
    }
});

// ─────────────────────────────────────────────
//  SHIFT SUMMARY (full reconciliation)
// ─────────────────────────────────────────────

/**
 * @swagger
 * /api/shifts/{id}/summary:
 *   get:
 *     summary: Get full shift summary (PTS totals + cash-up totals)
 *     tags: [Shifts]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Full shift reconciliation summary
 */
router.get('/:id/summary', async (req, res) => {
    try {
        const shiftId = req.params.id;

        const shift = await db.query('SELECT * FROM shifts WHERE id = $1', [shiftId]);
        if (shift.rows.length === 0) return res.status(404).json({ error: 'Shift not found' });

        // PTS totals per pump
        const ptsTotals = await db.query(
            `SELECT pump, COUNT(*) as txn_count,
              COALESCE(SUM(amount), 0) as total_amount,
              COALESCE(SUM(volume), 0) as total_volume
       FROM pts_sales_records WHERE shift_id = $1
       GROUP BY pump ORDER BY pump`, [shiftId]
        );

        // Cash-up per pump
        const cashups = await db.query(
            `SELECT c.pump_id, c.pts_total, c.declared_card, c.declared_mobile,
              c.declared_debtor, c.declared_cash, c.declared_total, c.variance,
              a.full_name as attendant_name
       FROM shift_cashup c
       LEFT JOIN attendants a ON c.attendant_id = a.id
       WHERE c.shift_id = $1 ORDER BY c.pump_id`, [shiftId]
        );

        // Grand totals
        const grandTotals = await db.query(
            `SELECT COALESCE(SUM(pts_total), 0) as pts_grand_total,
              COALESCE(SUM(declared_total), 0) as declared_grand_total,
              COALESCE(SUM(variance), 0) as grand_variance,
              COALESCE(SUM(declared_card), 0) as total_card,
              COALESCE(SUM(declared_mobile), 0) as total_mobile,
              COALESCE(SUM(declared_debtor), 0) as total_debtor,
              COALESCE(SUM(declared_cash), 0) as total_cash
       FROM shift_cashup WHERE shift_id = $1`, [shiftId]
        );

        // Attendant assignments
        const attendants = await db.query(
            `SELECT sa.pump_id, a.full_name, a.phone
       FROM shift_attendants sa
       LEFT JOIN attendants a ON sa.attendant_id = a.id
       WHERE sa.shift_id = $1 ORDER BY sa.pump_id`, [shiftId]
        );

        res.json({
            success: true,
            shift: shift.rows[0],
            attendants: attendants.rows,
            pts_totals_per_pump: ptsTotals.rows,
            cashup_per_pump: cashups.rows,
            grand_totals: grandTotals.rows[0]
        });
    } catch (error) {
        logger.error('Error fetching shift summary', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * @swagger
 * /api/shifts/{id}/enhanced-cashup:
 *   post:
 *     summary: Enhanced cash-up with detailed debtor transaction tracking
 *     tags: [Shifts]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *         description: Shift ID
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [pump_id, declared_card, declared_mobile, declared_cash]
 *             properties:
 *               pump_id:
 *                 type: integer
 *               attendant_id:
 *                 type: string
 *                 format: uuid
 *               declared_card:
 *                 type: number
 *                 default: 0
 *               declared_mobile:
 *                 type: number
 *                 default: 0
 *               declared_cash:
 *                 type: number
 *                 default: 0
 *               debtor_transactions:
 *                 type: array
 *                 description: Array of specific debtor transactions for this cashup
 *                 items:
 *                   type: object
 *                   required: [debtor_id, pts_transaction_id, driver_name, amount, volume, fuel_grade, price_per_litre, transaction_time]
 *                   properties:
 *                     debtor_id:
 *                       type: string
 *                       format: uuid
 *                     pts_transaction_id:
 *                       type: string
 *                     driver_name:
 *                       type: string
 *                     vehicle_id:
 *                       type: string
 *                       format: uuid
 *                     amount:
 *                       type: number
 *                     volume:
 *                       type: number
 *                     fuel_grade:
 *                       type: string
 *                     price_per_litre:
 *                       type: number
 *                     transaction_time:
 *                       type: string
 *                       format: date-time
 *     responses:
 *       201:
 *         description: Enhanced cash-up recorded with debtor transactions
 */
router.post('/:id/enhanced-cashup', offlineAuthMiddleware, requireRole('admin', 'manager'), async (req, res) => {
    try {
        const shiftId = req.params.id;
        const {
            pump_id,
            attendant_id,
            declared_card = 0,
            declared_mobile = 0,
            declared_cash = 0,
            debtor_transactions = []
        } = req.body;

        if (pump_id === undefined) {
            return res.status(400).json({ error: 'pump_id is required' });
        }

        // Calculate PTS total for this pump in this shift
        const ptsTotalResult = await db.query(
            `SELECT COALESCE(SUM(amount), 0) as pts_total
             FROM pts_sales_records WHERE shift_id = $1 AND pump = $2`,
            [shiftId, pump_id]
        );
        const ptsTotal = parseFloat(ptsTotalResult.rows[0].pts_total);

        // Calculate declared debtor total from individual transactions
        const declared_debtor = debtor_transactions.reduce((sum, tx) => sum + parseFloat(tx.amount), 0);
        
        // Calculate declared total and variance
        const declaredTotal = parseFloat(declared_card) + parseFloat(declared_mobile) +
            declared_debtor + parseFloat(declared_cash);
        const variance = declaredTotal - ptsTotal;

        // Start transaction for atomicity
        await db.query('BEGIN');

        try {
            // Insert cash-up record
            const cashupResult = await db.query(
                `INSERT INTO shift_cashup (
                    shift_id, pump_id, attendant_id, pts_total,
                    declared_card, declared_mobile, declared_debtor, debtor_id,
                    declared_cash, declared_total, variance, created_at
                ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,now())
                RETURNING *`,
                [
                    shiftId, pump_id, attendant_id || null, ptsTotal,
                    declared_card, declared_mobile, declared_debtor, null, // debtor_id is null for individual transactions
                    declared_cash, declaredTotal, variance
                ]
            );

            // Process each debtor transaction
            const createdDebtorTransactions = [];
            for (const dtx of debtor_transactions) {
                // Validate required fields
                const required = ['debtor_id', 'pts_transaction_id', 'driver_name', 'amount', 'volume', 'fuel_grade', 'price_per_litre', 'transaction_time'];
                const missing = required.filter(field => !dtx[field]);
                if (missing.length > 0) {
                    throw new Error(`Debtor transaction missing fields: ${missing.join(', ')}`);
                }

                // Check if PTS transaction already assigned
                const existing = await db.query(
                    'SELECT id FROM debtor_transactions WHERE pts_transaction_id = $1',
                    [dtx.pts_transaction_id]
                );
                if (existing.rows.length > 0) {
                    throw new Error(`PTS transaction ${dtx.pts_transaction_id} already assigned to a debtor`);
                }

                // Create debtor transaction
                // Handle vehicle_id: if it's a UUID, look up registration from debtor_vehicles
                const isUUID = dtx.vehicle_id && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(dtx.vehicle_id);
                const vehicleId = isUUID ? dtx.vehicle_id : null;
                
                const debtorTxResult = await db.query(
                    `INSERT INTO debtor_transactions (
                        shift_id, debtor_id, pts_transaction_id, driver_name,
                        vehicle_id, pump_id, amount, volume, fuel_grade,
                        price_per_litre, transaction_time
                    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
                    RETURNING *`,
                    [
                        shiftId, dtx.debtor_id, dtx.pts_transaction_id, dtx.driver_name,
                        vehicleId, pump_id, dtx.amount, dtx.volume, dtx.fuel_grade,
                        dtx.price_per_litre, dtx.transaction_time
                    ]
                );

                // Update debtor balance
                await db.query(
                    'UPDATE debtors SET current_balance = current_balance + $1 WHERE id = $2',
                    [dtx.amount, dtx.debtor_id]
                );

                createdDebtorTransactions.push(debtorTxResult.rows[0]);
                logger.info(`✅ Created debtor transaction: ${dtx.pts_transaction_id} for debtor ${dtx.debtor_id} (R${dtx.amount})`);
            }

            // Commit transaction
            await db.query('COMMIT');

            logger.info(`✅ Enhanced cash-up recorded: shift=${shiftId} pump=${pump_id} variance=${variance} debtors=${debtor_transactions.length}`);

            // Auto-reconcile: check if all assigned pumps have been cashed up
            let reconciled = false;
            try {
                const assignedPumps = await db.query(
                    'SELECT DISTINCT pump_id FROM shift_attendants WHERE shift_id = $1', [shiftId]
                );
                const cashedUpPumps = await db.query(
                    'SELECT DISTINCT pump_id FROM shift_cashup WHERE shift_id = $1', [shiftId]
                );
                const assignedSet = new Set(assignedPumps.rows.map(r => r.pump_id));
                const cashedUpSet = new Set(cashedUpPumps.rows.map(r => r.pump_id));
                if (assignedSet.size > 0 && [...assignedSet].every(p => cashedUpSet.has(p))) {
                    await db.query(
                        "UPDATE shifts SET status = 'reconciled' WHERE id = $1 AND status = 'closed'", [shiftId]
                    );
                    reconciled = true;
                    logger.info(`✅ Shift ${shiftId} auto-reconciled — all pumps cashed up`);
                }
            } catch (reconErr) {
                logger.warn(`⚠️ Auto-reconcile check failed: ${reconErr.message}`);
            }

            res.status(201).json({
                success: true,
                cashup: cashupResult.rows[0],
                reconciled,
                debtor_transactions: createdDebtorTransactions,
                summary: {
                    pts_total: ptsTotal,
                    declared_total: declaredTotal,
                    declared_debtor_total: declared_debtor,
                    debtor_transaction_count: debtor_transactions.length,
                    variance: variance,
                    status: variance === 0 ? 'matched' : (variance > 0 ? 'over' : 'short')
                }
            });

        } catch (error) {
            // Rollback on error
            await db.query('ROLLBACK');
            throw error;
        }

    } catch (error) {
        logger.error('Error submitting enhanced cash-up', error);
        res.status(500).json({ error: error.message });
    }
});

// ─────────────────────────────────────────────
//  UPDATE CASHUP (correct a declaration)
// ─────────────────────────────────────────────

/**
 * @swagger
 * /api/shifts/{id}/cashup/{pumpId}:
 *   put:
 *     summary: Update cash-up declaration for a pump
 *     description: |
 *       Allows a manager to correct the declared amounts for a specific pump.
 *       Recalculates declared_total and variance. If debtor amount changed, adjusts debtor balance.
 *     tags: [Shifts]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *         description: Shift ID
 *       - in: path
 *         name: pumpId
 *         required: true
 *         schema: { type: integer }
 *         description: PTS pump number
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               attendant_id:
 *                 type: string
 *                 format: uuid
 *               declared_card:
 *                 type: number
 *               declared_mobile:
 *                 type: number
 *               declared_debtor:
 *                 type: number
 *               debtor_id:
 *                 type: string
 *                 format: uuid
 *               declared_cash:
 *                 type: number
 *     responses:
 *       200:
 *         description: Cash-up updated
 *       404:
 *         description: No cashup record found for this shift/pump
 */
router.put('/:id/cashup/:pumpId', offlineAuthMiddleware, requireRole('admin', 'manager'), async (req, res) => {
    try {
        const { id: shiftId, pumpId } = req.params;
        const {
            attendant_id,
            declared_card,
            declared_mobile,
            declared_debtor,
            debtor_id,
            declared_cash
        } = req.body;

        // Get existing cashup record
        const existing = await db.query(
            'SELECT * FROM shift_cashup WHERE shift_id = $1 AND pump_id = $2',
            [shiftId, parseInt(pumpId)]
        );
        if (existing.rows.length === 0) {
            return res.status(404).json({ error: 'No cashup record found for this shift/pump' });
        }

        const old = existing.rows[0];

        // Use new values or fall back to existing
        const newCard = declared_card !== undefined ? parseFloat(declared_card) : parseFloat(old.declared_card);
        const newMobile = declared_mobile !== undefined ? parseFloat(declared_mobile) : parseFloat(old.declared_mobile);
        const newDebtor = declared_debtor !== undefined ? parseFloat(declared_debtor) : parseFloat(old.declared_debtor);
        const newCash = declared_cash !== undefined ? parseFloat(declared_cash) : parseFloat(old.declared_cash);
        const newAttendant = attendant_id !== undefined ? attendant_id : old.attendant_id;
        const newDebtorId = debtor_id !== undefined ? debtor_id : old.debtor_id;

        // Recalculate PTS total (in case records were corrected)
        const ptsTotalResult = await db.query(
            `SELECT COALESCE(SUM(amount), 0) as pts_total
             FROM pts_sales_records WHERE shift_id = $1 AND pump = $2`,
            [shiftId, parseInt(pumpId)]
        );
        const ptsTotal = parseFloat(ptsTotalResult.rows[0].pts_total);
        const declaredTotal = newCard + newMobile + newDebtor + newCash;
        const variance = declaredTotal - ptsTotal;

        // Adjust debtor balance if debtor amount changed
        const oldDebtorAmount = parseFloat(old.declared_debtor) || 0;
        const debtorDiff = newDebtor - oldDebtorAmount;
        if (debtorDiff !== 0 && (newDebtorId || old.debtor_id)) {
            const targetDebtorId = newDebtorId || old.debtor_id;
            try {
                await db.query(
                    'UPDATE debtors SET current_balance = current_balance + $1 WHERE id = $2',
                    [debtorDiff, targetDebtorId]
                );
                logger.info(`✅ Adjusted debtor ${targetDebtorId} balance by ${debtorDiff}`);
            } catch (debtorErr) {
                logger.warn(`⚠️ Debtor balance adjustment failed: ${debtorErr.message}`);
            }
        }

        // Update the cashup record
        const result = await db.query(
            `UPDATE shift_cashup SET
                attendant_id = $1, pts_total = $2,
                declared_card = $3, declared_mobile = $4,
                declared_debtor = $5, debtor_id = $6,
                declared_cash = $7, declared_total = $8, variance = $9
             WHERE shift_id = $10 AND pump_id = $11
             RETURNING *`,
            [
                newAttendant, ptsTotal,
                newCard, newMobile,
                newDebtor, newDebtorId || null,
                newCash, declaredTotal, variance,
                shiftId, parseInt(pumpId)
            ]
        );

        logger.info(`✅ Cash-up updated: shift=${shiftId} pump=${pumpId} variance=${variance}`);

        res.json({
            success: true,
            cashup: result.rows[0],
            summary: {
                pts_total: ptsTotal,
                declared_total: declaredTotal,
                variance: variance,
                status: variance === 0 ? 'matched' : (variance > 0 ? 'over' : 'short')
            }
        });
    } catch (error) {
        logger.error('Error updating cash-up', error);
        res.status(500).json({ error: error.message });
    }
});

module.exports = router;
