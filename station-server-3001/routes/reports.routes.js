const express = require('express');
const logger = require('../utils/logger')('ReportsRoutes');
const db = require('../utils/db');
const PTSClient = require('../lib/pts-client');

const router = express.Router();

// ─────────────────────────────────────────────
//  PTS Client Helper
// ─────────────────────────────────────────────

function createPTSClient() {
  return new PTSClient({
    url:      (process.env.PTS_URL      || 'http://192.168.1.90/jsonPTS').trim(),
    username: (process.env.PTS_USERNAME || 'admin').trim(),
    password: (process.env.PTS_PASSWORD || 'admin').trim(),
    timeout:  parseInt(process.env.PTS_TIMEOUT) || 30000,
  });
}

/**
 * Fetch transactions from PTS for the given date range.
 * Returns an array of raw PTS transaction objects.
 */
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
  // PTS sometimes returns a string with malformed JSON (leading comma in array)
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

/**
 * Load the tag → attendant map from rfid_tags + attendants (local DB).
 * Returns { 'E25ACEA0': { attendant_id, attendant_name, tag_number }, ... }
 */
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

/**
 * Enrich PTS transactions with attendant info from tag map.
 */
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
      user_id_pts:     tx.UserId,
      volume:          tx.Volume,
      amount:          tx.Amount,
      price:           tx.Price,
      total_volume:    tx.TotalVolume,
      total_amount:    tx.TotalAmount,
      tc_volume:       tx.TCVolume,
      flow_rate:       tx.FlowRate,
      is_offline:      tx.IsOffline,
      is_paid:         tx.IsPaid,
      tag:             tag || null,
      attendant_id:    match ? match.attendant_id : null,
      attendant_name:  match ? match.attendant_name : null,
    };
  });
}

/**
 * Parse and validate date-range query params.
 * Expects ?from=YYYY-MM-DDThh:mm:ss&to=YYYY-MM-DDThh:mm:ss
 */
function parseDateRange(query) {
  const { from, to } = query;
  if (!from || !to) {
    return { error: 'Both "from" and "to" query parameters are required (format: YYYY-MM-DDThh:mm:ss)' };
  }
  // Basic validation
  if (isNaN(Date.parse(from)) || isNaN(Date.parse(to))) {
    return { error: 'Invalid date format. Use YYYY-MM-DDThh:mm:ss' };
  }
  return { from, to };
}

// ═══════════════════════════════════════════════
//  ENDPOINTS
// ═══════════════════════════════════════════════

/**
 * @swagger
 * tags:
 *   name: Reports
 *   description: Live PTS fuel sales reports with attendant resolution
 */

// ─────────────────────────────────────────────
//  GET /api/reports/transactions
// ─────────────────────────────────────────────

/**
 * @swagger
 * /api/reports/transactions:
 *   get:
 *     summary: All transactions for date range with attendant names
 *     tags: [Reports]
 *     parameters:
 *       - in: query
 *         name: from
 *         required: true
 *         schema: { type: string }
 *         description: Start date-time (YYYY-MM-DDThh:mm:ss)
 *       - in: query
 *         name: to
 *         required: true
 *         schema: { type: string }
 *         description: End date-time (YYYY-MM-DDThh:mm:ss)
 *     responses:
 *       200:
 *         description: List of enriched transactions
 */
