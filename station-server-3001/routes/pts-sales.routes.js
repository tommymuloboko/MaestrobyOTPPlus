/**
 * PTS Sales Routes
 * API endpoints for accessing raw PTS sales transaction data
 */

const express = require('express');
const logger = require('../utils/logger')('PTSSalesRoutes');
const db = require('../utils/db');
const { offlineAuthMiddleware, requireRole } = require('../middleware/offline-auth');

const router = express.Router();

/**
 * @swagger
 * tags:
 *   name: PTS Sales
 *   description: Raw PTS transaction data endpoints
 */

/**
 * @swagger
 * components:
 *   schemas:
 *     PTSSale:
 *       type: object
 *       properties:
 *         id:
 *           type: integer
 *           description: Record ID
 *         company_id:
 *           type: string
 *           format: uuid
 *           description: Company ID
 *         station_id:
 *           type: string
 *           format: uuid
 *           description: Station ID
 *         pump_id:
 *           type: integer
 *           description: Pump number
 *         nozzle:
 *           type: integer
 *           description: Nozzle number
 *         fuel_grade:
 *           type: string
 *           description: Fuel type (Petrol, Diesel, etc)
 *         volume:
 *           type: number
 *           format: float
 *           description: Liters dispensed
 *         amount:
 *           type: number
 *           format: float
 *           description: Total sale amount
 *         unit_price:
 *           type: number
 *           format: float
 *           description: Price per liter
 *         currency:
 *           type: string
 *           default: ZMW
 *           description: Currency code
 *         pts_transaction_id:
 *           type: integer
 *           description: PTS transaction number
 *         transaction_state:
 *           type: string
 *           description: Transaction state from PTS
 *         start_time:
 *           type: string
 *           format: date-time
 *           description: Start of transaction
 *         end_time:
 *           type: string
 *           format: date-time
 *           description: End of transaction
 *         polled_at:
 *           type: string
 *           format: date-time
 *           description: When data was polled from PTS
 *         created_at:
 *           type: string
 *           format: date-time
 *           description: Record creation timestamp
 */

/**
 * @swagger
 * /api/pts-sales:
 *   get:
 *     summary: Get all PTS sales transactions
 *     description: Retrieve raw sales data polled from PTS pump terminals
 *     tags: [PTS Sales]
 *     parameters:
 *       - in: query
 *         name: station_id
 *         schema:
 *           type: string
 *           format: uuid
 *         description: Filter by station ID
 *       - in: query
 *         name: pump_id
 *         schema:
 *           type: integer
 *         description: Filter by pump number
 *       - in: query
 *         name: from_date
 *         schema:
 *           type: string
 *           format: date-time
 *         description: Start date for transaction filter
 *       - in: query
 *         name: to_date
 *         schema:
 *           type: string
 *           format: date-time
 *         description: End date for transaction filter
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *           default: 1
 *         description: Page number for pagination
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 50
 *         description: Records per page
 *     responses:
 *       200:
 *         description: List of PTS sales transactions
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 data:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/PTSSale'
 *                 total_count:
 *                   type: integer
 *                 page:
 *                   type: integer
 *                 limit:
 *                   type: integer
 */
