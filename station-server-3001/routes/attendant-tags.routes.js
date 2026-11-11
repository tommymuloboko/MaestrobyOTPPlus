/**
 * Attendant Tags Routes
 * RFID tag assignment and management for attendants
 */

const express = require('express');
const logger = require('../utils/logger')('AttendantTagsRoutes');
const db = require('../utils/db');
const { offlineAuthMiddleware, requireRole } = require('../middleware/offline-auth');

const router = express.Router();

/**
 * @swagger
 * tags:
 *   name: AttendantTags
 *   description: RFID tag management for attendants
 */

/**
 * @swagger
 * /api/attendant-tags:
 *   post:
 *     summary: Issue / Assign a tag to an attendant
 *     description: Assigns an RFID tag to an attendant. Auto-revokes any existing active tag for this attendant.
 *     tags: [AttendantTags]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - attendant_id
 *               - station_id
 *               - tag_number
 *             properties:
 *               attendant_id:
 *                 type: string
 *                 format: uuid
 *               station_id:
 *                 type: string
 *                 format: uuid
 *               tag_number:
 *                 type: string
 *                 description: The RFID tag number (must be globally unique)
 *     responses:
 *       201:
 *         description: Tag assigned successfully
 *       400:
 *         description: Missing required fields or validation error
 *       404:
 *         description: Attendant or station not found
 *       409:
 *         description: Tag already assigned to another attendant
 *       500:
 *         description: Server error
 */
router.post('/', offlineAuthMiddleware, requireRole('admin', 'manager'), async (req, res) => {
  try {
    const { attendant_id, station_id, tag_number } = req.body;

    // Validate required fields
    if (!attendant_id || !station_id || !tag_number) {
      return res.status(400).json({
        error: true,
        message: 'Missing required fields: attendant_id, station_id, tag_number'
      });
    }

    // Check if attendant exists
    const attendantCheck = await db.query(
      'SELECT id, station_id FROM attendants WHERE id = $1',
      [attendant_id]
    );

    if (attendantCheck.rows.length === 0) {
      return res.status(404).json({
        error: true,
        message: 'Attendant not found'
      });
    }

    // Check if station exists
    const stationCheck = await db.query(
      'SELECT id FROM stations WHERE id = $1',
      [station_id]
    );

    if (stationCheck.rows.length === 0) {
      return res.status(404).json({
        error: true,
        message: 'Station not found'
      });
    }

    // Check if tag_number is already active for another attendant
    const tagCheck = await db.query(
      'SELECT id, attendant_id FROM attendant_tags WHERE tag_number = $1 AND is_active = true',
      [tag_number.toUpperCase()]
    );

    if (tagCheck.rows.length > 0) {
      return res.status(409).json({
        error: true,
        message: 'Tag is already assigned to another attendant',
        existing_tag_id: tagCheck.rows[0].id
      });
    }

    // Auto-revoke any existing active tag for this attendant
    await db.query(
      `UPDATE attendant_tags 
       SET is_active = false, revoked_at = NOW() 
       WHERE attendant_id = $1 AND is_active = true`,
      [attendant_id]
    );

    // Insert new tag assignment
    const result = await db.query(
      `INSERT INTO attendant_tags (attendant_id, station_id, tag_number, is_active, issued_at, revoked_at)
       VALUES ($1, $2, $3, true, NOW(), NULL)
       RETURNING id, attendant_id, station_id, tag_number, is_active, issued_at, revoked_at`,
      [attendant_id, station_id, tag_number.toUpperCase()]
    );

    const tag = result.rows[0];

    logger.info(`✅ Assigned tag ${tag_number} to attendant ${attendant_id}`);

    res.status(201).json({
      error: false,
      data: {
        id: tag.id,
        attendant_id: tag.attendant_id,
        station_id: tag.station_id,
        tag_number: tag.tag_number,
        is_active: tag.is_active,
        issued_at: tag.issued_at,
        revoked_at: tag.revoked_at
      }
    });

  } catch (error) {
    logger.error('Error assigning tag', error);
    res.status(500).json({
      error: true,
      message: error.message
    });
  }
});

