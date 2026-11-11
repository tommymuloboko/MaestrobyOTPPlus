/**
 * Pump Reports Routes
 * API endpoints for General Maestro Reports
 * (data from ReportGetPumpTransactions / pump_report_transactions table)
 */

const express = require('express');
const logger = require('../utils/logger')('PumpReportsRoutes');
const db = require('../utils/db');

const router = express.Router();

/**
 * @swagger
 * tags:
 *   name: Pump Reports
 *   description: General Maestro Reports — full transaction data from ReportGetPumpTransactions
 */

/**
 * @swagger
 * components:
 *   schemas:
 *     PumpReportTransaction:
 *       type: object
 *       properties:
 *         id:
 *           type: integer
 *         company_id:
 *           type: string
 *           format: uuid
 *         station_id:
 *           type: string
 *           format: uuid
 *         pump_id:
 *           type: integer
 *         nozzle:
 *           type: integer
 *         fuel_grade_id:
 *           type: integer
 *         fuel_grade_name:
 *           type: string
 *         transaction_number:
 *           type: integer
 *         volume:
 *           type: number
 *           description: Litres dispensed
 *         tc_volume:
 *           type: number
 *           description: Temperature-compensated volume
 *         price:
 *           type: number
 *           description: Price per litre
 *         amount:
 *           type: number
 *           description: Total money amount
 *         total_volume:
 *           type: number
 *           description: Running total volume counter
 *         total_amount:
 *           type: number
 *           description: Running total amount counter
 *         tag:
 *           type: string
 *           description: RFID tag ID (hex)
 *         flow_rate:
 *           type: integer
 *           description: Fill flow rate (vol/min)
 *         is_offline:
 *           type: boolean
 *         is_paid:
 *           type: boolean
 *         pts_user_id:
 *           type: integer
 *         start_time:
 *           type: string
 *           format: date-time
 *         end_time:
 *           type: string
 *           format: date-time
 *         polled_at:
 *           type: string
 *           format: date-time
 *         created_at:
 *           type: string
 *           format: date-time
 */

// ---------------------------------------------------------------------------
// GET /api/pump-reports
// List with filters + pagination
// ---------------------------------------------------------------------------
/**
 * @swagger
 * /api/pump-reports:
 *   get:
 *     summary: Get pump report transactions (General Maestro Reports)
 *     tags: [Pump Reports]
 *     parameters:
 *       - in: query
 *         name: station_id
 *         schema: { type: string, format: uuid }
 *       - in: query
 *         name: pump_id
 *         schema: { type: integer }
 *       - in: query
 *         name: nozzle
 *         schema: { type: integer }
 *       - in: query
 *         name: fuel_grade_name
 *         schema: { type: string }
 *       - in: query
 *         name: is_paid
 *         schema: { type: boolean }
 *       - in: query
 *         name: is_offline
 *         schema: { type: boolean }
 *       - in: query
 *         name: from_date
 *         schema: { type: string, format: date-time }
 *         description: Filter by start_time >=
 *       - in: query
 *         name: to_date
 *         schema: { type: string, format: date-time }
 *         description: Filter by end_time <=
 *       - in: query
 *         name: page
 *         schema: { type: integer, default: 1 }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 50 }
 *     responses:
 *       200:
 *         description: Paginated list
 */
