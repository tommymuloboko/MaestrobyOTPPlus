const express = require('express');
const logger = require('../utils/logger')('TransactionsRoutes');
const db = require('../utils/db');
const dualDb = require('../utils/dual-db');
const { offlineAuthMiddleware, requireRole } = require('../middleware/offline-auth');

const router = express.Router();

/**
 * @swagger
 * tags:
 *   name: Transactions
 *   description: Fuel transaction management endpoints
 */

/**
 * @swagger
 * components:
 *   schemas:
 *     Transaction:
 *       type: object
 *       properties:
 *         id:
 *           type: string
 *           format: uuid
 *           description: Unique transaction identifier
 *         company_id:
 *           type: string
 *           format: uuid
 *           description: Company identifier
 *         station_id:
 *           type: string
 *           format: uuid
 *           description: Station identifier
 *         pump_id:
 *           type: string
 *           format: uuid
 *           description: Pump identifier
 *         time:
 *           type: string
 *           format: date-time
 *           description: Transaction timestamp
 *         amount:
 *           type: number
 *           format: float
 *           description: Transaction amount
 *         currency:
 *           type: string
 *           default: ZMW
 *           description: Currency code
 *         transaction_id:
 *           type: string
 *           description: External transaction reference
 *         is_verified:
 *           type: boolean
 *           description: Whether transaction has been verified
 *         created_at:
 *           type: string
 *           format: date-time
 *           description: Record creation timestamp
 *     TransactionSummary:
 *       type: object
 *       properties:
 *         verified_total:
 *           type: number
 *           description: Sum of verified transaction amounts
 *         unverified_total:
 *           type: number
 *           description: Sum of unverified transaction amounts
 *         total_count:
 *           type: integer
 *           description: Total number of transactions
 *         verified_count:
 *           type: integer
 *           description: Number of verified transactions
 *         unverified_count:
 *           type: integer
 *           description: Number of unverified transactions
 *         currency:
 *           type: string
 *           description: Currency code
 */