router.get('/', async (req, res) => {
  try {
    const { 
      station_id, 
      pump_id, 
      from_date, 
      to_date,
      page = 1, 
      limit = 50 
    } = req.query;

    let query = 'SELECT * FROM pts_sales WHERE 1=1';
    const params = [];
    let paramCount = 1;

    // Filter by station
    if (station_id) {
      query += ` AND station_id = $${paramCount++}`;
      params.push(station_id);
    }

    // Filter by pump
    if (pump_id) {
      query += ` AND pump_id = $${paramCount++}`;
      params.push(parseInt(pump_id));
    }

    // Filter by date range
    if (from_date) {
      query += ` AND start_time >= $${paramCount++}`;
      params.push(from_date);
    }

    if (to_date) {
      query += ` AND end_time <= $${paramCount++}`;
      params.push(to_date);
    }

    // Get total count
    const countResult = await db.query(
      `SELECT COUNT(*) as count FROM (${query}) as counted`,
      params
    );
    const totalCount = parseInt(countResult.rows[0]?.count || 0);

    // Add pagination
    const offset = (parseInt(page) - 1) * parseInt(limit);
    query += ` ORDER BY polled_at DESC, pts_transaction_id DESC LIMIT $${paramCount++} OFFSET $${paramCount++}`;
    params.push(parseInt(limit), offset);

    const result = await db.query(query, params);

    res.json({
      data: result.rows,
      total_count: totalCount,
      page: parseInt(page),
      limit: parseInt(limit),
      page_count: Math.ceil(totalCount / parseInt(limit))
    });

  } catch (error) {
    logger.error('Failed to fetch PTS sales:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /api/pts-sales/summary:
 *   get:
 *     summary: Get sales statistics
 *     description: Get summary statistics for PTS sales data
 *     tags: [PTS Sales]
 *     parameters:
 *       - in: query
 *         name: station_id
 *         schema:
 *           type: string
 *           format: uuid
 *         description: Filter by station ID
 *       - in: query
 *         name: from_date
 *         schema:
 *           type: string
 *           format: date-time
 *         description: Start date
 *       - in: query
 *         name: to_date
 *         schema:
 *           type: string
 *           format: date-time
 *         description: End date
 *     responses:
 *       200:
 *         description: Sales summary
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 total_transactions:
 *                   type: integer
 *                 total_volume:
 *                   type: number
 *                 total_amount:
 *                   type: number
 *                 average_transaction:
 *                   type: number
 *                 by_pump:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       pump_id:
 *                         type: integer
 *                       transaction_count:
 *                         type: integer
 *                       volume:
 *                         type: number
 *                       amount:
 *                         type: number
 *                 by_fuel_grade:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       fuel_grade:
 *                         type: string
 *                       transaction_count:
 *                         type: integer
 *                       volume:
 *                         type: number
 *                       amount:
 *                         type: number
 */
router.get('/summary', async (req, res) => {
  try {
    const { station_id, from_date, to_date } = req.query;

    let whereClause = 'WHERE 1=1';
    const params = [];

    if (station_id) {
      whereClause += ` AND station_id = $${params.length + 1}`;
      params.push(station_id);
    }

    if (from_date) {
      whereClause += ` AND start_time >= $${params.length + 1}`;
      params.push(from_date);
    }

    if (to_date) {
      whereClause += ` AND end_time <= $${params.length + 1}`;
      params.push(to_date);
    }

    // Main summary
    const summaryQuery = `
      SELECT
        COUNT(*) as total_transactions,
        SUM(volume) as total_volume,
        SUM(amount) as total_amount,
        AVG(amount) as average_transaction,
        COUNT(DISTINCT pump_id) as total_pumps
      FROM pts_sales
      ${whereClause}
    `;

    // By pump
    const byPumpQuery = `
      SELECT
        pump_id,
        COUNT(*) as transaction_count,
        SUM(volume) as volume,
        SUM(amount) as amount
      FROM pts_sales
      ${whereClause}
      GROUP BY pump_id
      ORDER BY pump_id
    `;

    // By fuel grade
    const byFuelQuery = `
      SELECT
        fuel_grade,
        COUNT(*) as transaction_count,
        SUM(volume) as volume,
        SUM(amount) as amount
      FROM pts_sales
      ${whereClause}
      GROUP BY fuel_grade
      ORDER BY fuel_grade
    `;

    const [summary, byPump, byFuel] = await Promise.all([
      db.query(summaryQuery, params),
      db.query(byPumpQuery, params),
      db.query(byFuelQuery, params)
    ]);

    res.json({
      summary: summary.rows[0],
      by_pump: byPump.rows,
      by_fuel_grade: byFuel.rows
    });

  } catch (error) {
    logger.error('Failed to get PTS sales summary:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /api/pts-sales/{id}:
 *   get:
 *     summary: Get a single PTS sale transaction
 *     tags: [PTS Sales]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: integer
 *         description: Transaction ID
 *     responses:
 *       200:
 *         description: PTS sale transaction
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/PTSSale'
 *       404:
 *         description: Transaction not found
 */
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const result = await db.query(
      'SELECT * FROM pts_sales WHERE id = $1',
      [id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Transaction not found' });
    }

    res.json(result.rows[0]);

  } catch (error) {
    logger.error('Failed to fetch PTS sale:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /api/pts-sales/pump/{pump_id}:
 *   get:
 *     summary: Get all transactions for a specific pump
 *     tags: [PTS Sales]
 *     parameters:
 *       - in: path
 *         name: pump_id
 *         required: true
 *         schema:
 *           type: integer
 *         description: Pump number
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 50
 *         description: Maximum records to return
 *     responses:
 *       200:
 *         description: List of transactions for pump
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/PTSSale'
 */
router.get('/pump/:pump_id', async (req, res) => {
  try {
    const { pump_id } = req.params;
    const { limit = 50 } = req.query;

    const result = await db.query(
      `SELECT * FROM pts_sales 
       WHERE pump_id = $1 
       ORDER BY polled_at DESC 
       LIMIT $2`,
      [parseInt(pump_id), parseInt(limit)]
    );

    res.json(result.rows);

  } catch (error) {
    logger.error('Failed to fetch pump transactions:', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /api/pts-sales/export:
 *   get:
 *     summary: Export PTS sales data as CSV
 *     description: Export filtered sales data in CSV format
 *     tags: [PTS Sales]
 *     parameters:
 *       - in: query
 *         name: station_id
 *         schema:
 *           type: string
 *           format: uuid
 *       - in: query
 *         name: from_date
 *         schema:
 *           type: string
 *           format: date-time
 *       - in: query
 *         name: to_date
 *         schema:
 *           type: string
 *           format: date-time
 *     responses:
 *       200:
 *         description: CSV data
 *         content:
 *           text/csv:
 *             schema:
 *               type: string
 */
router.get('/export/csv', async (req, res) => {
  try {
    const { station_id, from_date, to_date } = req.query;

    let query = 'SELECT * FROM pts_sales WHERE 1=1';
    const params = [];

    if (station_id) {
      query += ` AND station_id = $${params.length + 1}`;
      params.push(station_id);
    }

    if (from_date) {
      query += ` AND start_time >= $${params.length + 1}`;
      params.push(from_date);
    }

    if (to_date) {
      query += ` AND end_time <= $${params.length + 1}`;
      params.push(to_date);
    }

    query += ' ORDER BY polled_at DESC';

    const result = await db.query(query, params);

    // Build CSV
    const headers = [
      'ID', 'Pump', 'Nozzle', 'Fuel Grade', 'Volume (L)', 'Amount',
      'Unit Price', 'Currency', 'Transaction ID', 'State', 'Start Time',
      'End Time', 'Polled At', 'Created At'
    ];

    let csv = headers.join(',') + '\n';

    result.rows.forEach(row => {
      csv += [
        row.id,
        row.pump_id,
        row.nozzle,
        row.fuel_grade,
        row.volume,
        row.amount,
        row.unit_price,
        row.currency,
        row.pts_transaction_id,
        row.transaction_state,
        row.start_time,
        row.end_time,
        row.polled_at,
        row.created_at
      ].map(v => `"${v || ''}"`).join(',') + '\n';
    });

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="pts-sales.csv"');
    res.send(csv);

  } catch (error) {
    logger.error('Failed to export PTS sales:', error);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
