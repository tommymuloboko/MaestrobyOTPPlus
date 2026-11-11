const express = require('express');
const logger = require('../utils/logger')('DebtorTransactionsRoutes');
const db = require('../utils/db');
const { offlineAuthMiddleware, requireRole } = require('../middleware/offline-auth');

const router = express.Router();

/**
 * @swagger
 * tags:
 *   name: DebtorTransactions
 *   description: Debtor transaction management for credit sales
 */

const DEBTOR_TRANSACTION_FIELDS = `
  dt.id, dt.shift_id, dt.debtor_id, dt.pts_transaction_id, 
  dt.driver_name, dt.vehicle_id, dt.pump_id, dt.amount, 
  dt.volume, dt.fuel_grade, dt.price_per_litre, dt.transaction_time,
  dt.created_at, dt.updated_at,
  d.customer_name, d.account_no,
  dv.number_plate, dv.fuel_type
`;

/**
 * @swagger
 * /api/debtor-transactions:
 *   get:
 *     summary: List debtor transactions with filters
 *     tags: [DebtorTransactions]
 *     parameters:
 *       - in: query
 *         name: shift_id
 *         schema: { type: string, format: uuid }
 *       - in: query
 *         name: debtor_id
 *         schema: { type: string, format: uuid }
 *       - in: query
 *         name: start_date
 *         schema: { type: string, format: date }
 *       - in: query
 *         name: end_date
 *         schema: { type: string, format: date }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 100 }
 *       - in: query
 *         name: offset
 *         schema: { type: integer, default: 0 }
 *     responses:
 *       200:
 *         description: List of debtor transactions
 */
