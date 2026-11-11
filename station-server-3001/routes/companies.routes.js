const express = require('express');
const logger = require('../utils/logger')('CompaniesRoutes');
const db = require('../utils/db');
const { offlineAuthMiddleware, requireRole } = require('../middleware/offline-auth');

const router = express.Router();

/**
 * @swagger
 * tags:
 *   name: Companies
 *   description: Company management endpoints
 */

/**
 * @swagger
 * /api/companies:
 *   get:
 *     summary: Get all companies
 *     tags: [Companies]
 *     parameters:
 *       - in: query
 *         name: is_active
 *         schema:
 *           type: boolean
 *         description: Filter by active status
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 100
 *         description: Maximum results to return
 *       - in: query
 *         name: offset
 *         schema:
 *           type: integer
 *           default: 0
 *         description: Number of results to skip
 *     responses:
 *       200:
 *         description: List of companies
 */
router.get('/', async (req, res) => {
  try {
    const { limit = 100, offset = 0 } = req.query;

    let query = 'SELECT id, name, code, created_at FROM companies WHERE 1=1';
    const params = [];
    let paramCount = 0;

    query += ` ORDER BY name LIMIT $${++paramCount} OFFSET $${++paramCount}`;
    params.push(parseInt(limit), parseInt(offset));

    const result = await db.query(query, params);

    res.json({
      success: true,
      count: result.rows.length,
      companies: result.rows
    });
  } catch (error) {
    logger.error('Error fetching companies', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /api/companies/{id}:
 *   get:
 *     summary: Get a specific company
 *     tags: [Companies]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *         description: Company ID
 *     responses:
 *       200:
 *         description: Company details
 *       404:
 *         description: Company not found
 */
router.get('/:id', async (req, res) => {
  try {
    const result = await db.query(
      'SELECT id, name, code, created_at FROM companies WHERE id = $1',
      [req.params.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Company not found' });
    }

    res.json({
      success: true,
      company: result.rows[0]
    });
  } catch (error) {
    logger.error('Error fetching company', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /api/companies:
 *   post:
 *     summary: Create a new company
 *     tags: [Companies]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - name
 *               - code
 *             properties:
 *               name:
 *                 type: string
 *               code:
 *                 type: string
 *     responses:
 *       201:
 *         description: Company created
 *       400:
 *         description: Missing required fields
 */
router.post('/', offlineAuthMiddleware, requireRole('admin'), async (req, res) => {
  try {
    const { name, code } = req.body;

    if (!name || !code) {
      return res.status(400).json({
        error: 'Missing required fields: name, code'
      });
    }

    const result = await db.query(
      `INSERT INTO companies (name, code, created_at, synced)
       VALUES ($1, $2, now(), FALSE)
       RETURNING id, name, code, created_at`,
      [name, code]
    );

    logger.info(`✅ Created company: ${result.rows[0].name} (${result.rows[0].code})`);

    res.status(201).json({
      success: true,
      company: result.rows[0]
    });
  } catch (error) {
    logger.error('Error creating company', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /api/companies/{id}:
 *   put:
 *     summary: Update a company
 *     tags: [Companies]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               name:
 *                 type: string
 *               code:
 *                 type: string
 *               is_active:
 *                 type: boolean
 *     responses:
 *       200:
 *         description: Company updated
 *       404:
 *         description: Company not found
 */
router.put('/:id', offlineAuthMiddleware, requireRole('admin'), async (req, res) => {
  try {
    const { name, code } = req.body;
    const updates = [];
    const params = [];
    let paramCount = 1;

    if (name !== undefined) {
      updates.push(`name = $${paramCount++}`);
      params.push(name);
    }
    if (code !== undefined) {
      updates.push(`code = $${paramCount++}`);
      params.push(code);
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'No fields to update' });
    }

    updates.push(`synced = FALSE`);

    params.push(req.params.id);
    const query = `UPDATE companies SET ${updates.join(', ')} WHERE id = $${paramCount} RETURNING *`;

    const result = await db.query(query, params);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Company not found' });
    }

    logger.info(`✅ Updated company: ${result.rows[0].name}`);

    res.json({
      success: true,
      company: result.rows[0]
    });
  } catch (error) {
    logger.error('Error updating company', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /api/companies/{id}:
 *   delete:
 *     summary: Delete a company (soft delete)
 *     tags: [Companies]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     responses:
 *       200:
 *         description: Company deleted
 *       404:
 *         description: Company not found
 */
router.delete('/:id', offlineAuthMiddleware, requireRole('admin'), async (req, res) => {
  try {
    const result = await db.query(
      'UPDATE companies SET is_active = false, synced = FALSE WHERE id = $1 RETURNING *',
      [req.params.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Company not found' });
    }

    logger.info(`✅ Deleted company: ${result.rows[0].name}`);

    res.json({
      success: true,
      message: 'Company deleted'
    });
  } catch (error) {
    logger.error('Error deleting company', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /api/companies/{id}/stations:
 *   get:
 *     summary: Get all stations for a company
 *     tags: [Companies]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *         description: Company ID
 *     responses:
 *       200:
 *         description: List of stations for the company
 */
router.get('/:id/stations', async (req, res) => {
  try {
    const result = await db.query(
      'SELECT id, company_id, name, code, location, is_active FROM stations WHERE company_id = $1 ORDER BY name',
      [req.params.id]
    );

    res.json({
      success: true,
      count: result.rows.length,
      stations: result.rows
    });
  } catch (error) {
    logger.error('Error fetching company stations', error);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