/**
 * @swagger
 * /api/attendant-tags:
 *   get:
 *     summary: List all tags (with optional filters)
 *     description: Returns a list of attendant tags, optionally filtered by station, attendant, or active status
 *     tags: [AttendantTags]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: station_id
 *         schema:
 *           type: string
 *           format: uuid
 *         description: Filter by station ID
 *       - in: query
 *         name: attendant_id
 *         schema:
 *           type: string
 *           format: uuid
 *         description: Filter by attendant ID
 *       - in: query
 *         name: active
 *         schema:
 *           type: boolean
 *         description: Filter by active status (true/false)
 *     responses:
 *       200:
 *         description: List of tags
 *       500:
 *         description: Server error
 */
router.get('/', offlineAuthMiddleware, async (req, res) => {
  try {
    const { station_id, attendant_id, active } = req.query;

    let query = `
      SELECT t.id, t.attendant_id, t.station_id, t.tag_number, t.is_active, t.issued_at, t.revoked_at,
             a.attendant_no, e.full_name as attendant_name
      FROM attendant_tags t
      LEFT JOIN attendants a ON t.attendant_id = a.id
      LEFT JOIN employees e ON a.employee_id = e.id
      WHERE 1=1
    `;
    const params = [];
    let paramCount = 0;

    if (station_id) {
      paramCount++;
      query += ` AND t.station_id = $${paramCount}`;
      params.push(station_id);
    }

    if (attendant_id) {
      paramCount++;
      query += ` AND t.attendant_id = $${paramCount}`;
      params.push(attendant_id);
    }

    if (active !== undefined) {
      paramCount++;
      query += ` AND t.is_active = $${paramCount}`;
      params.push(active === 'true');
    }

    query += ' ORDER BY t.issued_at DESC';

    const result = await db.query(query, params);

    res.json({
      error: false,
      data: result.rows
    });

  } catch (error) {
    logger.error('Error listing tags', error);
    res.status(500).json({
      error: true,
      message: error.message
    });
  }
});

/**
 * @swagger
 * /api/attendant-tags/{tagId}:
 *   get:
 *     summary: Get a single tag by ID
 *     description: Returns details of a specific tag
 *     tags: [AttendantTags]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: tagId
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     responses:
 *       200:
 *         description: Tag details
 *       404:
 *         description: Tag not found
 *       500:
 *         description: Server error
 */
router.get('/:tagId', offlineAuthMiddleware, async (req, res) => {
  try {
    const { tagId } = req.params;

    const result = await db.query(
      `SELECT t.id, t.attendant_id, t.station_id, t.tag_number, t.is_active, t.issued_at, t.revoked_at,
              a.attendant_no, e.full_name as attendant_name
       FROM attendant_tags t
       LEFT JOIN attendants a ON t.attendant_id = a.id
       LEFT JOIN employees e ON a.employee_id = e.id
       WHERE t.id = $1`,
      [tagId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        error: true,
        message: 'Tag not found'
      });
    }

    res.json({
      error: false,
      data: result.rows[0]
    });

  } catch (error) {
    logger.error('Error fetching tag', error);
    res.status(500).json({
      error: true,
      message: error.message
    });
  }
});

/**
 * @swagger
 * /api/attendant-tags/{tagId}/revoke:
 *   post:
 *     summary: Revoke / disable a tag
 *     description: Sets the tag as inactive and records revoked_at timestamp
 *     tags: [AttendantTags]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: tagId
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     responses:
 *       200:
 *         description: Tag revoked successfully
 *       400:
 *         description: Tag is already revoked
 *       404:
 *         description: Tag not found
 *       500:
 *         description: Server error
 */
