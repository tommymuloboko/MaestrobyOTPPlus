const express = require('express');
const logger = require('../utils/logger')('RfidShiftsRoutes');
const db = require('../utils/db');
const PTSClient = require('../lib/pts-client');

const router = express.Router();

// ─────────────────────────────────────────────
//  PTS Client Helper (same as reports.routes)
// ─────────────────────────────────────────────

function createPTSClient() {
  return new PTSClient({
    url:      (process.env.PTS_URL      || 'http://192.168.1.90/jsonPTS').trim(),
    username: (process.env.PTS_USERNAME || 'admin').trim(),
    password: (process.env.PTS_PASSWORD || 'admin').trim(),
    timeout:  parseInt(process.env.PTS_TIMEOUT) || 30000,
  });
}

async function fetchPTSTransactions(from, to) {
  const pts = createPTSClient();
  const request = {
    Protocol: 'jsonPTS',
    Packets: [{
      Id: 1,
      Type: 'ReportGetPumpTransactions',
      Data: { Pump: 0, DateTimeStart: from, DateTimeEnd: to }
    }]
  };

  const raw = await pts.sendRequest(JSON.stringify(request));
  let jsonStr = typeof raw === 'string' ? raw : JSON.stringify(raw);
  jsonStr = jsonStr.replace(/\[,/g, '[');
  const response = typeof raw === 'string' ? JSON.parse(jsonStr) : raw;

  const packet = response.Packets && response.Packets.find(p => p.Id === 1);
  if (!packet || packet.Error) {
    const msg = packet ? packet.Message : 'No response packet';
    throw new Error('PTS error: ' + msg);
  }

  return Array.isArray(packet.Data) ? packet.Data.filter(Boolean) : [];
}

async function loadTagMap() {
  const result = await db.query(`
    SELECT t.tag_number, t.attendant_id, a.full_name AS attendant_name
    FROM rfid_tags t
    LEFT JOIN attendants a ON t.attendant_id = a.id
    WHERE t.is_active = true AND t.attendant_id IS NOT NULL
  `);
  const map = {};
  for (const row of result.rows) {
    map[row.tag_number.toUpperCase()] = {
      attendant_id: row.attendant_id,
      attendant_name: row.attendant_name,
      tag_number: row.tag_number,
    };
  }
  return map;
}

function enrichTransactions(transactions, tagMap) {
  return transactions.map(tx => {
    const tag = (tx.Tag || '').toUpperCase().trim();
    const match = tag ? tagMap[tag] : null;
    return {
      date_time:       tx.DateTime,
      date_time_start: tx.DateTimeStart,
      pump:            tx.Pump,
      nozzle:          tx.Nozzle,
      fuel_grade_id:   tx.FuelGradeId,
      fuel_grade:      tx.FuelGradeName,
      transaction_no:  tx.Transaction,
      volume:          tx.Volume,
      amount:          tx.Amount,
      price:           tx.Price,
      total_volume:    tx.TotalVolume,
      total_amount:    tx.TotalAmount,
      tc_volume:       tx.TCVolume,
      tag:             tag || null,
      attendant_id:    match ? match.attendant_id : null,
      attendant_name:  match ? match.attendant_name : null,
    };
  });
}

// ─────────────────────────────────────────────
//  Ensure tables exist
// ─────────────────────────────────────────────

async function ensureTables() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS rfid_shifts (
      id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      company_id    UUID NOT NULL,
      station_id    UUID NOT NULL,
      start_datetime TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      end_datetime   TIMESTAMPTZ,
      status        TEXT NOT NULL DEFAULT 'open'
                      CHECK (status IN ('open','closed','reconciled')),
      created_by    UUID,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS rfid_shift_cashup (
      id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      shift_id      UUID NOT NULL REFERENCES rfid_shifts(id) ON DELETE CASCADE,
      attendant_id  UUID,
      tag_number    TEXT,
      attendant_name TEXT,
      pts_total     NUMERIC NOT NULL DEFAULT 0,
      pts_volume    NUMERIC NOT NULL DEFAULT 0,
      pts_count     INTEGER NOT NULL DEFAULT 0,
      declared_cash   NUMERIC NOT NULL DEFAULT 0,
      declared_card   NUMERIC NOT NULL DEFAULT 0,
      declared_mobile NUMERIC NOT NULL DEFAULT 0,
      declared_debtor NUMERIC NOT NULL DEFAULT 0,
      declared_total  NUMERIC NOT NULL DEFAULT 0,
      variance        NUMERIC NOT NULL DEFAULT 0,
      notes           TEXT,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE(shift_id, attendant_id)
    );
  `);
}

// Run on module load
ensureTables().catch(err => logger.error('Failed to create rfid_shift tables', err));

// ─────────────────────────────────────────────
//  ROUTES
// ─────────────────────────────────────────────

/**
 * GET /  — list rfid shifts (newest first)
 * Optional query: ?station_id=&status=
 */
router.get('/', async (req, res) => {
  try {
    const { station_id, status } = req.query;
    let sql = 'SELECT * FROM rfid_shifts WHERE 1=1';
    const params = [];

    if (station_id) {
      params.push(station_id);
      sql += ` AND station_id = $${params.length}`;
    }
    if (status) {
      params.push(status);
      sql += ` AND status = $${params.length}`;
    }
    sql += ' ORDER BY created_at DESC';

    const result = await db.query(sql, params);
    res.json(result.rows);
  } catch (err) {
    logger.error('GET / error', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /:id — single shift
 */
router.get('/:id', async (req, res) => {
  try {
    const result = await db.query('SELECT * FROM rfid_shifts WHERE id = $1', [req.params.id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Shift not found' });
    res.json(result.rows[0]);
  } catch (err) {
    logger.error('GET /:id error', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST / — open a new shift (just company_id + station_id)
 */
router.post('/', async (req, res) => {
  try {
    const { company_id, station_id } = req.body;
    if (!company_id || !station_id) {
      return res.status(400).json({ error: 'company_id and station_id required' });
    }

    // Check for existing open shift at this station
    const existing = await db.query(
      "SELECT id FROM rfid_shifts WHERE station_id = $1 AND status = 'open'",
      [station_id]
    );
    if (existing.rows.length > 0) {
      return res.status(409).json({
        error: 'A shift is already open at this station',
        shift_id: existing.rows[0].id,
      });
    }

    const userId = req.user ? req.user.id : null;
    const result = await db.query(
      `INSERT INTO rfid_shifts (company_id, station_id, created_by)
       VALUES ($1, $2, $3) RETURNING *`,
      [company_id, station_id, userId]
    );

    logger.info(`Shift opened: ${result.rows[0].id}`);
    res.status(201).json(result.rows[0]);
  } catch (err) {
    logger.error('POST / error', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /:id/close — end the shift (sets end_datetime, status=closed)
 */
router.post('/:id/close', async (req, res) => {
  try {
    const shift = await db.query('SELECT * FROM rfid_shifts WHERE id = $1', [req.params.id]);
    if (shift.rows.length === 0) return res.status(404).json({ error: 'Shift not found' });
    if (shift.rows[0].status !== 'open') {
      return res.status(400).json({ error: 'Shift is not open' });
    }

    const result = await db.query(
      `UPDATE rfid_shifts SET end_datetime = NOW(), status = 'closed'
       WHERE id = $1 RETURNING *`,
      [req.params.id]
    );

    logger.info(`Shift closed: ${req.params.id}`);
    res.json(result.rows[0]);
  } catch (err) {
    logger.error('POST /:id/close error', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /:id/transactions — get PTS transactions for this shift's time window,
 * enriched with RFID attendant info. Returns grouped by attendant + raw list.
 */
router.get('/:id/transactions', async (req, res) => {
  try {
    const shift = await db.query('SELECT * FROM rfid_shifts WHERE id = $1', [req.params.id]);
    if (shift.rows.length === 0) return res.status(404).json({ error: 'Shift not found' });

    const s = shift.rows[0];
    const from = s.start_datetime;
    const to = s.end_datetime || new Date().toISOString();

    // Format for PTS: "YYYY-MM-DD HH:mm:ss"
    const fmtPTS = (d) => {
      const dt = new Date(d);
      const Y = dt.getFullYear();
      const M = String(dt.getMonth() + 1).padStart(2, '0');
      const D = String(dt.getDate()).padStart(2, '0');
      const h = String(dt.getHours()).padStart(2, '0');
      const m = String(dt.getMinutes()).padStart(2, '0');
      const sec = String(dt.getSeconds()).padStart(2, '0');
      return `${Y}-${M}-${D}T${h}:${m}:${sec}`;
    };

    const rawTx = await fetchPTSTransactions(fmtPTS(from), fmtPTS(to));
    const tagMap = await loadTagMap();
    const transactions = enrichTransactions(rawTx, tagMap);

    // Group by attendant
    const grouped = {};
    for (const tx of transactions) {
      const key = tx.attendant_id || '__untagged__';
      if (!grouped[key]) {
        grouped[key] = {
          attendant_id: tx.attendant_id,
          attendant_name: tx.attendant_name,
          tag: tx.tag,
          transactions: [],
          total_amount: 0,
          total_volume: 0,
          count: 0,
        };
      }
      const g = grouped[key];
      g.transactions.push(tx);
      g.total_amount += Number(tx.amount) || 0;
      g.total_volume += Number(tx.volume) || 0;
      g.count += 1;
    }

    const attendants = Object.values(grouped).sort((a, b) => {
      // Put untagged last
      if (!a.attendant_id) return 1;
      if (!b.attendant_id) return -1;
      return b.total_amount - a.total_amount;
    });

    res.json({
      shift_id: s.id,
      shift_status: s.status,
      from: s.start_datetime,
      to: s.end_datetime,
      transaction_count: transactions.length,
      attendants,
      transactions,
    });
  } catch (err) {
    logger.error('GET /:id/transactions error', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /:id/cashup — submit cashup for one attendant
 * Body: { attendant_id, tag_number, attendant_name, pts_total, pts_volume, pts_count,
 *         declared_cash, declared_card, declared_mobile, declared_debtor, notes }
 */
router.post('/:id/cashup', async (req, res) => {
  try {
    const shift = await db.query('SELECT * FROM rfid_shifts WHERE id = $1', [req.params.id]);
    if (shift.rows.length === 0) return res.status(404).json({ error: 'Shift not found' });
    if (shift.rows[0].status === 'reconciled') {
      return res.status(400).json({ error: 'Shift already reconciled' });
    }

    const {
      attendant_id, tag_number, attendant_name,
      pts_total, pts_volume, pts_count,
      declared_cash = 0, declared_card = 0, declared_mobile = 0, declared_debtor = 0,
      notes,
    } = req.body;

    const declared_total = Number(declared_cash) + Number(declared_card) + Number(declared_mobile) + Number(declared_debtor);
    const variance = declared_total - Number(pts_total);

    const result = await db.query(`
      INSERT INTO rfid_shift_cashup
        (shift_id, attendant_id, tag_number, attendant_name,
         pts_total, pts_volume, pts_count,
         declared_cash, declared_card, declared_mobile, declared_debtor,
         declared_total, variance, notes)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
      ON CONFLICT (shift_id, attendant_id)
      DO UPDATE SET
        tag_number = EXCLUDED.tag_number,
        attendant_name = EXCLUDED.attendant_name,
        pts_total = EXCLUDED.pts_total,
        pts_volume = EXCLUDED.pts_volume,
        pts_count = EXCLUDED.pts_count,
        declared_cash = EXCLUDED.declared_cash,
        declared_card = EXCLUDED.declared_card,
        declared_mobile = EXCLUDED.declared_mobile,
        declared_debtor = EXCLUDED.declared_debtor,
        declared_total = EXCLUDED.declared_total,
        variance = EXCLUDED.variance,
        notes = EXCLUDED.notes
      RETURNING *
    `, [
      req.params.id, attendant_id, tag_number, attendant_name,
      pts_total || 0, pts_volume || 0, pts_count || 0,
      declared_cash, declared_card, declared_mobile, declared_debtor,
      declared_total, variance, notes,
    ]);

    // Check if all attendants cashed up → auto-reconcile
    await checkAutoReconcile(req.params.id);

    logger.info(`Cashup saved for shift ${req.params.id}, attendant ${attendant_name || attendant_id}`);
    res.json(result.rows[0]);
  } catch (err) {
    logger.error('POST /:id/cashup error', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /:id/cashups — get all cashup records for a shift
 */
router.get('/:id/cashups', async (req, res) => {
  try {
    const result = await db.query(
      'SELECT * FROM rfid_shift_cashup WHERE shift_id = $1 ORDER BY created_at',
      [req.params.id]
    );
    res.json(result.rows);
  } catch (err) {
    logger.error('GET /:id/cashups error', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /:id/summary — full shift summary (PTS totals, cashup totals, variance)
 */
router.get('/:id/summary', async (req, res) => {
  try {
    const shift = await db.query('SELECT * FROM rfid_shifts WHERE id = $1', [req.params.id]);
    if (shift.rows.length === 0) return res.status(404).json({ error: 'Shift not found' });

    const cashups = await db.query(
      'SELECT * FROM rfid_shift_cashup WHERE shift_id = $1 ORDER BY created_at',
      [req.params.id]
    );

    const totalPts = cashups.rows.reduce((s, c) => s + Number(c.pts_total), 0);
    const totalDeclared = cashups.rows.reduce((s, c) => s + Number(c.declared_total), 0);
    const totalVariance = cashups.rows.reduce((s, c) => s + Number(c.variance), 0);
    const totalCash = cashups.rows.reduce((s, c) => s + Number(c.declared_cash), 0);
    const totalCard = cashups.rows.reduce((s, c) => s + Number(c.declared_card), 0);
    const totalMobile = cashups.rows.reduce((s, c) => s + Number(c.declared_mobile), 0);
    const totalDebtor = cashups.rows.reduce((s, c) => s + Number(c.declared_debtor), 0);

    res.json({
      shift: shift.rows[0],
      cashups: cashups.rows,
      totals: {
        pts_total: totalPts,
        declared_total: totalDeclared,
        variance: totalVariance,
        declared_cash: totalCash,
        declared_card: totalCard,
        declared_mobile: totalMobile,
        declared_debtor: totalDebtor,
        attendants_cashed_up: cashups.rows.length,
      },
    });
  } catch (err) {
    logger.error('GET /:id/summary error', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * Auto-reconcile: when all attendants who had transactions have been cashed up
 */
async function checkAutoReconcile(shiftId) {
  try {
    const shift = await db.query('SELECT * FROM rfid_shifts WHERE id = $1', [shiftId]);
    if (!shift.rows.length || shift.rows[0].status !== 'closed') return;

    // Get PTS transactions for the shift window
    const s = shift.rows[0];
    const from = s.start_datetime;
    const to = s.end_datetime || new Date().toISOString();

    const fmtPTS = (d) => {
      const dt = new Date(d);
      const Y = dt.getFullYear();
      const M = String(dt.getMonth() + 1).padStart(2, '0');
      const D = String(dt.getDate()).padStart(2, '0');
      const h = String(dt.getHours()).padStart(2, '0');
      const m = String(dt.getMinutes()).padStart(2, '0');
      const sec = String(dt.getSeconds()).padStart(2, '0');
      return `${Y}-${M}-${D}T${h}:${m}:${sec}`;
    };

    const rawTx = await fetchPTSTransactions(fmtPTS(from), fmtPTS(to));
    const tagMap = await loadTagMap();
    const transactions = enrichTransactions(rawTx, tagMap);

    // Get unique attendant IDs (including null for untagged)
    const attendantIds = new Set(transactions.map(tx => tx.attendant_id || null));

    // Get cashed-up attendant IDs
    const cashups = await db.query(
      'SELECT attendant_id FROM rfid_shift_cashup WHERE shift_id = $1',
      [shiftId]
    );
    const cashedUp = new Set(cashups.rows.map(c => c.attendant_id));

    // Check if all are cashed up
    const allDone = [...attendantIds].every(id => cashedUp.has(id));
    if (allDone && attendantIds.size > 0) {
      await db.query(
        "UPDATE rfid_shifts SET status = 'reconciled' WHERE id = $1",
        [shiftId]
      );
      logger.info(`Shift ${shiftId} auto-reconciled`);
    }
  } catch (err) {
    logger.warn('Auto-reconcile check failed', err);
  }
}

module.exports = router;
