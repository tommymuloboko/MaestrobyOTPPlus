const express = require('express');
const logger = require('../utils/logger')('DebtorsRoutes');
const db = require('../utils/db');
const { offlineAuthMiddleware, requireRole } = require('../middleware/offline-auth');

const router = express.Router();

/**
 * @swagger
 * tags:
 *   name: Debtors
 *   description: Debtor (credit customer) management
 */

const DEBTOR_FIELDS = `id, company_id, station_id, account_no, customer_name, contact_name,
  phone, email, address, credit_limit, current_balance, term_days, status, created_at`;

/**
 * @swagger
 * /api/debtors:
 *   get:
 *     summary: List all debtors
 *     tags: [Debtors]
 *     parameters:
 *       - in: query
 *         name: station_id
 *         schema: { type: string, format: uuid }
 *       - in: query
 *         name: status
 *         schema: { type: string, enum: [active, suspended, closed] }
 *       - in: query
 *         name: search
 *         schema: { type: string }
 *         description: Search by customer_name, account_no, contact_name, or phone
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 100 }
 *       - in: query
 *         name: offset
 *         schema: { type: integer, default: 0 }
 *     responses:
 *       200:
 *         description: List of debtors
 */
router.get('/', async (req, res) => {
    try {
        const { station_id, status, search, limit = 100, offset = 0 } = req.query;
        let query = `SELECT ${DEBTOR_FIELDS} FROM debtors WHERE 1=1`;
        const params = [];
        let p = 0;

        if (station_id) { query += ` AND station_id = $${++p}`; params.push(station_id); }
        if (status) { query += ` AND status = $${++p}`; params.push(status); }
        if (search) {
            p++;
            query += ` AND (customer_name ILIKE $${p} OR account_no ILIKE $${p} OR contact_name ILIKE $${p} OR phone ILIKE $${p})`;
            params.push(`%${search}%`);
        }

        query += ` ORDER BY customer_name LIMIT $${++p} OFFSET $${++p}`;
        params.push(parseInt(limit), parseInt(offset));

        const result = await db.query(query, params);
        res.json({ success: true, count: result.rows.length, debtors: result.rows });
    } catch (error) {
        logger.error('Error fetching debtors', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * @swagger
 * /api/debtors/{id}:
 *   get:
 *     summary: Get a single debtor
 *     tags: [Debtors]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Debtor details
 *       404:
 *         description: Debtor not found
 */
router.get('/:id', async (req, res) => {
    try {
        const result = await db.query(`SELECT ${DEBTOR_FIELDS} FROM debtors WHERE id = $1`, [req.params.id]);
        if (result.rows.length === 0) return res.status(404).json({ error: 'Debtor not found' });
        res.json({ success: true, debtor: result.rows[0] });
    } catch (error) {
        logger.error('Error fetching debtor', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * @swagger
 * /api/debtors:
 *   post:
 *     summary: Create a new debtor
 *     tags: [Debtors]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [company_id, station_id, customer_name]
 *             properties:
 *               company_id:
 *                 type: string
 *                 format: uuid
 *               station_id:
 *                 type: string
 *                 format: uuid
 *               account_no:
 *                 type: string
 *                 description: Unique account number
 *               customer_name:
 *                 type: string
 *                 description: Company or individual name
 *               contact_name:
 *                 type: string
 *               phone:
 *                 type: string
 *               email:
 *                 type: string
 *               address:
 *                 type: string
 *               credit_limit:
 *                 type: number
 *                 default: 0
 *               term_days:
 *                 type: integer
 *                 default: 30
 *     responses:
 *       201:
 *         description: Debtor created
 *       400:
 *         description: Missing required fields
 */
router.post('/', offlineAuthMiddleware, requireRole('admin', 'manager'), async (req, res) => {
    try {
        const {
            company_id, station_id, account_no, customer_name,
            contact_name, phone, email, address,
            credit_limit = 0, term_days = 30
        } = req.body;

        if (!company_id || !station_id || !customer_name) {
            return res.status(400).json({ error: 'Missing required fields: company_id, station_id, customer_name' });
        }

        const result = await db.query(
            `INSERT INTO debtors (company_id, station_id, account_no, customer_name, contact_name,
        phone, email, address, credit_limit, current_balance, term_days, status, created_at, synced)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,0,$10,'active',now(),FALSE)
       RETURNING ${DEBTOR_FIELDS}`,
            [company_id, station_id, account_no || null, customer_name,
                contact_name || null, phone || null, email || null, address || null,
                credit_limit, term_days]
        );

        logger.info(`✅ Created debtor: ${customer_name} (${result.rows[0].id})`);
        res.status(201).json({ success: true, debtor: result.rows[0] });
    } catch (error) {
        if (error.code === '23505') {
            return res.status(409).json({ error: 'Account number already exists' });
        }
        logger.error('Error creating debtor', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * @swagger
 * /api/debtors/{id}:
 *   put:
 *     summary: Update a debtor
 *     tags: [Debtors]
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
 *               account_no:
 *                 type: string
 *               customer_name:
 *                 type: string
 *               contact_name:
 *                 type: string
 *               phone:
 *                 type: string
 *               email:
 *                 type: string
 *               address:
 *                 type: string
 *               credit_limit:
 *                 type: number
 *               term_days:
 *                 type: integer
 *               status:
 *                 type: string
 *                 enum: [active, suspended, closed]
 *     responses:
 *       200:
 *         description: Debtor updated
 *       404:
 *         description: Debtor not found
 */
router.put('/:id', offlineAuthMiddleware, requireRole('admin', 'manager'), async (req, res) => {
    try {
        const { account_no, customer_name, contact_name, phone, email, address,
            credit_limit, term_days, status } = req.body;
        const updates = [];
        const params = [];
        let p = 1;

        if (account_no !== undefined) { updates.push(`account_no = $${p++}`); params.push(account_no); }
        if (customer_name !== undefined) { updates.push(`customer_name = $${p++}`); params.push(customer_name); }
        if (contact_name !== undefined) { updates.push(`contact_name = $${p++}`); params.push(contact_name); }
        if (phone !== undefined) { updates.push(`phone = $${p++}`); params.push(phone); }
        if (email !== undefined) { updates.push(`email = $${p++}`); params.push(email); }
        if (address !== undefined) { updates.push(`address = $${p++}`); params.push(address); }
        if (credit_limit !== undefined) { updates.push(`credit_limit = $${p++}`); params.push(credit_limit); }
        if (term_days !== undefined) { updates.push(`term_days = $${p++}`); params.push(term_days); }
        if (status !== undefined) { updates.push(`status = $${p++}`); params.push(status); }

        if (updates.length === 0) return res.status(400).json({ error: 'No fields to update' });

        updates.push(`synced = FALSE`);

        params.push(req.params.id);
        const query = `UPDATE debtors SET ${updates.join(', ')} WHERE id = $${p} RETURNING ${DEBTOR_FIELDS}`;
        const result = await db.query(query, params);

        if (result.rows.length === 0) return res.status(404).json({ error: 'Debtor not found' });

        logger.info(`✅ Updated debtor: ${result.rows[0].customer_name} (${result.rows[0].id})`);
        res.json({ success: true, debtor: result.rows[0] });
    } catch (error) {
        if (error.code === '23505') {
            return res.status(409).json({ error: 'Account number already exists' });
        }
        logger.error('Error updating debtor', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * @swagger
 * /api/debtors/{id}:
 *   delete:
 *     summary: Delete a debtor (sets status to closed)
 *     tags: [Debtors]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Debtor closed
 *       404:
 *         description: Debtor not found
 */
router.delete('/:id', offlineAuthMiddleware, requireRole('admin'), async (req, res) => {
    try {
        const result = await db.query(
            `UPDATE debtors SET status = 'closed', synced = FALSE WHERE id = $1 RETURNING ${DEBTOR_FIELDS}`,
            [req.params.id]
        );
        if (result.rows.length === 0) return res.status(404).json({ error: 'Debtor not found' });

        logger.info(`✅ Closed debtor: ${result.rows[0].customer_name} (${result.rows[0].id})`);
        res.json({ success: true, message: 'Debtor closed', debtor: result.rows[0] });
    } catch (error) {
        logger.error('Error closing debtor', error);
        res.status(500).json({ error: error.message });
    }
});

/**
 * @swagger
 * /api/debtors/{id}/balance:
 *   post:
 *     summary: Manually adjust debtor balance (payment or correction)
 *     tags: [Debtors]
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
 *             required: [amount, type]
 *             properties:
 *               amount:
 *                 type: number
 *                 description: Amount to add (debit) or subtract (credit)
 *               type:
 *                 type: string
 *                 enum: [payment, correction, fuel_sale]
 *               description:
 *                 type: string
 *     responses:
 *       200:
 *         description: Balance updated
 */
router.post('/:id/balance', offlineAuthMiddleware, requireRole('admin', 'manager'), async (req, res) => {
    try {
        const { amount, type, description } = req.body;

        if (!amount || !type) {
            return res.status(400).json({ error: 'amount and type are required' });
        }

        const debtor = await db.query('SELECT id, customer_name, current_balance FROM debtors WHERE id = $1', [req.params.id]);
        if (debtor.rows.length === 0) return res.status(404).json({ error: 'Debtor not found' });

        let balanceChange;
        if (type === 'payment') {
            // Payment reduces balance
            balanceChange = -Math.abs(parseFloat(amount));
        } else {
            // fuel_sale or correction increases balance
            balanceChange = Math.abs(parseFloat(amount));
        }

        const result = await db.query(
            `UPDATE debtors SET current_balance = current_balance + $1, synced = FALSE WHERE id = $2 RETURNING ${DEBTOR_FIELDS}`,
            [balanceChange, req.params.id]
        );

        logger.info(`✅ Debtor ${req.params.id} balance adjusted by ${balanceChange} (${type})`);

        res.json({
            success: true,
            debtor: result.rows[0],
            adjustment: { amount: balanceChange, type, description }
        });
    } catch (error) {
        logger.error('Error adjusting debtor balance', error);
        res.status(500).json({ error: error.message });
    }
});

module.exports = router;