router.post('/:tagId/revoke', offlineAuthMiddleware, requireRole('admin', 'manager'), async (req, res) => {
  try {
    const { tagId } = req.params;

    // Check if tag exists and is active
    const tagCheck = await db.query(
      'SELECT id, is_active FROM attendant_tags WHERE id = $1',
      [tagId]
    );

    if (tagCheck.rows.length === 0) {
      return res.status(404).json({
        error: true,
        message: 'Tag not found'
      });
    }

    if (!tagCheck.rows[0].is_active) {
      return res.status(400).json({
        error: true,
        message: 'Tag is already revoked'
      });
    }

    // Revoke the tag
    const result = await db.query(
      `UPDATE attendant_tags 
       SET is_active = false, revoked_at = NOW()
       WHERE id = $1
       RETURNING id, attendant_id, station_id, tag_number, is_active, issued_at, revoked_at`,
      [tagId]
    );

    const tag = result.rows[0];

    logger.info(`✅ Revoked tag ${tag.tag_number} (${tagId})`);

    res.json({
      error: false,
      data: {
        id: tag.id,
        attendant_id: tag.attendant_id,
        station_id: tag.station_id,
        tag_number: tag.tag_number,
        is_active: tag.is_active,
        issued_at: tag.issued_at,
        revoked_at: tag.revoked_at
      }
    });

  } catch (error) {
    logger.error('Error revoking tag', error);
    res.status(500).json({
      error: true,
      message: error.message
    });
  }
});

/**
 * @swagger
 * /api/attendant-tags/{tagId}/activate:
 *   post:
 *     summary: Reactivate a revoked tag
 *     description: Reactivates a previously revoked tag. Auto-revokes any other active tag for the same attendant.
 *     tags: [AttendantTags]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: tagId
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     responses:
 *       200:
 *         description: Tag reactivated successfully
 *       400:
 *         description: Tag is already active or tag_number conflict
 *       404:
 *         description: Tag not found
 *       500:
 *         description: Server error
 */
router.post('/:tagId/activate', offlineAuthMiddleware, requireRole('admin', 'manager'), async (req, res) => {
  try {
    const { tagId } = req.params;

    // Check if tag exists
    const tagCheck = await db.query(
      'SELECT id, attendant_id, tag_number, is_active FROM attendant_tags WHERE id = $1',
      [tagId]
    );

    if (tagCheck.rows.length === 0) {
      return res.status(404).json({
        error: true,
        message: 'Tag not found'
      });
    }

    const tag = tagCheck.rows[0];

    if (tag.is_active) {
      return res.status(400).json({
        error: true,
        message: 'Tag is already active'
      });
    }

    // Check if tag_number is already active for another attendant
    const conflictCheck = await db.query(
      'SELECT id FROM attendant_tags WHERE tag_number = $1 AND is_active = true AND id != $2',
      [tag.tag_number, tagId]
    );

    if (conflictCheck.rows.length > 0) {
      return res.status(400).json({
        error: true,
        message: 'This tag number is currently active for another attendant'
      });
    }

    // Auto-revoke any other active tag for this attendant
    await db.query(
      `UPDATE attendant_tags 
       SET is_active = false, revoked_at = NOW() 
       WHERE attendant_id = $1 AND is_active = true AND id != $2`,
      [tag.attendant_id, tagId]
    );

    // Reactivate the tag (do NOT change issued_at)
    const result = await db.query(
      `UPDATE attendant_tags 
       SET is_active = true, revoked_at = NULL
       WHERE id = $1
       RETURNING id, attendant_id, station_id, tag_number, is_active, issued_at, revoked_at`,
      [tagId]
    );

    const reactivatedTag = result.rows[0];

    logger.info(`✅ Reactivated tag ${reactivatedTag.tag_number} (${tagId})`);

    res.json({
      error: false,
      data: {
        id: reactivatedTag.id,
        attendant_id: reactivatedTag.attendant_id,
        station_id: reactivatedTag.station_id,
        tag_number: reactivatedTag.tag_number,
        is_active: reactivatedTag.is_active,
        issued_at: reactivatedTag.issued_at,
        revoked_at: reactivatedTag.revoked_at
      }
    });

  } catch (error) {
    logger.error('Error activating tag', error);
    res.status(500).json({
      error: true,
      message: error.message
    });
  }
});

module.exports = router;