/**
 * @swagger
 * /api/transactions:
 *   get:
 *     summary: Get all fuel transactions
 *     description: Retrieve a paginated list of fuel transactions with optional filtering
 *     tags: [Transactions]
 *     parameters:
 *       - in: query
 *         name: company_id
 *         schema:
 *           type: string
 *           format: uuid
 *         description: Filter by company ID
 *       - in: query
 *         name: station_id
 *         schema:
 *           type: string
 *           format: uuid
 *         description: Filter by station ID
 *       - in: query
 *         name: pump_id
 *         schema:
 *           type: string
 *           format: uuid
 *         description: Filter by pump ID
 *       - in: query
 *         name: is_verified
 *         schema:
 *           type: boolean
 *         description: Filter by verification status
 *       - in: query
 *         name: start_date
 *         schema:
 *           type: string
 *           format: date-time
 *         description: Filter transactions from this date
 *       - in: query
 *         name: end_date
 *         schema:
 *           type: string
 *           format: date-time
 *         description: Filter transactions until this date
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 100
 *         description: Maximum number of transactions to return
 *       - in: query
 *         name: offset
 *         schema:
 *           type: integer
 *           default: 0
 *         description: Number of transactions to skip for pagination
 *     responses:
 *       200:
 *         description: List of transactions retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 count:
 *                   type: integer
 *                   description: Number of transactions returned
 *                 transactions:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/Transaction'
 *       500:
 *         description: Server error
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 */
router.get('/', async (req, res) => {
  try {
    const { company_id, station_id, pump_id, is_verified, start_date, end_date, limit = 100, offset = 0 } = req.query;

    let query = `SELECT id, company_id, station_id, shift_id, attendant_id, tag_number, full_name,
                 pump_id, time, amount, currency, transaction_id, is_verified, created_at 
                 FROM fuel_transactions_raw WHERE 1=1`;
    const params = [];
    let paramCount = 0;

    if (company_id) {
      paramCount++;
      query += ` AND company_id = $${paramCount}`;
      params.push(company_id);
    }

    if (station_id) {
      paramCount++;
      query += ` AND station_id = $${paramCount}`;
      params.push(station_id);
    }

    if (pump_id) {
      paramCount++;
      query += ` AND pump_id = $${paramCount}`;
      params.push(pump_id);
    }

    if (is_verified !== undefined) {
      paramCount++;
      query += ` AND is_verified = $${paramCount}`;
      params.push(is_verified === 'true');
    }

    if (start_date) {
      paramCount++;
      query += ` AND time >= $${paramCount}`;
      params.push(new Date(start_date));
    }

    if (end_date) {
      paramCount++;
      query += ` AND time <= $${paramCount}`;
      params.push(new Date(end_date));
    }

    query += ` ORDER BY time DESC LIMIT $${++paramCount} OFFSET $${++paramCount}`;
    params.push(parseInt(limit), parseInt(offset));

    const result = await db.query(query, params);

    res.json({
      success: true,
      count: result.rows.length,
      transactions: result.rows
    });
  } catch (error) {
    logger.error('Error fetching transactions', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /api/transactions/{id}:
 *   get:
 *     summary: Get a specific transaction
 *     description: Retrieve details of a single fuel transaction by ID
 *     tags: [Transactions]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *         description: The transaction ID
 *     responses:
 *       200:
 *         description: Transaction details retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 transaction:
 *                   $ref: '#/components/schemas/Transaction'
 *       404:
 *         description: Transaction not found
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                   example: Transaction not found
 *       500:
 *         description: Server error
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 */
// `id` is a bigint, so constrain the path to digits. Without this, Express matches
// in declaration order and this route swallows every literal GET below it —
// /transactions/verified arrived here as id='verified' and returned a 500 from
// Postgres ("invalid input syntax for type bigint"). The constraint keeps that from
// happening again as literal routes are added.
//
// Written [0-9]+ rather than \d+ on purpose: Express 4 bundles path-to-regexp
// 0.1.7, which strips the backslash and compiles \d+ to the literal letter d.
router.get('/:id([0-9]+)', async (req, res) => {
  try {
    const result = await db.query(
      `SELECT id, company_id, station_id, shift_id, attendant_id, tag_number, full_name,
              pump_id, time, amount, currency, transaction_id, is_verified, created_at
       FROM fuel_transactions_raw WHERE id = $1`,
      [req.params.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Transaction not found' });
    }

    res.json({
      success: true,
      transaction: result.rows[0]
    });
  } catch (error) {
    logger.error('Error fetching transaction', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /api/transactions:
 *   post:
 *     summary: Create a new fuel transaction
 *     description: Record a new fuel transaction in the system
 *     tags: [Transactions]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - company_id
 *               - station_id
 *               - pump_id
 *               - amount
 *             properties:
 *               company_id:
 *                 type: string
 *                 format: uuid
 *                 description: Company identifier
 *               station_id:
 *                 type: string
 *                 format: uuid
 *                 description: Station identifier
 *               pump_id:
 *                 type: string
 *                 format: uuid
 *                 description: Pump identifier
 *               amount:
 *                 type: number
 *                 format: float
 *                 description: Transaction amount
 *               currency:
 *                 type: string
 *                 default: ZMW
 *                 description: Currency code (defaults to ZMW)
 *     responses:
 *       201:
 *         description: Transaction created successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 transaction:
 *                   $ref: '#/components/schemas/Transaction'
 *       400:
 *         description: Missing required fields
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                   example: 'Missing required fields: company_id, station_id, pump_id, amount'
 *       401:
 *         description: Unauthorized - Invalid or missing authentication
 *       403:
 *         description: Forbidden - Insufficient permissions (requires admin, manager, or attendant role)
 *       500:
 *         description: Server error
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 */
router.post('/', offlineAuthMiddleware, requireRole('admin', 'manager', 'attendant'), async (req, res) => {
  try {
    const { company_id, station_id, pump_id, amount, currency = 'ZMW' } = req.body;

    if (!company_id || !station_id || !pump_id || !amount) {
      return res.status(400).json({
        error: 'Missing required fields: company_id, station_id, pump_id, amount'
      });
    }

    const result = await db.query(
      `INSERT INTO fuel_transactions_raw (company_id, station_id, pump_id, time, amount, currency, is_verified, created_at)
       VALUES ($1, $2, $3, now(), $4, $5, false, now())
       RETURNING id, company_id, station_id, pump_id, time, amount, currency, is_verified, created_at`,
      [company_id, station_id, pump_id, amount, currency]
    );

    logger.info(`✅ Created transaction: ${amount} ${currency} at pump ${pump_id}`);

    // Queue for sync to Supabase
    await dualDb.addToSyncQueue('fuel_transactions_raw', result.rows[0].id, 'INSERT', {
      company_id, station_id, pump_id, amount, currency
    });

    res.status(201).json({
      success: true,
      transaction: result.rows[0]
    });
  } catch (error) {
    logger.error('Error creating transaction', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /api/transactions/{id}:
 *   put:
 *     summary: Update a transaction
 *     description: Update transaction details, primarily used for verification
 *     tags: [Transactions]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *         description: The transaction ID
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               is_verified:
 *                 type: boolean
 *                 description: Set verification status
 *               amount:
 *                 type: number
 *                 format: float
 *                 description: Updated transaction amount
 *     responses:
 *       200:
 *         description: Transaction updated successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 transaction:
 *                   $ref: '#/components/schemas/Transaction'
 *       400:
 *         description: No fields to update
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                   example: No fields to update
 *       401:
 *         description: Unauthorized - Invalid or missing authentication
 *       403:
 *         description: Forbidden - Insufficient permissions (requires admin or manager role)
 *       404:
 *         description: Transaction not found
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                   example: Transaction not found
 *       500:
 *         description: Server error
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 */
router.put('/:id', offlineAuthMiddleware, requireRole('admin', 'manager'), async (req, res) => {
  try {
    const { is_verified, amount } = req.body;
    const updates = [];
    const params = [];
    let paramCount = 1;

    if (is_verified !== undefined) {
      updates.push(`is_verified = $${paramCount++}`);
      params.push(is_verified);
    }

    if (amount !== undefined) {
      updates.push(`amount = $${paramCount++}`);
      params.push(amount);
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'No fields to update' });
    }

    params.push(req.params.id);
    const query = `UPDATE fuel_transactions_raw SET ${updates.join(', ')} WHERE id = $${paramCount} RETURNING *`;

    const result = await db.query(query, params);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Transaction not found' });
    }

    logger.info(`✅ Updated transaction: ${result.rows[0].id}`);

    res.json({
      success: true,
      transaction: result.rows[0]
    });
  } catch (error) {
    logger.error('Error updating transaction', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /api/transactions/{id}:
 *   delete:
 *     summary: Delete a transaction
 *     description: Permanently remove a fuel transaction from the system
 *     tags: [Transactions]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *         description: The transaction ID
 *     responses:
 *       200:
 *         description: Transaction deleted successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 message:
 *                   type: string
 *                   example: Transaction deleted
 *       401:
 *         description: Unauthorized - Invalid or missing authentication
 *       403:
 *         description: Forbidden - Insufficient permissions (requires admin role)
 *       404:
 *         description: Transaction not found
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                   example: Transaction not found
 *       500:
 *         description: Server error
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 */
router.delete('/:id', offlineAuthMiddleware, requireRole('admin'), async (req, res) => {
  try {
    const result = await db.query(
      'DELETE FROM fuel_transactions_raw WHERE id = $1 RETURNING *',
      [req.params.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Transaction not found' });
    }

    logger.info(`✅ Deleted transaction: ${result.rows[0].id}`);

    res.json({
      success: true,
      message: 'Transaction deleted'
    });
  } catch (error) {
    logger.error('Error deleting transaction', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /api/transactions/summary/{station_id}:
 *   get:
 *     summary: Get transaction summary for a station
 *     description: Retrieve aggregated transaction statistics for a specific station
 *     tags: [Transactions]
 *     parameters:
 *       - in: path
 *         name: station_id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *         description: The station ID
 *       - in: query
 *         name: start_date
 *         schema:
 *           type: string
 *           format: date-time
 *         description: Filter transactions from this date
 *       - in: query
 *         name: end_date
 *         schema:
 *           type: string
 *           format: date-time
 *         description: Filter transactions until this date
 *     responses:
 *       200:
 *         description: Transaction summary retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 summary:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/TransactionSummary'
 *       500:
 *         description: Server error
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 */
router.get('/summary/:station_id', async (req, res) => {
  try {
    const { start_date, end_date } = req.query;

    let query = `SELECT 
                 SUM(CASE WHEN is_verified THEN amount ELSE 0 END) as verified_total,
                 SUM(CASE WHEN NOT is_verified THEN amount ELSE 0 END) as unverified_total,
                 COUNT(*) as total_count,
                 COUNT(CASE WHEN is_verified THEN 1 END) as verified_count,
                 COUNT(CASE WHEN NOT is_verified THEN 1 END) as unverified_count,
                 currency
                 FROM fuel_transactions_raw
                 WHERE station_id = $1`;
    const params = [req.params.station_id];
    let paramCount = 1;

    if (start_date) {
      paramCount++;
      query += ` AND time >= $${paramCount}`;
      params.push(new Date(start_date));
    }

    if (end_date) {
      paramCount++;
      query += ` AND time <= $${paramCount}`;
      params.push(new Date(end_date));
    }

    query += ` GROUP BY currency`;

    const result = await db.query(query, params);

    res.json({
      success: true,
      summary: result.rows
    });
  } catch (error) {
    logger.error('Error fetching transaction summary', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /api/transactions/verify:
 *   post:
 *     summary: Verify transactions with payment type
 *     description: Manager verifies raw transactions by selecting payment type (cash, card, debtor)
 *     tags: [Transactions]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - verifications
 *             properties:
 *               verifications:
 *                 type: array
 *                 items:
 *                   type: object
 *                   required:
 *                     - raw_id
 *                     - payment_type
 *                   properties:
 *                     raw_id:
 *                       type: integer
 *                       description: The ID of the raw transaction to verify
 *                     payment_type:
 *                       type: string
 *                       enum: [cash, card, debtor]
 *                       description: Payment method used
 *               verified_by_user_id:
 *                 type: string
 *                 format: uuid
 *                 description: ID of the manager verifying (optional, uses auth user if not provided)
 *     responses:
 *       200:
 *         description: Transactions verified successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 message:
 *                   type: string
 *                 verified_count:
 *                   type: integer
 *                 verified_transactions:
 *                   type: array
 *       400:
 *         description: Invalid request
 *       500:
 *         description: Server error
 */
router.post('/verify', async (req, res) => {
  try {
    const { verifications, verified_by_user_id } = req.body;
    
    if (!verifications || !Array.isArray(verifications) || verifications.length === 0) {
      return res.status(400).json({ 
        error: 'verifications array is required with at least one item' 
      });
    }

    // Validate payment types
    const validPaymentTypes = ['cash', 'card', 'debtor'];
    for (const v of verifications) {
      if (!v.raw_id) {
        return res.status(400).json({ error: 'raw_id is required for each verification' });
      }
      if (!v.payment_type || !validPaymentTypes.includes(v.payment_type)) {
        return res.status(400).json({ 
          error: `Invalid payment_type: ${v.payment_type}. Must be one of: ${validPaymentTypes.join(', ')}` 
        });
      }
    }

    const verifiedTransactions = [];
    const errors = [];
    
    // Get the user ID from auth or request body
    const userId = verified_by_user_id || req.user?.id || null;

    for (const verification of verifications) {
      try {
        // Get the raw transaction
        const rawResult = await db.query(
          `SELECT id, company_id, station_id, shift_id, attendant_id, tag_number, full_name,
                  pump_id, time, amount, currency, transaction_id, is_verified
           FROM fuel_transactions_raw WHERE id = $1`,
          [verification.raw_id]
        );

        if (rawResult.rows.length === 0) {
          errors.push({ raw_id: verification.raw_id, error: 'Transaction not found' });
          continue;
        }

        const raw = rawResult.rows[0];

        // Check if already verified
        const existingVerified = await db.query(
          `SELECT id FROM fuel_transactions_verified WHERE raw_id = $1`,
          [verification.raw_id]
        );

        if (existingVerified.rows.length > 0) {
          errors.push({ raw_id: verification.raw_id, error: 'Transaction already verified' });
          continue;
        }

        // Insert into fuel_transactions_verified
        const insertResult = await db.query(
          `INSERT INTO fuel_transactions_verified 
           (raw_id, company_id, station_id, shift_id, attendant_id, payment_type, 
            verified_by_user_id, verified_at, amount, currency, time, tag_number, 
            full_name, pump_id, transaction_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), $8, $9, $10, $11, $12, $13, $14)
           RETURNING *`,
          [
            raw.id,
            raw.company_id,
            raw.station_id,
            raw.shift_id,
            raw.attendant_id,
            verification.payment_type,
            userId,
            raw.amount,
            raw.currency,
            raw.time,
            raw.tag_number,
            raw.full_name,
            raw.pump_id,
            raw.transaction_id
          ]
        );

        // Update raw transaction to mark as verified
        await db.query(
          `UPDATE fuel_transactions_raw SET is_verified = TRUE WHERE id = $1`,
          [raw.id]
        );

        verifiedTransactions.push(insertResult.rows[0]);
        logger.info(`✅ Verified transaction: raw_id=${raw.id}, payment_type=${verification.payment_type}, amount=K${raw.amount}`);

      } catch (verifyError) {
        logger.error(`Error verifying transaction ${verification.raw_id}`, verifyError);
        errors.push({ raw_id: verification.raw_id, error: verifyError.message });
      }
    }

    res.json({
      success: true,
      message: `Verified ${verifiedTransactions.length} transaction(s)`,
      verified_count: verifiedTransactions.length,
      verified_transactions: verifiedTransactions,
      errors: errors.length > 0 ? errors : undefined
    });

  } catch (error) {
    logger.error('Error verifying transactions', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /api/transactions/verified:
 *   get:
 *     summary: Get verified transactions
 *     description: Retrieve verified transactions with optional filtering
 *     tags: [Transactions]
 *     parameters:
 *       - in: query
 *         name: station_id
 *         schema:
 *           type: string
 *           format: uuid
 *       - in: query
 *         name: shift_id
 *         schema:
 *           type: string
 *           format: uuid
 *       - in: query
 *         name: attendant_id
 *         schema:
 *           type: string
 *           format: uuid
 *       - in: query
 *         name: payment_type
 *         schema:
 *           type: string
 *           enum: [cash, card, debtor]
 *       - in: query
 *         name: start_date
 *         schema:
 *           type: string
 *           format: date-time
 *       - in: query
 *         name: end_date
 *         schema:
 *           type: string
 *           format: date-time
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 100
 *       - in: query
 *         name: offset
 *         schema:
 *           type: integer
 *           default: 0
 *     responses:
 *       200:
 *         description: Verified transactions retrieved
 */
router.get('/verified', async (req, res) => {
  try {
    const { station_id, shift_id, attendant_id, payment_type, start_date, end_date, limit = 100, offset = 0 } = req.query;

    let query = `SELECT * FROM fuel_transactions_verified WHERE 1=1`;
    const params = [];
    let paramCount = 0;

    if (station_id) {
      paramCount++;
      query += ` AND station_id = $${paramCount}`;
      params.push(station_id);
    }

    if (shift_id) {
      paramCount++;
      query += ` AND shift_id = $${paramCount}`;
      params.push(shift_id);
    }

    if (attendant_id) {
      paramCount++;
      query += ` AND attendant_id = $${paramCount}`;
      params.push(attendant_id);
    }

    if (payment_type) {
      paramCount++;
      query += ` AND payment_type = $${paramCount}`;
      params.push(payment_type);
    }

    if (start_date) {
      paramCount++;
      query += ` AND verified_at >= $${paramCount}`;
      params.push(new Date(start_date));
    }

    if (end_date) {
      paramCount++;
      query += ` AND verified_at <= $${paramCount}`;
      params.push(new Date(end_date));
    }

    query += ` ORDER BY verified_at DESC LIMIT $${++paramCount} OFFSET $${++paramCount}`;
    params.push(parseInt(limit), parseInt(offset));

    const result = await db.query(query, params);

    res.json({
      success: true,
      count: result.rows.length,
      transactions: result.rows
    });

  } catch (error) {
    logger.error('Error fetching verified transactions', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /api/transactions/verified/summary:
 *   get:
 *     summary: Get verified transaction summary by payment type
 *     tags: [Transactions]
 *     parameters:
 *       - in: query
 *         name: station_id
 *         schema:
 *           type: string
 *           format: uuid
 *       - in: query
 *         name: shift_id
 *         schema:
 *           type: string
 *           format: uuid
 *       - in: query
 *         name: start_date
 *         schema:
 *           type: string
 *           format: date-time
 *       - in: query
 *         name: end_date
 *         schema:
 *           type: string
 *           format: date-time
 *     responses:
 *       200:
 *         description: Summary by payment type
 */
router.get('/verified/summary', async (req, res) => {
  try {
    const { station_id, shift_id, start_date, end_date } = req.query;

    let query = `SELECT 
                   payment_type,
                   COUNT(*) as count,
                   SUM(amount) as total_amount,
                   currency
                 FROM fuel_transactions_verified 
                 WHERE 1=1`;
    const params = [];
    let paramCount = 0;

    if (station_id) {
      paramCount++;
      query += ` AND station_id = $${paramCount}`;
      params.push(station_id);
    }

    if (shift_id) {
      paramCount++;
      query += ` AND shift_id = $${paramCount}`;
      params.push(shift_id);
    }

    if (start_date) {
      paramCount++;
      query += ` AND verified_at >= $${paramCount}`;
      params.push(new Date(start_date));
    }

    if (end_date) {
      paramCount++;
      query += ` AND verified_at <= $${paramCount}`;
      params.push(new Date(end_date));
    }

    query += ` GROUP BY payment_type, currency ORDER BY payment_type`;

    const result = await db.query(query, params);

    // Calculate totals
    let totalAmount = 0;
    let totalCount = 0;
    result.rows.forEach(row => {
      totalAmount += parseFloat(row.total_amount || 0);
      totalCount += parseInt(row.count || 0);
    });

    res.json({
      success: true,
      summary: {
        by_payment_type: result.rows,
        total_amount: totalAmount,
        total_count: totalCount
      }
    });

  } catch (error) {
    logger.error('Error fetching verified summary', error);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