router.get('/transactions', async (req, res) => {
  try {
    const range = parseDateRange(req.query);
    if (range.error) return res.status(400).json({ success: false, error: range.error });

    const [transactions, tagMap] = await Promise.all([
      fetchPTSTransactions(range.from, range.to),
      loadTagMap(),
    ]);

    const enriched = enrichTransactions(transactions, tagMap);

    res.json({
      success: true,
      period: { from: range.from, to: range.to },
      count: enriched.length,
      transactions: enriched,
    });
  } catch (error) {
    logger.error('Error fetching transactions report', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ─────────────────────────────────────────────
//  GET /api/reports/by-attendant
// ─────────────────────────────────────────────

/**
 * @swagger
 * /api/reports/by-attendant:
 *   get:
 *     summary: Transactions grouped by attendant (resolved from RFID tag)
 *     tags: [Reports]
 *     parameters:
 *       - in: query
 *         name: from
 *         required: true
 *         schema: { type: string }
 *       - in: query
 *         name: to
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Transactions grouped by attendant
 */
router.get('/by-attendant', async (req, res) => {
  try {
    const range = parseDateRange(req.query);
    if (range.error) return res.status(400).json({ success: false, error: range.error });

    const [transactions, tagMap] = await Promise.all([
      fetchPTSTransactions(range.from, range.to),
      loadTagMap(),
    ]);

    const enriched = enrichTransactions(transactions, tagMap);

    // Group by attendant
    const groups = {};
    for (const tx of enriched) {
      const key = tx.attendant_name || 'UNTAGGED';
      if (!groups[key]) {
        groups[key] = {
          attendant_name: tx.attendant_name,
          attendant_id:   tx.attendant_id,
          tag:            tx.tag,
          transaction_count: 0,
          total_volume: 0,
          total_amount: 0,
          petrol: { volume: 0, amount: 0, count: 0 },
          diesel: { volume: 0, amount: 0, count: 0 },
          transactions: [],
        };
      }
      const g = groups[key];
      g.transaction_count++;
      g.total_volume += tx.volume;
      g.total_amount += tx.amount;

      if (tx.fuel_grade === 'Petrol') {
        g.petrol.volume += tx.volume;
        g.petrol.amount += tx.amount;
        g.petrol.count++;
      } else if (tx.fuel_grade === 'Diesel') {
        g.diesel.volume += tx.volume;
        g.diesel.amount += tx.amount;
        g.diesel.count++;
      }

      g.transactions.push(tx);
    }

    // Sort by total amount descending
    const attendants = Object.values(groups).sort((a, b) => b.total_amount - a.total_amount);

    // Round totals
    for (const a of attendants) {
      a.total_volume = +a.total_volume.toFixed(2);
      a.total_amount = +a.total_amount.toFixed(2);
      a.petrol.volume = +a.petrol.volume.toFixed(2);
      a.petrol.amount = +a.petrol.amount.toFixed(2);
      a.diesel.volume = +a.diesel.volume.toFixed(2);
      a.diesel.amount = +a.diesel.amount.toFixed(2);
    }

    res.json({
      success: true,
      period: { from: range.from, to: range.to },
      total_transactions: enriched.length,
      attendant_count: attendants.length,
      attendants,
    });
  } catch (error) {
    logger.error('Error fetching by-attendant report', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ─────────────────────────────────────────────
//  GET /api/reports/by-fuel-grade
// ─────────────────────────────────────────────

/**
 * @swagger
 * /api/reports/by-fuel-grade:
 *   get:
 *     summary: Transactions grouped by fuel grade
 *     tags: [Reports]
 *     parameters:
 *       - in: query
 *         name: from
 *         required: true
 *         schema: { type: string }
 *       - in: query
 *         name: to
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Transactions grouped by fuel grade
 */
router.get('/by-fuel-grade', async (req, res) => {
  try {
    const range = parseDateRange(req.query);
    if (range.error) return res.status(400).json({ success: false, error: range.error });

    const [transactions, tagMap] = await Promise.all([
      fetchPTSTransactions(range.from, range.to),
      loadTagMap(),
    ]);

    const enriched = enrichTransactions(transactions, tagMap);

    // Group by fuel grade
    const grades = {};
    for (const tx of enriched) {
      const key = tx.fuel_grade || 'Unknown';
      if (!grades[key]) {
        grades[key] = {
          fuel_grade:    key,
          fuel_grade_id: tx.fuel_grade_id,
          price:         tx.price,
          transaction_count: 0,
          total_volume: 0,
          total_amount: 0,
          transactions: [],
        };
      }
      const g = grades[key];
      g.transaction_count++;
      g.total_volume += tx.volume;
      g.total_amount += tx.amount;
      g.transactions.push(tx);
    }

    const fuel_grades = Object.values(grades).sort((a, b) => b.total_amount - a.total_amount);
    for (const g of fuel_grades) {
      g.total_volume = +g.total_volume.toFixed(2);
      g.total_amount = +g.total_amount.toFixed(2);
    }

    const grand_total_volume = +enriched.reduce((s, t) => s + t.volume, 0).toFixed(2);
    const grand_total_amount = +enriched.reduce((s, t) => s + t.amount, 0).toFixed(2);

    res.json({
      success: true,
      period: { from: range.from, to: range.to },
      total_transactions: enriched.length,
      grand_total_volume,
      grand_total_amount,
      fuel_grades,
    });
  } catch (error) {
    logger.error('Error fetching by-fuel-grade report', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ─────────────────────────────────────────────
//  GET /api/reports/by-pump
// ─────────────────────────────────────────────

/**
 * @swagger
 * /api/reports/by-pump:
 *   get:
 *     summary: Transactions grouped by pump
 *     tags: [Reports]
 *     parameters:
 *       - in: query
 *         name: from
 *         required: true
 *         schema: { type: string }
 *       - in: query
 *         name: to
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Transactions grouped by pump
 */
router.get('/by-pump', async (req, res) => {
  try {
    const range = parseDateRange(req.query);
    if (range.error) return res.status(400).json({ success: false, error: range.error });

    const [transactions, tagMap] = await Promise.all([
      fetchPTSTransactions(range.from, range.to),
      loadTagMap(),
    ]);

    const enriched = enrichTransactions(transactions, tagMap);

    // Group by pump
    const pumps = {};
    for (const tx of enriched) {
      const key = tx.pump;
      if (!pumps[key]) {
        pumps[key] = {
          pump: key,
          transaction_count: 0,
          total_volume: 0,
          total_amount: 0,
          petrol: { volume: 0, amount: 0, count: 0 },
          diesel: { volume: 0, amount: 0, count: 0 },
          attendants_seen: new Set(),
          transactions: [],
        };
      }
      const g = pumps[key];
      g.transaction_count++;
      g.total_volume += tx.volume;
      g.total_amount += tx.amount;

      if (tx.fuel_grade === 'Petrol') {
        g.petrol.volume += tx.volume;
        g.petrol.amount += tx.amount;
        g.petrol.count++;
      } else if (tx.fuel_grade === 'Diesel') {
        g.diesel.volume += tx.volume;
        g.diesel.amount += tx.amount;
        g.diesel.count++;
      }

      if (tx.attendant_name) g.attendants_seen.add(tx.attendant_name);
      g.transactions.push(tx);
    }

    const pump_list = Object.values(pumps)
      .sort((a, b) => a.pump - b.pump)
      .map(g => ({
        ...g,
        total_volume: +g.total_volume.toFixed(2),
        total_amount: +g.total_amount.toFixed(2),
        petrol:  { ...g.petrol, volume: +g.petrol.volume.toFixed(2), amount: +g.petrol.amount.toFixed(2) },
        diesel:  { ...g.diesel, volume: +g.diesel.volume.toFixed(2), amount: +g.diesel.amount.toFixed(2) },
        attendants_seen: [...g.attendants_seen],
      }));

    const grand_total_volume = +enriched.reduce((s, t) => s + t.volume, 0).toFixed(2);
    const grand_total_amount = +enriched.reduce((s, t) => s + t.amount, 0).toFixed(2);

    res.json({
      success: true,
      period: { from: range.from, to: range.to },
      total_transactions: enriched.length,
      grand_total_volume,
      grand_total_amount,
      pumps: pump_list,
    });
  } catch (error) {
    logger.error('Error fetching by-pump report', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ─────────────────────────────────────────────
//  GET /api/reports/summary
// ─────────────────────────────────────────────

/**
 * @swagger
 * /api/reports/summary:
 *   get:
 *     summary: Grand summary for date range
 *     tags: [Reports]
 *     parameters:
 *       - in: query
 *         name: from
 *         required: true
 *         schema: { type: string }
 *       - in: query
 *         name: to
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Summary totals
 */
router.get('/summary', async (req, res) => {
  try {
    const range = parseDateRange(req.query);
    if (range.error) return res.status(400).json({ success: false, error: range.error });

    const [transactions, tagMap] = await Promise.all([
      fetchPTSTransactions(range.from, range.to),
      loadTagMap(),
    ]);

    const enriched = enrichTransactions(transactions, tagMap);

    const tagged   = enriched.filter(t => t.tag);
    const untagged = enriched.filter(t => !t.tag);

    // By fuel grade
    const byGrade = {};
    for (const tx of enriched) {
      const key = tx.fuel_grade || 'Unknown';
      if (!byGrade[key]) byGrade[key] = { fuel_grade: key, price: tx.price, count: 0, volume: 0, amount: 0 };
      byGrade[key].count++;
      byGrade[key].volume += tx.volume;
      byGrade[key].amount += tx.amount;
    }
    for (const g of Object.values(byGrade)) {
      g.volume = +g.volume.toFixed(2);
      g.amount = +g.amount.toFixed(2);
    }

    // By pump
    const byPump = {};
    for (const tx of enriched) {
      if (!byPump[tx.pump]) byPump[tx.pump] = { pump: tx.pump, count: 0, volume: 0, amount: 0 };
      byPump[tx.pump].count++;
      byPump[tx.pump].volume += tx.volume;
      byPump[tx.pump].amount += tx.amount;
    }
    for (const g of Object.values(byPump)) {
      g.volume = +g.volume.toFixed(2);
      g.amount = +g.amount.toFixed(2);
    }

    // By attendant
    const byAttendant = {};
    for (const tx of enriched) {
      const key = tx.attendant_name || 'UNTAGGED';
      if (!byAttendant[key]) byAttendant[key] = { attendant_name: tx.attendant_name, tag: tx.tag, count: 0, volume: 0, amount: 0 };
      byAttendant[key].count++;
      byAttendant[key].volume += tx.volume;
      byAttendant[key].amount += tx.amount;
    }
    for (const g of Object.values(byAttendant)) {
      g.volume = +g.volume.toFixed(2);
      g.amount = +g.amount.toFixed(2);
    }

    res.json({
      success: true,
      period: { from: range.from, to: range.to },
      totals: {
        transaction_count: enriched.length,
        total_volume: +enriched.reduce((s, t) => s + t.volume, 0).toFixed(2),
        total_amount: +enriched.reduce((s, t) => s + t.amount, 0).toFixed(2),
        tagged_count: tagged.length,
        untagged_count: untagged.length,
      },
      by_fuel_grade:  Object.values(byGrade).sort((a, b) => b.amount - a.amount),
      by_pump:        Object.values(byPump).sort((a, b) => a.pump - b.pump),
      by_attendant:   Object.values(byAttendant).sort((a, b) => b.amount - a.amount),
    });
  } catch (error) {
    logger.error('Error fetching summary report', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
