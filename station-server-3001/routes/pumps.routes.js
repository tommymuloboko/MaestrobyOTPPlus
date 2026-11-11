const express = require('express');
const logger = require('../utils/logger')('PumpsRoutes');
const db = require('../utils/db');
const { offlineAuthMiddleware, requireRole } = require('../middleware/offline-auth');

const router = express.Router();

/**
 * @swagger
 * tags:
 *   name: Pumps
 *   description: Pump management endpoints
 */

/**
 * @swagger
 * /api/pumps:
 *   get:
 *     summary: Get all pumps
 *     description: Retrieve a list of all pumps with optional filtering by station, active status, and pagination
 *     tags: [Pumps]
 *     parameters:
 *       - in: query
 *         name: station_id
 *         schema:
 *           type: string
 *           format: uuid
 *         description: Filter pumps by station ID
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
 *         description: Maximum number of pumps to return
 *       - in: query
 *         name: offset
 *         schema:
 *           type: integer
 *           default: 0
 *         description: Number of pumps to skip for pagination
 *     responses:
 *       200:
 *         description: List of pumps retrieved successfully
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
 *                   description: Number of pumps returned
 *                 pumps:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       id:
 *                         type: string
 *                         format: uuid
 *                       station_id:
 *                         type: string
 *                         format: uuid
 *                       name:
 *                         type: string
 *                       pts2_pump_id:
 *                         type: integer
 *                       is_active:
 *                         type: boolean
 *                       created_at:
 *                         type: string
 *                         format: date-time
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
    const { station_id, is_active, limit = 100, offset = 0 } = req.query;

    let query = 'SELECT id, station_id, pts2_pump_id, name, is_active FROM pumps WHERE 1=1';
    const params = [];
    let paramCount = 0;

    if (station_id) {
      paramCount++;
      query += ` AND station_id = $${paramCount}`;
      params.push(station_id);
    }

    if (is_active !== undefined) {
      paramCount++;
      query += ` AND is_active = $${paramCount}`;
      params.push(is_active === 'true');
    }

    query += ` ORDER BY pts2_pump_id LIMIT $${++paramCount} OFFSET $${++paramCount}`;
    params.push(parseInt(limit), parseInt(offset));

    const result = await db.query(query, params);

    res.json({
      success: true,
      count: result.rows.length,
      pumps: result.rows
    });
  } catch (error) {
    logger.error('Error fetching pumps', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /api/pumps/{id}:
 *   get:
 *     summary: Get a specific pump
 *     description: Retrieve detailed information about a specific pump by its ID
 *     tags: [Pumps]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *         description: The pump ID
 *     responses:
 *       200:
 *         description: Pump retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 pump:
 *                   type: object
 *                   properties:
 *                     id:
 *                       type: string
 *                       format: uuid
 *                     station_id:
 *                       type: string
 *                       format: uuid
 *                     name:
 *                       type: string
 *                     pts2_pump_id:
 *                       type: integer
 *                     is_active:
 *                       type: boolean
 *                     created_at:
 *                       type: string
 *                       format: date-time
 *       404:
 *         description: Pump not found
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                   example: Pump not found
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
router.get('/:id', async (req, res) => {
  try {
    const result = await db.query(
      'SELECT id, station_id, pts2_pump_id, name, is_active FROM pumps WHERE id = $1',
      [req.params.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Pump not found' });
    }

    res.json({
      success: true,
      pump: result.rows[0]
    });
  } catch (error) {
    logger.error('Error fetching pump', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /api/pumps:
 *   post:
 *     summary: Create a new pump
 *     description: Create a new pump record. Requires admin or manager role.
 *     tags: [Pumps]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - station_id
 *               - name
 *               - pts2_pump_id
 *             properties:
 *               station_id:
 *                 type: string
 *                 format: uuid
 *                 description: The station this pump belongs to
 *               name:
 *                 type: string
 *                 description: Display name for the pump
 *               pts2_pump_id:
 *                 type: integer
 *                 description: PTS2 system pump identifier
 *     responses:
 *       201:
 *         description: Pump created successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 pump:
 *                   type: object
 *                   properties:
 *                     id:
 *                       type: string
 *                       format: uuid
 *                     station_id:
 *                       type: string
 *                       format: uuid
 *                     name:
 *                       type: string
 *                     pts2_pump_id:
 *                       type: integer
 *                     is_active:
 *                       type: boolean
 *                     created_at:
 *                       type: string
 *                       format: date-time
 *       400:
 *         description: Missing required fields
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                   example: "Missing required fields: station_id, name, pts2_pump_id"
 *       401:
 *         description: Unauthorized - Invalid or missing authentication
 *       403:
 *         description: Forbidden - Insufficient permissions
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
router.post('/', offlineAuthMiddleware, requireRole('admin', 'manager'), async (req, res) => {
  try {
    const { station_id, name, pts2_pump_id } = req.body;

    if (!station_id || !name || !pts2_pump_id) {
      return res.status(400).json({
        error: 'Missing required fields: station_id, name, pts2_pump_id'
      });
    }

    const result = await db.query(
      `INSERT INTO pumps (station_id, pts2_pump_id, name, is_active, synced)
       VALUES ($1, $2, $3, true, FALSE)
       RETURNING id, station_id, pts2_pump_id, name, is_active`,
      [station_id, pts2_pump_id, name]
    );

    logger.info(`✅ Created pump: ${result.rows[0].name} (${result.rows[0].pts2_pump_id})`);

    res.status(201).json({
      success: true,
      pump: result.rows[0]
    });
  } catch (error) {
    logger.error('Error creating pump', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /api/pumps/{id}:
 *   put:
 *     summary: Update a pump
 *     description: Update an existing pump's information. Requires admin or manager role.
 *     tags: [Pumps]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *         description: The pump ID to update
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               name:
 *                 type: string
 *                 description: Display name for the pump
 *               pts2_pump_id:
 *                 type: integer
 *                 description: PTS2 system pump identifier
 *               is_active:
 *                 type: boolean
 *                 description: Whether the pump is active
 *     responses:
 *       200:
 *         description: Pump updated successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 pump:
 *                   type: object
 *                   properties:
 *                     id:
 *                       type: string
 *                       format: uuid
 *                     station_id:
 *                       type: string
 *                       format: uuid
 *                     name:
 *                       type: string
 *                     pts2_pump_id:
 *                       type: integer
 *                     is_active:
 *                       type: boolean
 *                     created_at:
 *                       type: string
 *                       format: date-time
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
 *         description: Forbidden - Insufficient permissions
 *       404:
 *         description: Pump not found
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                   example: Pump not found
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
    const { name, pts2_pump_id, is_active } = req.body;
    const updates = [];
    const params = [];
    let paramCount = 1;

    if (name !== undefined) {
      updates.push(`name = $${paramCount++}`);
      params.push(name);
    }
    if (pts2_pump_id !== undefined) {
      updates.push(`pts2_pump_id = $${paramCount++}`);
      params.push(pts2_pump_id);
    }
    if (is_active !== undefined) {
      updates.push(`is_active = $${paramCount++}`);
      params.push(is_active);
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'No fields to update' });
    }

    updates.push(`synced = FALSE`);

    params.push(req.params.id);
    const query = `UPDATE pumps SET ${updates.join(', ')} WHERE id = $${paramCount} RETURNING *`;

    const result = await db.query(query, params);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Pump not found' });
    }

    logger.info(`✅ Updated pump: ${result.rows[0].name}`);

    res.json({
      success: true,
      pump: result.rows[0]
    });
  } catch (error) {
    logger.error('Error updating pump', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /api/pumps/{id}:
 *   delete:
 *     summary: Delete a pump
 *     description: Delete a pump record. Requires admin role.
 *     tags: [Pumps]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *         description: The pump ID to delete
 *     responses:
 *       200:
 *         description: Pump deleted successfully
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
 *                   example: Pump deleted
 *       401:
 *         description: Unauthorized - Invalid or missing authentication
 *       403:
 *         description: Forbidden - Insufficient permissions
 *       404:
 *         description: Pump not found
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                   example: Pump not found
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
      'DELETE FROM pumps WHERE id = $1 RETURNING *',
      [req.params.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Pump not found' });
    }

    logger.info(`✅ Deleted pump: ${result.rows[0].name}`);

    res.json({
      success: true,
      message: 'Pump deleted'
    });
  } catch (error) {
    logger.error('Error deleting pump', error);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
