const express = require('express');
const logger = require('../utils/logger')('StationsRoutes');
const db = require('../utils/db');
const { offlineAuthMiddleware, requireRole } = require('../middleware/offline-auth');

const router = express.Router();

/**
 * @swagger
 * tags:
 *   name: Stations
 *   description: Station management endpoints
 */

/**
 * @swagger
 * /api/stations:
 *   get:
 *     summary: Get all stations with optional filters
 *     tags: [Stations]
 *     parameters:
 *       - in: query
 *         name: company_id
 *         schema:
 *           type: string
 *           format: uuid
 *         description: Filter by company ID
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
 *         description: Maximum number of stations to return
 *       - in: query
 *         name: offset
 *         schema:
 *           type: integer
 *           default: 0
 *         description: Number of stations to skip
 *     responses:
 *       200:
 *         description: List of stations
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 count:
 *                   type: integer
 *                 stations:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       id:
 *                         type: string
 *                         format: uuid
 *                       company_id:
 *                         type: string
 *                         format: uuid
 *                       name:
 *                         type: string
 *                       code:
 *                         type: string
 *                       location:
 *                         type: string
 *                       is_active:
 *                         type: boolean
 *                       pts_hostname:
 *                         type: string
 *                       pts_port:
 *                         type: integer
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
    const { company_id, is_active, limit = 100, offset = 0 } = req.query;

    let query = 'SELECT id, company_id, name, code, timezone, location, station_url, is_active, created_at FROM stations WHERE 1=1';
    const params = [];
    let paramCount = 0;

    if (company_id) {
      paramCount++;
      query += ` AND company_id = $${paramCount}`;
      params.push(company_id);
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
      stations: result.rows
    });
  } catch (error) {
    logger.error('Error fetching stations', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /api/stations/{id}:
 *   get:
 *     summary: Get a specific station by ID
 *     tags: [Stations]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *         description: Station ID
 *     responses:
 *       200:
 *         description: Station details
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 station:
 *                   type: object
 *                   properties:
 *                     id:
 *                       type: string
 *                       format: uuid
 *                     company_id:
 *                       type: string
 *                       format: uuid
 *                     name:
 *                       type: string
 *                     code:
 *                       type: string
 *                     location:
 *                       type: string
 *                     is_active:
 *                       type: boolean
 *                     pts_hostname:
 *                       type: string
 *                     pts_port:
 *                       type: integer
 *                     config:
 *                       type: object
 *                     created_at:
 *                       type: string
 *                       format: date-time
 *       404:
 *         description: Station not found
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
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
      'SELECT id, company_id, name, code, timezone, location, station_url, is_active, created_at FROM stations WHERE id = $1',
      [req.params.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Station not found' });
    }

    res.json({
      success: true,
      station: result.rows[0]
    });
  } catch (error) {
    logger.error('Error fetching station', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /api/stations:
 *   post:
 *     summary: Create a new station
 *     tags: [Stations]
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
 *               - name
 *               - code
 *             properties:
 *               company_id:
 *                 type: string
 *                 format: uuid
 *                 description: Company ID the station belongs to
 *               name:
 *                 type: string
 *                 description: Station name
 *               code:
 *                 type: string
 *                 description: Unique station code
 *               location:
 *                 type: string
 *                 description: Station location/address
 *               pts_hostname:
 *                 type: string
 *                 description: PTS server hostname
 *               pts_port:
 *                 type: integer
 *                 description: PTS server port
 *     responses:
 *       201:
 *         description: Station created successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 station:
 *                   type: object
 *                   properties:
 *                     id:
 *                       type: string
 *                       format: uuid
 *                     company_id:
 *                       type: string
 *                       format: uuid
 *                     name:
 *                       type: string
 *                     code:
 *                       type: string
 *                     location:
 *                       type: string
 *                     pts_hostname:
 *                       type: string
 *                     pts_port:
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
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Forbidden - requires admin role
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
router.post('/', offlineAuthMiddleware, requireRole('admin'), async (req, res) => {
  try {
    const { company_id, name, code, timezone, location, station_url } = req.body;

    if (!company_id || !name || !code) {
      return res.status(400).json({
        error: 'Missing required fields: company_id, name, code'
      });
    }

    const result = await db.query(
      `INSERT INTO stations (company_id, name, code, timezone, location, station_url, is_active, created_at, synced)
       VALUES ($1, $2, $3, $4, $5, $6, true, now(), FALSE)
       RETURNING id, company_id, name, code, timezone, location, station_url, is_active, created_at`,
      [company_id, name, code, timezone || null, location || null, station_url || null]
    );

    logger.info(`✅ Created station: ${result.rows[0].name} (${result.rows[0].code})`);

    res.status(201).json({
      success: true,
      station: result.rows[0]
    });
  } catch (error) {
    logger.error('Error creating station', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /api/stations/{id}:
 *   put:
 *     summary: Update a station
 *     tags: [Stations]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *         description: Station ID
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               name:
 *                 type: string
 *                 description: Station name
 *               code:
 *                 type: string
 *                 description: Unique station code
 *               location:
 *                 type: string
 *                 description: Station location/address
 *               pts_hostname:
 *                 type: string
 *                 description: PTS server hostname
 *               pts_port:
 *                 type: integer
 *                 description: PTS server port
 *               is_active:
 *                 type: boolean
 *                 description: Whether the station is active
 *     responses:
 *       200:
 *         description: Station updated successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 station:
 *                   type: object
 *                   properties:
 *                     id:
 *                       type: string
 *                       format: uuid
 *                     company_id:
 *                       type: string
 *                       format: uuid
 *                     name:
 *                       type: string
 *                     code:
 *                       type: string
 *                     location:
 *                       type: string
 *                     pts_hostname:
 *                       type: string
 *                     pts_port:
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
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Forbidden - requires admin or manager role
 *       404:
 *         description: Station not found
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
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
    const { name, code, timezone, location, station_url, is_active } = req.body;
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
    if (timezone !== undefined) {
      updates.push(`timezone = $${paramCount++}`);
      params.push(timezone);
    }
    if (location !== undefined) {
      updates.push(`location = $${paramCount++}`);
      params.push(location);
    }
    if (station_url !== undefined) {
      updates.push(`station_url = $${paramCount++}`);
      params.push(station_url);
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
    const query = `UPDATE stations SET ${updates.join(', ')} WHERE id = $${paramCount} RETURNING *`;

    const result = await db.query(query, params);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Station not found' });
    }

    logger.info(`✅ Updated station: ${result.rows[0].name}`);

    res.json({
      success: true,
      station: result.rows[0]
    });
  } catch (error) {
    logger.error('Error updating station', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /api/stations/{id}:
 *   delete:
 *     summary: Delete a station (soft delete)
 *     tags: [Stations]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *         description: Station ID
 *     responses:
 *       200:
 *         description: Station deleted successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 message:
 *                   type: string
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Forbidden - requires admin role
 *       404:
 *         description: Station not found
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: string
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
      'UPDATE stations SET is_active = false, synced = FALSE WHERE id = $1 RETURNING *',
      [req.params.id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Station not found' });
    }

    logger.info(`✅ Deleted station: ${result.rows[0].name}`);

    res.json({
      success: true,
      message: 'Station deleted'
    });
  } catch (error) {
    logger.error('Error deleting station', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /api/stations/{id}/pumps:
 *   get:
 *     summary: Get all pumps for a station
 *     tags: [Stations]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *         description: Station ID
 *     responses:
 *       200:
 *         description: List of pumps for the station
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 count:
 *                   type: integer
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
router.get('/:id/pumps', async (req, res) => {
  try {
    const result = await db.query(
      'SELECT id, station_id, name, pts2_pump_id, is_active FROM pumps WHERE station_id = $1 ORDER BY pts2_pump_id',
      [req.params.id]
    );

    res.json({
      success: true,
      count: result.rows.length,
      pumps: result.rows
    });
  } catch (error) {
    logger.error('Error fetching station pumps', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /api/stations/{id}/tanks:
 *   get:
 *     summary: Get all tanks for a station
 *     tags: [Stations]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *         description: Station ID
 *     responses:
 *       200:
 *         description: List of tanks for the station
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 count:
 *                   type: integer
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
router.get('/:id/tanks', async (req, res) => {
  try {
    const result = await db.query(
      'SELECT id, station_id, name, product, capacity, is_active FROM tanks WHERE station_id = $1 ORDER BY name',
      [req.params.id]
    );

    res.json({
      success: true,
      count: result.rows.length,
      tanks: result.rows
    });
  } catch (error) {
    logger.error('Error fetching station tanks', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /api/stations/{id}/attendant-shifts:
 *   get:
 *     summary: Get all attendant shifts for a station
 *     tags: [Stations]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *         description: Station ID
 *       - in: query
 *         name: is_open
 *         schema:
 *           type: boolean
 *         description: Filter by open shifts only
 *       - in: query
 *         name: is_ended
 *         schema:
 *           type: boolean
 *         description: Filter by ended shifts
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 100
 *         description: Maximum number of shifts to return
 *       - in: query
 *         name: offset
 *         schema:
 *           type: integer
 *           default: 0
 *         description: Number of shifts to skip
 *     responses:
 *       200:
 *         description: List of attendant shifts for the station
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 count:
 *                   type: integer
 *                 shifts:
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
 *                       attendant_id:
 *                         type: string
 *                         format: uuid
 *                       attendant_no:
 *                         type: string
 *                       attendant_name:
 *                         type: string
 *                       tag_number:
 *                         type: string
 *                       started_at:
 *                         type: string
 *                         format: date-time
 *                       ended_at:
 *                         type: string
 *                         format: date-time
 *                       is_open:
 *                         type: boolean
 *                       is_ended:
 *                         type: boolean
 *                       is_verified:
 *                         type: boolean
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
router.get('/:id/attendant-shifts', async (req, res) => {
  try {
    const { is_open, is_ended, limit = 100, offset = 0 } = req.query;

    let query = `
      SELECT s.id, s.company_id, s.station_id, s.attendant_id, s.tag_number,
             s.started_at, s.ended_at, s.is_open, s.is_ended, s.is_pending_verification,
             s.is_verified, s.is_disputed, s.created_at,
             a.full_name as attendant_name
      FROM attendant_shifts s
      LEFT JOIN attendants a ON s.attendant_id = a.id
      WHERE s.station_id = $1
    `;
    const params = [req.params.id];
    let paramCount = 1;

    if (is_open !== undefined) {
      paramCount++;
      query += ` AND s.is_open = $${paramCount}`;
      params.push(is_open === 'true');
    }

    if (is_ended !== undefined) {
      paramCount++;
      query += ` AND s.is_ended = $${paramCount}`;
      params.push(is_ended === 'true');
    }

    query += ` ORDER BY s.started_at DESC LIMIT $${++paramCount} OFFSET $${++paramCount}`;
    params.push(parseInt(limit), parseInt(offset));

    const result = await db.query(query, params);

    res.json({
      success: true,
      count: result.rows.length,
      shifts: result.rows
    });
  } catch (error) {
    logger.error('Error fetching station attendant shifts', error);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
