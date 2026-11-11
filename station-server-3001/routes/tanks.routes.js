const express = require('express');
const logger = require('../utils/logger')('TanksRoutes');
const db = require('../utils/db');
const { offlineAuthMiddleware, requireRole } = require('../middleware/offline-auth');

const router = express.Router();

/**
 * @swagger
 * tags:
 *   name: Tanks
 *   description: Tank management endpoints
 */

/**
 * @swagger
 * /api/tanks:
 *   get:
 *     summary: Get all tanks
 *     description: Retrieve a list of tanks with optional filters for station, fuel type, and active status
 *     tags: [Tanks]
 *     parameters:
 *       - in: query
 *         name: station_id
 *         schema:
 *           type: string
 *           format: uuid
 *         description: Filter by station ID
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
 *         description: Maximum number of tanks to return
 *       - in: query
 *         name: offset
 *         schema:
 *           type: integer
 *           default: 0
 *         description: Number of tanks to skip for pagination
 *     responses:
 *       200:
 *         description: List of tanks retrieved successfully
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
 *                   description: Number of tanks returned
 *                 tanks:
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
 *                       product:
 *                         type: string
 *                       capacity:
 *                         type: number
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

    let query = 'SELECT id, station_id, pts2_tank_id, name, fuel_grade, capacity_liters, is_active FROM tanks WHERE 1=1';
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

    query += ` ORDER BY name LIMIT $${++paramCount} OFFSET $${++paramCount}`;
    params.push(parseInt(limit), parseInt(offset));

    const result = await db.query(query, params);

    res.json({
      success: true,
      count: result.rows.length,
      tanks: result.rows
    });
  } catch (error) {
    logger.error('Error fetching tanks', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /api/tanks/{id}:
 *   get:
 *     summary: Get a specific tank
 *     description: Retrieve details of a single tank by its ID
 *     tags: [Tanks]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *         description: The tank ID
 *     responses:
 *       200:
 *         description: Tank details retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 tank:
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
 *                     product:
 *                       type: string
 *                     capacity:
 *                       type: number
 *                     is_active:
 *                       type: boolean
 *                     created_at:
 *                       type: string
 *                       format: date-time
 *       404:
 *         description: Tank not found
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                   example: Tank not found
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
      'SELECT id, station_id, pts2_tank_id, name, fuel_grade, capacity_liters, is_active FROM tanks WHERE id = $1',
      [req.params.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Tank not found' });
    }

    res.json({
      success: true,
      tank: result.rows[0]
    });
  } catch (error) {
    logger.error('Error fetching tank', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /api/tanks:
 *   post:
 *     summary: Create a new tank
 *     description: Create a new tank record. Requires admin or manager role.
 *     tags: [Tanks]
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
 *               - product
 *               - capacity
 *             properties:
 *               station_id:
 *                 type: string
 *                 format: uuid
 *                 description: The ID of the station this tank belongs to
 *               name:
 *                 type: string
 *                 description: Tank name/identifier (e.g., "Tank 1")
 *               product:
 *                 type: string
 *                 description: Fuel type stored in the tank (e.g., "Diesel", "Petrol")
 *               capacity:
 *                 type: number
 *                 description: Maximum capacity of the tank in liters
 *     responses:
 *       201:
 *         description: Tank created successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 tank:
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
 *                     product:
 *                       type: string
 *                     capacity:
 *                       type: number
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
 *                   example: "Missing required fields: station_id, name, product, capacity"
 *       401:
 *         description: Unauthorized - Invalid or missing token
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
    const { station_id, pts2_tank_id, name, fuel_grade, capacity_liters } = req.body;

    if (!station_id || !pts2_tank_id) {
      return res.status(400).json({
        error: 'Missing required fields: station_id, pts2_tank_id'
      });
    }

    const result = await db.query(
      `INSERT INTO tanks (station_id, pts2_tank_id, name, fuel_grade, capacity_liters, is_active)
       VALUES ($1, $2, $3, $4, $5, true)
       RETURNING id, station_id, pts2_tank_id, name, fuel_grade, capacity_liters, is_active`,
      [station_id, pts2_tank_id, name || null, fuel_grade || null, capacity_liters || null]
    );

    logger.info(`✅ Created tank: ${result.rows[0].name} (${result.rows[0].fuel_grade})`);

    res.status(201).json({
      success: true,
      tank: result.rows[0]
    });
  } catch (error) {
    logger.error('Error creating tank', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /api/tanks/{id}:
 *   put:
 *     summary: Update a tank
 *     description: Update an existing tank's details. Requires admin or manager role.
 *     tags: [Tanks]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *         description: The tank ID
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               name:
 *                 type: string
 *                 description: Tank name/identifier
 *               product:
 *                 type: string
 *                 description: Fuel type stored in the tank
 *               capacity:
 *                 type: number
 *                 description: Maximum capacity of the tank in liters
 *               is_active:
 *                 type: boolean
 *                 description: Whether the tank is active
 *     responses:
 *       200:
 *         description: Tank updated successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 tank:
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
 *                     product:
 *                       type: string
 *                     capacity:
 *                       type: number
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
 *         description: Unauthorized - Invalid or missing token
 *       403:
 *         description: Forbidden - Insufficient permissions
 *       404:
 *         description: Tank not found
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                   example: Tank not found
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
    const { name, fuel_grade, capacity_liters, is_active } = req.body;
    const updates = [];
    const params = [];
    let paramCount = 1;

    if (name !== undefined) {
      updates.push(`name = $${paramCount++}`);
      params.push(name);
    }
    if (fuel_grade !== undefined) {
      updates.push(`fuel_grade = $${paramCount++}`);
      params.push(fuel_grade);
    }
    if (capacity_liters !== undefined) {
      updates.push(`capacity_liters = $${paramCount++}`);
      params.push(capacity_liters);
    }
    if (is_active !== undefined) {
      updates.push(`is_active = $${paramCount++}`);
      params.push(is_active);
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'No fields to update' });
    }

    params.push(req.params.id);
    const query = `UPDATE tanks SET ${updates.join(', ')} WHERE id = $${paramCount} RETURNING *`;

    const result = await db.query(query, params);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Tank not found' });
    }

    logger.info(`✅ Updated tank: ${result.rows[0].name}`);

    res.json({
      success: true,
      tank: result.rows[0]
    });
  } catch (error) {
    logger.error('Error updating tank', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /api/tanks/{id}:
 *   delete:
 *     summary: Delete a tank
 *     description: Delete a tank from the system. Requires admin role.
 *     tags: [Tanks]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *         description: The tank ID
 *     responses:
 *       200:
 *         description: Tank deleted successfully
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
 *                   example: Tank deleted
 *       401:
 *         description: Unauthorized - Invalid or missing token
 *       403:
 *         description: Forbidden - Insufficient permissions
 *       404:
 *         description: Tank not found
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
 *                   example: Tank not found
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
      'DELETE FROM tanks WHERE id = $1 RETURNING *',
      [req.params.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Tank not found' });
    }

    logger.info(`✅ Deleted tank: ${result.rows[0].name}`);

    res.json({
      success: true,
      message: 'Tank deleted'
    });
  } catch (error) {
    logger.error('Error deleting tank', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /api/tanks/{id}/readings:
 *   get:
 *     summary: Get tank readings
 *     description: Retrieve the dip reading/measurement history for a specific tank
 *     tags: [Tanks]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *         description: The tank ID
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 50
 *         description: Maximum number of readings to return
 *       - in: query
 *         name: offset
 *         schema:
 *           type: integer
 *           default: 0
 *         description: Number of readings to skip for pagination
 *     responses:
 *       200:
 *         description: Tank readings retrieved successfully
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
 *                   description: Number of readings returned
 *                 readings:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       id:
 *                         type: string
 *                         format: uuid
 *                       tank_id:
 *                         type: string
 *                         format: uuid
 *                       reading:
 *                         type: number
 *                         description: The tank level reading in liters
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
router.get('/:id/readings', async (req, res) => {
  try {
    const { limit = 50, offset = 0 } = req.query;

    const result = await db.query(
      `SELECT id, tank_id, reading, created_at
       FROM tank_readings
       WHERE tank_id = $1
       ORDER BY created_at DESC
       LIMIT $2 OFFSET $3`,
      [req.params.id, parseInt(limit), parseInt(offset)]
    );

    res.json({
      success: true,
      count: result.rows.length,
      readings: result.rows
    });
  } catch (error) {
    logger.error('Error fetching tank readings', error);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