router.get('/', async (req, res) => {
    try {
        const { shift_id, debtor_id, start_date, end_date, limit = 100, offset = 0 } = req.query;
        
        let query = `
            SELECT ${DEBTOR_TRANSACTION_FIELDS}
            FROM debtor_transactions dt
            JOIN debtors d ON dt.debtor_id = d.id
            LEFT JOIN debtor_vehicles dv ON dt.vehicle_id = dv.id
            WHERE 1=1
        `;
        const params = [];
        let p = 0;

        if (shift_id) { 
            query += ` AND dt.shift_id = $${++p}`; 
            params.push(shift_id); 
        }
        if (debtor_id) { 
            query += ` AND dt.debtor_id = $${++p}`; 
            params.push(debtor_id); 
        }
        if (start_date) { 
            query += ` AND dt.transaction_time >= $${++p}`; 
            params.push(start_date); 
        }
        if (end_date) { 
            query += ` AND dt.transaction_time <= $${++p}`; 
            params.push(end_date); 
        }

        query += ` ORDER BY dt.transaction_time DESC LIMIT $${++p} OFFSET $${++p}`;
        params.push(parseInt(limit), parseInt(offset));

        const result = await db.query(query, params);
        res.json({ 
            success: true, 
            count: result.rows.length, 
            transactions: result.rows 
        });
    } catch (error) {
        logger.error('Error fetching debtor transactions', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * @swagger
 * /api/debtor-transactions/{id}:
 *   get:
 *     summary: Get a single debtor transaction
 *     tags: [DebtorTransactions]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Debtor transaction details
 *       404:
 *         description: Transaction not found
 */
router.get('/:id', async (req, res) => {
    try {
        const query = `
            SELECT ${DEBTOR_TRANSACTION_FIELDS}
            FROM debtor_transactions dt
            JOIN debtors d ON dt.debtor_id = d.id
            LEFT JOIN debtor_vehicles dv ON dt.vehicle_id = dv.id
            WHERE dt.id = $1
        `;
        
        const result = await db.query(query, [req.params.id]);
        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Debtor transaction not found' });
        }
        
        res.json({ success: true, transaction: result.rows[0] });
    } catch (error) {
        logger.error('Error fetching debtor transaction', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * @swagger
 * /api/debtor-transactions:
 *   post:
 *     summary: Create a new debtor transaction
 *     tags: [DebtorTransactions]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [shift_id, debtor_id, pts_transaction_id, driver_name, pump_id, amount, volume, fuel_grade, price_per_litre, transaction_time]
 *             properties:
 *               shift_id:
 *                 type: string
 *                 format: uuid
 *               debtor_id:
 *                 type: string
 *                 format: uuid
 *               pts_transaction_id:
 *                 type: string
 *                 description: PTS transaction ID reference
 *               driver_name:
 *                 type: string
 *               vehicle_id:
 *                 type: string
 *                 format: uuid
 *               pump_id:
 *                 type: integer
 *               amount:
 *                 type: number
 *               volume:
 *                 type: number
 *               fuel_grade:
 *                 type: string
 *               price_per_litre:
 *                 type: number
 *               transaction_time:
 *                 type: string
 *                 format: date-time
 *     responses:
 *       201:
 *         description: Debtor transaction created
 *       400:
 *         description: Missing required fields or duplicate PTS transaction
 */
router.post('/', offlineAuthMiddleware, requireRole('admin', 'manager', 'attendant'), async (req, res) => {
    try {
        const {
            shift_id, debtor_id, pts_transaction_id, driver_name,
            vehicle_id, pump_id, amount, volume, fuel_grade,
            price_per_litre, transaction_time
        } = req.body;

        // Validate required fields
        const required = ['shift_id', 'debtor_id', 'pts_transaction_id', 'driver_name', 'pump_id', 'amount', 'volume', 'fuel_grade', 'price_per_litre', 'transaction_time'];
        const missing = required.filter(field => !req.body[field]);
        if (missing.length > 0) {
            return res.status(400).json({ 
                error: `Missing required fields: ${missing.join(', ')}` 
            });
        }

        // Check if PTS transaction already assigned to a debtor
        const existing = await db.query(
            'SELECT id FROM debtor_transactions WHERE pts_transaction_id = $1',
            [pts_transaction_id]
        );
        if (existing.rows.length > 0) {
            return res.status(400).json({ 
                error: 'PTS transaction already assigned to a debtor' 
            });
        }

        const result = await db.query(
            `INSERT INTO debtor_transactions (
                shift_id, debtor_id, pts_transaction_id, driver_name,
                vehicle_id, pump_id, amount, volume, fuel_grade,
                price_per_litre, transaction_time
            ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
            RETURNING id, shift_id, debtor_id, pts_transaction_id, driver_name,
                     vehicle_id, pump_id, amount, volume, fuel_grade,
                     price_per_litre, transaction_time, created_at`,
            [shift_id, debtor_id, pts_transaction_id, driver_name,
             vehicle_id || null, pump_id, amount, volume, fuel_grade,
             price_per_litre, transaction_time]
        );

        // Update debtor balance
        await db.query(
            'UPDATE debtors SET current_balance = current_balance + $1 WHERE id = $2',
            [amount, debtor_id]
        );

        logger.info(`✅ Created debtor transaction: ${pts_transaction_id} for debtor ${debtor_id} (R${amount})`);
        res.status(201).json({ success: true, transaction: result.rows[0] });
    } catch (error) {
        logger.error('Error creating debtor transaction', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * @swagger
 * /api/debtor-transactions/{id}:
 *   put:
 *     summary: Update a debtor transaction
 *     tags: [DebtorTransactions]
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
 *               driver_name:
 *                 type: string
 *               vehicle_id:
 *                 type: string
 *                 format: uuid
 *               amount:
 *                 type: number
 *               volume:
 *                 type: number
 *               fuel_grade:
 *                 type: string
 *               price_per_litre:
 *                 type: number
 *     responses:
 *       200:
 *         description: Debtor transaction updated
 *       404:
 *         description: Transaction not found
 */
router.put('/:id', offlineAuthMiddleware, requireRole('admin', 'manager'), async (req, res) => {
    try {
        const { driver_name, vehicle_id, amount, volume, fuel_grade, price_per_litre } = req.body;
        const updates = [];
        const params = [];
        let p = 1;

        // Get current transaction for balance adjustment
        const current = await db.query('SELECT debtor_id, amount FROM debtor_transactions WHERE id = $1', [req.params.id]);
        if (current.rows.length === 0) {
            return res.status(404).json({ error: 'Debtor transaction not found' });
        }

        if (driver_name !== undefined) { updates.push(`driver_name = $${p++}`); params.push(driver_name); }
        if (vehicle_id !== undefined) { updates.push(`vehicle_id = $${p++}`); params.push(vehicle_id); }
        if (amount !== undefined) { updates.push(`amount = $${p++}`); params.push(amount); }
        if (volume !== undefined) { updates.push(`volume = $${p++}`); params.push(volume); }
        if (fuel_grade !== undefined) { updates.push(`fuel_grade = $${p++}`); params.push(fuel_grade); }
        if (price_per_litre !== undefined) { updates.push(`price_per_litre = $${p++}`); params.push(price_per_litre); }

        if (updates.length === 0) {
            return res.status(400).json({ error: 'No fields to update' });
        }

        updates.push(`updated_at = NOW()`);
        params.push(req.params.id);

        const query = `UPDATE debtor_transactions SET ${updates.join(', ')} WHERE id = $${p} RETURNING *`;
        const result = await db.query(query, params);

        // Adjust debtor balance if amount changed
        if (amount !== undefined) {
            const oldAmount = current.rows[0].amount;
            const balanceChange = amount - oldAmount;
            await db.query(
                'UPDATE debtors SET current_balance = current_balance + $1 WHERE id = $2',
                [balanceChange, current.rows[0].debtor_id]
            );
        }

        logger.info(`✅ Updated debtor transaction: ${req.params.id}`);
        res.json({ success: true, transaction: result.rows[0] });
    } catch (error) {
        logger.error('Error updating debtor transaction', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * @swagger
 * /api/debtor-transactions/{id}:
 *   delete:
 *     summary: Delete a debtor transaction
 *     tags: [DebtorTransactions]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Transaction deleted
 *       404:
 *         description: Transaction not found
 */
router.delete('/:id', offlineAuthMiddleware, requireRole('admin', 'manager'), async (req, res) => {
    try {
        // Get transaction details before deletion
        const transaction = await db.query(
            'SELECT debtor_id, amount, pts_transaction_id FROM debtor_transactions WHERE id = $1',
            [req.params.id]
        );
        
        if (transaction.rows.length === 0) {
            return res.status(404).json({ error: 'Debtor transaction not found' });
        }

        // Delete the transaction
        await db.query('DELETE FROM debtor_transactions WHERE id = $1', [req.params.id]);

        // Adjust debtor balance (subtract the amount)
        await db.query(
            'UPDATE debtors SET current_balance = current_balance - $1 WHERE id = $2',
            [transaction.rows[0].amount, transaction.rows[0].debtor_id]
        );

        logger.info(`✅ Deleted debtor transaction: ${transaction.rows[0].pts_transaction_id} (${req.params.id})`);
        res.json({ 
            success: true, 
            message: 'Debtor transaction deleted',
            deleted_transaction: transaction.rows[0]
        });
    } catch (error) {
        logger.error('Error deleting debtor transaction', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * @swagger
 * /api/debtor-transactions/available-pts/{shift_id}:
 *   get:
 *     summary: Get available PTS transactions for a shift that can be assigned to debtors
 *     tags: [DebtorTransactions]
 *     parameters:
 *       - in: path
 *         name: shift_id
 *         required: true
 *         schema: { type: string, format: uuid }
 *       - in: query
 *         name: pump_id
 *         schema: { type: integer }
 *     responses:
 *       200:
 *         description: Available PTS transactions
 */
router.get('/available-pts/:shift_id', async (req, res) => {
    try {
        const { shift_id } = req.params;
        const { pump_id } = req.query;

        let query = `
            SELECT ps.*, p.display_name as pump_name
            FROM pts_sales ps
            JOIN pumps p ON ps.pump_id = p.id
            LEFT JOIN debtor_transactions dt ON ps.transaction_id = dt.pts_transaction_id
            WHERE ps.shift_id = $1 
            AND dt.id IS NULL  -- Not already assigned to a debtor
            AND ps.amount > 0  -- Valid transaction
        `;
        const params = [shift_id];
        let p = 1;

        if (pump_id) {
            query += ` AND ps.pump_id = $${++p}`;
            params.push(pump_id);
        }

        query += ` ORDER BY ps.transaction_date DESC`;

        const result = await db.query(query, params);
        res.json({ 
            success: true, 
            count: result.rows.length,
            available_transactions: result.rows 
        });
    } catch (error) {
        logger.error('Error fetching available PTS transactions', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * @swagger
 * /api/debtor-transactions/shift-summary/{shift_id}:
 *   get:
 *     summary: Get debtor transaction summary for a shift
 *     tags: [DebtorTransactions]
 *     parameters:
 *       - in: path
 *         name: shift_id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Shift debtor transaction summary
 */
router.get('/shift-summary/:shift_id', async (req, res) => {
    try {
        const summary = await db.query(`
            SELECT 
                d.id as debtor_id,
                d.customer_name,
                d.account_no,
                COUNT(dt.id) as transaction_count,
                SUM(dt.amount) as total_amount,
                SUM(dt.volume) as total_volume
            FROM debtor_transactions dt
            JOIN debtors d ON dt.debtor_id = d.id
            WHERE dt.shift_id = $1
            GROUP BY d.id, d.customer_name, d.account_no
            ORDER BY d.customer_name
        `, [req.params.shift_id]);

        const total = await db.query(`
            SELECT 
                COUNT(id) as total_transactions,
                SUM(amount) as total_amount,
                SUM(volume) as total_volume
            FROM debtor_transactions
            WHERE shift_id = $1
        `, [req.params.shift_id]);

        res.json({ 
            success: true,
            shift_id: req.params.shift_id,
            debtor_summary: summary.rows,
            totals: total.rows[0] || { total_transactions: 0, total_amount: 0, total_volume: 0 }
        });
    } catch (error) {
        logger.error('Error fetching shift debtor summary', error);
        res.status(500).json({ error: error.message });
    }
});

module.exports = router;