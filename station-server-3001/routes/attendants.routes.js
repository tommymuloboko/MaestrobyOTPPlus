const express = require('express');
const logger = require('../utils/logger')('AttendantsRoutes');
const db = require('../utils/db');
const { offlineAuthMiddleware, requireRole } = require('../middleware/offline-auth');

const router = express.Router();

/**
 * @swagger
 * tags:
 *   name: Attendants
 *   description: Attendant management endpoints
 */

const ATTENDANT_FIELDS = `id, company_id, station_id, full_name, phone, email, nrc, country, created_at`;

/**
 * @swagger
 * /api/attendants:
 *   get:
 *     summary: Get all attendants
 *     tags: [Attendants]
 *     parameters:
 *       - in: query
 *         name: company_id
 *         schema:
 *           type: string
 *           format: uuid
 *       - in: query
 *         name: station_id
 *         schema:
 *           type: string
 *           format: uuid
 *       - in: query
 *         name: search
 *         schema:
 *           type: string
 *         description: Search by name, phone, NRC, or email
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
 *         description: List of attendants
 */
router.get('/', async (req, res) => {
  try {
    const { company_id, station_id, search, limit = 100, offset = 0 } = req.query;

    let query = `SELECT ${ATTENDANT_FIELDS} FROM attendants WHERE 1=1`;
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

    if (search) {
      paramCount++;
      query += ` AND (full_name ILIKE $${paramCount} OR phone ILIKE $${paramCount} OR nrc ILIKE $${paramCount} OR email ILIKE $${paramCount})`;
      params.push(`%${search}%`);
    }

    query += ` ORDER BY full_name LIMIT $${++paramCount} OFFSET $${++paramCount}`;
    params.push(parseInt(limit), parseInt(offset));

    const result = await db.query(query, params);

    res.json({
      success: true,
      count: result.rows.length,
      attendants: result.rows
    });
  } catch (error) {
    logger.error('Error fetching attendants', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /api/attendants/{id}:
 *   get:
 *     summary: Get a specific attendant
 *     tags: [Attendants]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     responses:
 *       200:
 *         description: Attendant details
 *       404:
 *         description: Attendant not found
 */
router.get('/:id', async (req, res) => {
  try {
    const result = await db.query(
      `SELECT ${ATTENDANT_FIELDS} FROM attendants WHERE id = $1`,
      [req.params.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Attendant not found' });
    }

    res.json({
      success: true,
      attendant: result.rows[0]
    });
  } catch (error) {
    logger.error('Error fetching attendant', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /api/attendants:
 *   post:
 *     summary: Create a new attendant
 *     tags: [Attendants]
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
 *               - full_name
 *             properties:
 *               company_id:
 *                 type: string
 *                 format: uuid
 *               station_id:
 *                 type: string
 *                 format: uuid
 *               full_name:
 *                 type: string
 *               phone:
 *                 type: string
 *               email:
 *                 type: string
 *               nrc:
 *                 type: string
 *               country:
 *                 type: string
 *                 default: Zambia
 *     responses:
 *       201:
 *         description: Attendant created
 *       400:
 *         description: Missing required fields
 */
router.post('/', offlineAuthMiddleware, async (req, res) => {
  try {
    const { company_id, station_id, full_name, phone, email, nrc, country = 'Zambia' } = req.body;

    if (!company_id || !station_id || !full_name) {
      return res.status(400).json({
        error: 'Missing required fields: company_id, station_id, full_name'
      });
    }

    const result = await db.query(
      `INSERT INTO attendants (company_id, station_id, full_name, phone, email, nrc, country, created_at, synced)
       VALUES ($1, $2, $3, $4, $5, $6, $7, now(), FALSE)
       RETURNING ${ATTENDANT_FIELDS}`,
      [company_id, station_id, full_name, phone || null, email || null, nrc || null, country]
    );

    logger.info(`✅ Created attendant: ${full_name} (${result.rows[0].id})`);

    res.status(201).json({
      success: true,
      attendant: result.rows[0]
    });
  } catch (error) {
    logger.error('Error creating attendant', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /api/attendants/{id}:
 *   put:
 *     summary: Update an attendant
 *     tags: [Attendants]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               full_name:
 *                 type: string
 *               phone:
 *                 type: string
 *               email:
 *                 type: string
 *               nrc:
 *                 type: string
 *               country:
 *                 type: string
 *     responses:
 *       200:
 *         description: Attendant updated
 *       400:
 *         description: No fields to update
 *       404:
 *         description: Attendant not found
 */
router.put('/:id', offlineAuthMiddleware, async (req, res) => {
  try {
    const { full_name, phone, email, nrc, country } = req.body;
    const updates = [];
    const params = [];
    let paramCount = 1;

    if (full_name !== undefined) {
      updates.push(`full_name = $${paramCount++}`);
      params.push(full_name);
    }

    if (phone !== undefined) {
      updates.push(`phone = $${paramCount++}`);
      params.push(phone);
    }

    if (email !== undefined) {
      updates.push(`email = $${paramCount++}`);
      params.push(email);
    }

    if (nrc !== undefined) {
      updates.push(`nrc = $${paramCount++}`);
      params.push(nrc);
    }

    if (country !== undefined) {
      updates.push(`country = $${paramCount++}`);
      params.push(country);
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'No fields to update' });
    }

    // Mark as unsynced so it gets pushed to Supabase
    updates.push(`synced = FALSE`);

    params.push(req.params.id);
    const query = `UPDATE attendants SET ${updates.join(', ')} WHERE id = $${paramCount} RETURNING ${ATTENDANT_FIELDS}`;

    const result = await db.query(query, params);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Attendant not found' });
    }

    logger.info(`✅ Updated attendant: ${result.rows[0].full_name} (${result.rows[0].id})`);

    res.json({
      success: true,
      attendant: result.rows[0]
    });
  } catch (error) {
    logger.error('Error updating attendant', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /api/attendants/{id}:
 *   delete:
 *     summary: Delete an attendant
 *     tags: [Attendants]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     responses:
 *       200:
 *         description: Attendant deleted
 *       404:
 *         description: Attendant not found
 */
router.delete('/:id', offlineAuthMiddleware, async (req, res) => {
  try {
    // Remove references in related tables first so FK constraints don't block the delete
    await db.query(`DELETE FROM attendant_tags WHERE attendant_id = $1`, [req.params.id]).catch(() => {});
    await db.query(`UPDATE shift_attendants SET attendant_id = NULL WHERE attendant_id = $1`, [req.params.id]).catch(() => {});
    await db.query(`UPDATE attendant_shifts SET attendant_id = NULL WHERE attendant_id = $1`, [req.params.id]).catch(() => {});

    const result = await db.query(
      `DELETE FROM attendants WHERE id = $1 RETURNING ${ATTENDANT_FIELDS}`,
      [req.params.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Attendant not found', message: 'Attendant not found' });
    }

    logger.info(`✅ Deleted attendant: ${result.rows[0].full_name} (${result.rows[0].id})`);

    res.json({
      success: true,
      message: 'Attendant deleted',
      attendant: result.rows[0]
    });
  } catch (error) {
    logger.error('Error deleting attendant', error);
    const msg = error.code === '23503'
      ? 'Cannot delete attendant — they are still referenced by other records'
      : error.message;
    res.status(500).json({ error: msg, message: msg });
  }
});

module.exports = router;