router.get('/', async (req, res) => {
  try {
    const {
      station_id, pump_id, nozzle, fuel_grade_name,
      is_paid, is_offline, from_date, to_date,
      page = 1, limit = 50
    } = req.query;

    let where = 'WHERE 1=1';
    const params = [];

    if (station_id) {
      params.push(station_id);
      where += ` AND station_id = $${params.length}`;
    }
    if (pump_id) {
      params.push(parseInt(pump_id));
      where += ` AND pump_id = $${params.length}`;
    }
    if (nozzle) {
      params.push(parseInt(nozzle));
      where += ` AND nozzle = $${params.length}`;
    }
    if (fuel_grade_name) {
      params.push(fuel_grade_name);
      where += ` AND fuel_grade_name ILIKE $${params.length}`;
    }
    if (is_paid !== undefined) {
      params.push(is_paid === 'true');
      where += ` AND is_paid = $${params.length}`;
    }
    if (is_offline !== undefined) {
      params.push(is_offline === 'true');
      where += ` AND is_offline = $${params.length}`;
    }
    if (from_date) {
      params.push(from_date);
      where += ` AND start_time >= $${params.length}`;
    }
    if (to_date) {
      params.push(to_date);
      where += ` AND end_time <= $${params.length}`;
    }

    const countResult = await db.query(
      `SELECT COUNT(*) AS count FROM pump_report_transactions ${where}`,
      params
    );
    const totalCount = parseInt(countResult.rows[0]?.count || 0);

    const offset = (parseInt(page) - 1) * parseInt(limit);
    params.push(parseInt(limit), offset);

    const result = await db.query(
      `SELECT * FROM pump_report_transactions
       ${where}
       ORDER BY start_time DESC, transaction_number DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params
    );

    res.json({
      data: result.rows,
      total_count: totalCount,
      page: parseInt(page),
      limit: parseInt(limit),
      page_count: Math.ceil(totalCount / parseInt(limit)),
    });
  } catch (error) {
    logger.error('Failed to fetch pump report transactions:', error);
    res.status(500).json({ error: error.message });
  }
});

// ---------------------------------------------------------------------------
// GET /api/pump-reports/summary
// Aggregated totals (overall + by pump + by fuel grade)
// ---------------------------------------------------------------------------
/**
 * @swagger
 * /api/pump-reports/summary:
 *   get:
 *     summary: Aggregated summary of pump report transactions
 *     tags: [Pump Reports]
 *     parameters:
 *       - in: query
 *         name: station_id
 *         schema: { type: string, format: uuid }
 *       - in: query
 *         name: from_date
 *         schema: { type: string, format: date-time }
 *       - in: query
 *         name: to_date
 *         schema: { type: string, format: date-time }
 *     responses:
 *       200:
 *         description: Summary object
 */
router.get('/summary', async (req, res) => {
  try {
    const { station_id, from_date, to_date } = req.query;

    let where = 'WHERE 1=1';
    const params = [];

    if (station_id) {
      params.push(station_id);
      where += ` AND station_id = $${params.length}`;
    }
    if (from_date) {
      params.push(from_date);
      where += ` AND start_time >= $${params.length}`;
    }
    if (to_date) {
      params.push(to_date);
      where += ` AND end_time <= $${params.length}`;
    }

    const [overview, byPump, byFuel] = await Promise.all([
      db.query(
        `SELECT
           COUNT(*)                        AS total_transactions,
           SUM(volume)                     AS total_volume,
           SUM(tc_volume)                  AS total_tc_volume,
           SUM(amount)                     AS total_amount,
           AVG(amount)                     AS avg_amount,
           COUNT(DISTINCT pump_id)         AS distinct_pumps,
           COUNT(*) FILTER (WHERE is_paid)    AS paid_count,
           COUNT(*) FILTER (WHERE is_offline) AS offline_count
         FROM pump_report_transactions ${where}`,
        params
      ),
      db.query(
        `SELECT
           pump_id,
           nozzle,
           COUNT(*)    AS transaction_count,
           SUM(volume) AS total_volume,
           SUM(amount) AS total_amount
         FROM pump_report_transactions ${where}
         GROUP BY pump_id, nozzle
         ORDER BY pump_id, nozzle`,
        params
      ),
      db.query(
        `SELECT
           fuel_grade_name,
           fuel_grade_id,
           COUNT(*)    AS transaction_count,
           SUM(volume) AS total_volume,
           SUM(amount) AS total_amount
         FROM pump_report_transactions ${where}
         GROUP BY fuel_grade_name, fuel_grade_id
         ORDER BY fuel_grade_name`,
        params
      ),
    ]);

    res.json({
      overview:      overview.rows[0],
      by_pump:       byPump.rows,
      by_fuel_grade: byFuel.rows,
    });
  } catch (error) {
    logger.error('Failed to get pump reports summary:', error);
    res.status(500).json({ error: error.message });
  }
});

// ---------------------------------------------------------------------------
// GET /api/pump-reports/by-pump/:pump_id
// All transactions for a specific pump
// ---------------------------------------------------------------------------
/**
 * @swagger
 * /api/pump-reports/by-pump/{pump_id}:
 *   get:
 *     summary: Get all transactions for a specific pump
 *     tags: [Pump Reports]
 *     parameters:
 *       - in: path
 *         name: pump_id
 *         required: true
 *         schema: { type: integer }
 *       - in: query
 *         name: from_date
 *         schema: { type: string, format: date-time }
 *       - in: query
 *         name: to_date
 *         schema: { type: string, format: date-time }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 100 }
 *     responses:
 *       200:
 *         description: Array of transactions
 */
router.get('/by-pump/:pump_id', async (req, res) => {
  try {
    const { pump_id } = req.params;
    const { from_date, to_date, limit = 100 } = req.query;

    let where = 'WHERE pump_id = $1';
    const params = [parseInt(pump_id)];

    if (from_date) { params.push(from_date); where += ` AND start_time >= $${params.length}`; }
    if (to_date)   { params.push(to_date);   where += ` AND end_time   <= $${params.length}`; }

    params.push(parseInt(limit));

    const result = await db.query(
      `SELECT * FROM pump_report_transactions
       ${where}
       ORDER BY start_time DESC
       LIMIT $${params.length}`,
      params
    );

    res.json(result.rows);
  } catch (error) {
    logger.error('Failed to fetch pump transactions:', error);
    res.status(500).json({ error: error.message });
  }
});

// ---------------------------------------------------------------------------
// GET /api/pump-reports/export/csv
// CSV export
// ---------------------------------------------------------------------------
/**
 * @swagger
 * /api/pump-reports/export/csv:
 *   get:
 *     summary: Export pump report transactions as CSV
 *     tags: [Pump Reports]
 *     parameters:
 *       - in: query
 *         name: station_id
 *         schema: { type: string, format: uuid }
 *       - in: query
 *         name: from_date
 *         schema: { type: string, format: date-time }
 *       - in: query
 *         name: to_date
 *         schema: { type: string, format: date-time }
 *     responses:
 *       200:
 *         description: CSV file
 *         content:
 *           text/csv:
 *             schema: { type: string }
 */
router.get('/export/csv', async (req, res) => {
  try {
    const { station_id, from_date, to_date } = req.query;

    let where = 'WHERE 1=1';
    const params = [];

    if (station_id) { params.push(station_id); where += ` AND station_id = $${params.length}`; }
    if (from_date)  { params.push(from_date);  where += ` AND start_time >= $${params.length}`; }
    if (to_date)    { params.push(to_date);     where += ` AND end_time <= $${params.length}`; }

    const result = await db.query(
      `SELECT * FROM pump_report_transactions ${where} ORDER BY start_time DESC`,
      params
    );

    const headers = [
      'ID','Pump','Nozzle','Fuel Grade','Fuel Grade ID',
      'Transaction #','Volume (L)','TC Volume (L)','Price','Amount',
      'Total Volume','Total Amount','Tag','Flow Rate',
      'Is Offline','Is Paid','PTS User ID',
      'Start Time','End Time','Polled At'
    ];

    let csv = headers.join(',') + '\n';
    result.rows.forEach(r => {
      csv += [
        r.id, r.pump_id, r.nozzle, r.fuel_grade_name, r.fuel_grade_id,
        r.transaction_number, r.volume, r.tc_volume, r.price, r.amount,
        r.total_volume, r.total_amount, r.tag, r.flow_rate,
        r.is_offline, r.is_paid, r.pts_user_id,
        r.start_time, r.end_time, r.polled_at
      ].map(v => `"${v ?? ''}"`).join(',') + '\n';
    });

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="pump-reports.csv"');
    res.send(csv);
  } catch (error) {
    logger.error('Failed to export pump reports:', error);
    res.status(500).json({ error: error.message });
  }
});

// ---------------------------------------------------------------------------
// GET /api/pump-reports/:id
// Single record
// ---------------------------------------------------------------------------
/**
 * @swagger
 * /api/pump-reports/{id}:
 *   get:
 *     summary: Get a single pump report transaction by ID
 *     tags: [Pump Reports]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200:
 *         description: Transaction record
 *       404:
 *         description: Not found
 */
router.get('/:id', async (req, res) => {
  try {
    const result = await db.query(
      'SELECT * FROM pump_report_transactions WHERE id = $1',
      [req.params.id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Record not found' });
    }
    res.json(result.rows[0]);
  } catch (error) {
    logger.error('Failed to fetch pump report record:', error);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
