const express = require('express');
const logger = require('../utils/logger')('RFIDRoutes');
const db = require('../utils/db');

const router = express.Router();

/**
 * @swagger
 * tags:
 *   name: RFID
 *   description: RFID reader and tag management
 */

// ============================================
// RFID Readers
// ============================================

/**
 * @swagger
 * /api/rfid/readers:
 *   get:
 *     summary: Get all RFID readers with assigned pumps
 *     tags: [RFID]
 *     responses:
 *       200:
 *         description: List of RFID readers
 */
router.get('/readers', async (req, res) => {
  try {
    const result = await db.query(`
      SELECT 
        r.reader_id, 
        r.company_id,
        r.station_id,
        r.reader_name, 
        r.ip_address, 
        r.port, 
        r.device_address,
        r.pump_ids,
        r.location,
        r.is_active,
        r.created_at,
        r.updated_at
      FROM rfid_readers r
      ORDER BY r.reader_id
    `);

    res.json({
      success: true,
      count: result.rows.length,
      readers: result.rows
    });
  } catch (error) {
    logger.error('Error fetching readers', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * @swagger
 * /api/rfid/readers:
 *   post:
 *     summary: Add a new RFID reader
 *     tags: [RFID]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - reader_name
 *               - ip_address
 *             properties:
 *               reader_name:
 *                 type: string
 *               ip_address:
 *                 type: string
 *               port:
 *                 type: integer
 *                 default: 9761
 *               pump_ids:
 *                 type: array
 *                 items:
 *                   type: integer
 *                 description: Nozzle-pump IDs this reader covers (e.g. [1,2,3] for a 3-nozzle pump)
 *               location:
 *                 type: string
 *     responses:
 *       201:
 *         description: Reader created
 */
router.post('/readers', async (req, res) => {
  try {
    const { reader_name, ip_address, port = 8080, pump_ids, device_address = 0, location } = req.body;
    const company_id = process.env.OFFLINE_COMPANY_ID;
    const station_id = process.env.OFFLINE_STATION_ID;

    if (!reader_name || !ip_address || !pump_ids || !Array.isArray(pump_ids) || pump_ids.length === 0) {
      return res.status(400).json({ 
        success: false, 
        error: 'reader_name, ip_address and pump_ids (non-empty array) are required' 
      });
    }

    // Insert reader with pump_ids array
    const result = await db.query(`
      INSERT INTO rfid_readers (company_id, station_id, reader_name, ip_address, port, device_address, pump_ids, location)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      ON CONFLICT (ip_address, port) DO UPDATE SET
        reader_name = EXCLUDED.reader_name,
        device_address = EXCLUDED.device_address,
        pump_ids = EXCLUDED.pump_ids,
        location = EXCLUDED.location,
        updated_at = NOW()
      RETURNING *
    `, [company_id, station_id, reader_name, ip_address, port, device_address, pump_ids, location]);

    const reader = result.rows[0];

    // Reload RFID service to pick up new reader
    try {
      const rfidService = require('../services/rfid-reader.service');
      await rfidService.reloadReaders();
    } catch (e) {
      logger.warn('Could not reload RFID service:', e.message);
    }

    res.status(201).json({
      success: true,
      message: `Reader created: ${reader.reader_name} (${reader.ip_address}) → Pumps [${pump_ids.join(',')}]`,
      reader
    });
  } catch (error) {
    logger.error('Error creating reader', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * @swagger
 * /api/rfid/readers/{id}:
 *   put:
 *     summary: Update an RFID reader (change pump assignments, name, location, etc.)
 *     tags: [RFID]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               reader_name:
 *                 type: string
 *               ip_address:
 *                 type: string
 *               port:
 *                 type: integer
 *               device_address:
 *                 type: integer
 *               pump_ids:
 *                 type: array
 *                 items: { type: integer }
 *                 description: Set the pump IDs this reader covers
 *               location:
 *                 type: string
 *               is_active:
 *                 type: boolean
 *     responses:
 *       200:
 *         description: Reader updated
 */
router.put('/readers/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { reader_name, ip_address, port, device_address, pump_ids, location, is_active } = req.body;

    // Build dynamic SET clause from provided fields
    const updates = [];
    const params = [];
    let paramCount = 0;

    if (reader_name !== undefined) { params.push(reader_name); updates.push(`reader_name = $${++paramCount}`); }
    if (ip_address !== undefined) { params.push(ip_address); updates.push(`ip_address = $${++paramCount}`); }
    if (port !== undefined) { params.push(port); updates.push(`port = $${++paramCount}`); }
    if (device_address !== undefined) { params.push(device_address); updates.push(`device_address = $${++paramCount}`); }
    if (pump_ids !== undefined) { params.push(pump_ids); updates.push(`pump_ids = $${++paramCount}`); }
    if (location !== undefined) { params.push(location); updates.push(`location = $${++paramCount}`); }
    if (is_active !== undefined) { params.push(is_active); updates.push(`is_active = $${++paramCount}`); }

    if (updates.length === 0) {
      return res.status(400).json({ success: false, error: 'No fields to update' });
    }

    updates.push(`updated_at = NOW()`);
    params.push(id);

    const result = await db.query(`
      UPDATE rfid_readers 
      SET ${updates.join(', ')}
      WHERE reader_id = $${++paramCount}
      RETURNING *
    `, params);

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Reader not found' });
    }

    const reader = result.rows[0];
    logger.info(`Reader ${reader.reader_id} updated: ${reader.reader_name} → Pumps [${reader.pump_ids}]`);

    // Reload RFID service to pick up changes
    try {
      const rfidService = require('../services/rfid-reader.service');
      if (rfidService.reloadReaders) await rfidService.reloadReaders();
    } catch (e) {
      logger.warn('Could not reload RFID service:', e.message);
    }

    res.json({
      success: true,
      message: `Reader updated: ${reader.reader_name} → Pumps [${reader.pump_ids}]`,
      reader
    });
  } catch (error) {
    logger.error('Error updating reader', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * @swagger
 * /api/rfid/readers/bulk:
 *   post:
 *     summary: Register multiple RFID readers at once (1:1 reader-to-pump)
 *     tags: [RFID]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - readers
 *             properties:
 *               readers:
 *                 type: array
 *                 items:
 *                   type: object
 *                   required:
 *                     - reader_name
 *                     - ip_address
 *                     - pump_id
 *                   properties:
 *                     reader_name:
 *                       type: string
 *                     ip_address:
 *                       type: string
 *                     port:
 *                       type: integer
 *                       default: 8080
 *                     device_address:
 *                       type: integer
 *                       default: 0
 *                       description: IS8540 station ID (0x00 for standalone)
 *                     pump_ids:
 *                       type: array
 *                       items:
 *                         type: integer
 *                       description: Nozzle-pump IDs this reader covers
 *                     location:
 *                       type: string
 *     responses:
 *       201:
 *         description: Readers registered
 */
router.post('/readers/bulk', async (req, res) => {
  try {
    const { readers } = req.body;
    const company_id = process.env.OFFLINE_COMPANY_ID;
    const station_id = process.env.OFFLINE_STATION_ID;

    if (!Array.isArray(readers) || readers.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'readers array is required and must not be empty'
      });
    }

    // Validate all entries first
    for (let i = 0; i < readers.length; i++) {
      const r = readers[i];
      if (!r.reader_name || !r.ip_address || !r.pump_ids || !Array.isArray(r.pump_ids) || r.pump_ids.length === 0) {
        return res.status(400).json({
          success: false,
          error: `Reader at index ${i} is missing required fields (reader_name, ip_address, pump_ids array)`
        });
      }
    }

    const registered = [];
    const errors = [];

    for (const r of readers) {
      try {
        const result = await db.query(`
          INSERT INTO rfid_readers (company_id, station_id, reader_name, ip_address, port, device_address, pump_ids, location)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
          ON CONFLICT (ip_address, port) DO UPDATE SET
            reader_name = EXCLUDED.reader_name,
            device_address = EXCLUDED.device_address,
            pump_ids = EXCLUDED.pump_ids,
            location = EXCLUDED.location,
            is_active = true,
            updated_at = NOW()
          RETURNING *
        `, [
          company_id, station_id,
          r.reader_name, r.ip_address,
          r.port || 8080, r.device_address || 0,
          r.pump_ids, r.location || null
        ]);

        registered.push(result.rows[0]);
      } catch (err) {
        errors.push({ reader_name: r.reader_name, ip_address: r.ip_address, error: err.message });
      }
    }

    // Reload RFID service to connect to all new readers
    try {
      const rfidService = require('../services/rfid-reader.service');
      await rfidService.reloadReaders();
    } catch (e) {
      logger.warn('Could not reload RFID service:', e.message);
    }

    res.status(201).json({
      success: errors.length === 0,
      message: `${registered.length}/${readers.length} readers registered`,
      registered: registered.map(r => ({
        reader_id: r.reader_id,
        reader_name: r.reader_name,
        ip_address: r.ip_address,
        port: r.port,
        device_address: r.device_address,
        pump_ids: r.pump_ids
      })),
      errors: errors.length > 0 ? errors : undefined
    });
  } catch (error) {
    logger.error('Error bulk registering readers', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * @swagger
 * /api/rfid/readers/test:
 *   post:
 *     summary: Test TCP connection to a reader before registering
 *     tags: [RFID]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - ip_address
 *             properties:
 *               ip_address:
 *                 type: string
 *               port:
 *                 type: integer
 *                 default: 8080
 *     responses:
 *       200:
 *         description: Connection test result
 */
router.post('/readers/test', async (req, res) => {
  try {
    const { ip_address, port = 8080 } = req.body;

    if (!ip_address) {
      return res.status(400).json({ success: false, error: 'ip_address is required' });
    }

    const rfidService = require('../services/rfid-reader.service');
    const result = await rfidService.testConnection(ip_address, port);

    res.json({
      success: result.success,
      ip_address,
      port,
      message: result.success
        ? `Reader at ${ip_address}:${port} is reachable`
        : `Cannot reach reader at ${ip_address}:${port}: ${result.error}`,
      error: result.error || undefined
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * @swagger
 * /api/rfid/readers/{id}:
 *   put:
 *     summary: Update an RFID reader
 *     tags: [RFID]
 */
router.put('/readers/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { reader_name, ip_address, port, location, is_active, pump_ids, device_address } = req.body;

    const result = await db.query(`
      UPDATE rfid_readers SET
        reader_name = COALESCE($1, reader_name),
        ip_address = COALESCE($2, ip_address),
        port = COALESCE($3, port),
        location = COALESCE($4, location),
        is_active = COALESCE($5, is_active),
        pump_ids = COALESCE($6, pump_ids),
        device_address = COALESCE($7, device_address),
        updated_at = NOW()
      WHERE reader_id = $8
      RETURNING *
    `, [reader_name, ip_address, port, location, is_active, pump_ids, device_address, id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Reader not found' });
    }

    // Reload RFID service
    try {
      const rfidService = require('../services/rfid-reader.service');
      await rfidService.reloadReaders();
    } catch (e) {
      logger.warn('Could not reload RFID service:', e.message);
    }

    res.json({ success: true, reader: result.rows[0] });
  } catch (error) {
    logger.error('Error updating reader', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * @swagger
 * /api/rfid/readers/{id}:
 *   delete:
 *     summary: Delete an RFID reader
 *     tags: [RFID]
 */
router.delete('/readers/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const result = await db.query(`
      DELETE FROM rfid_readers WHERE reader_id = $1 RETURNING *
    `, [id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Reader not found' });
    }

    // Reload RFID service
    try {
      const rfidService = require('../services/rfid-reader.service');
      await rfidService.reloadReaders();
    } catch (e) {
      logger.warn('Could not reload RFID service:', e.message);
    }

    res.json({ success: true, message: 'Reader deleted' });
  } catch (error) {
    logger.error('Error deleting reader', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================
// Reader-Pump Assignment (1:1)
// ============================================

/**
 * @swagger
 * /api/rfid/readers/{id}/pump:
 *   get:
 *     summary: Get the nozzle-pumps assigned to a reader
 *     tags: [RFID]
 */
router.get('/readers/:id/pump', async (req, res) => {
  try {
    const { id } = req.params;

    const result = await db.query(`
      SELECT reader_id, reader_name, pump_ids, ip_address, port
      FROM rfid_readers
      WHERE reader_id = $1
    `, [id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Reader not found' });
    }

    res.json({
      success: true,
      reader_id: parseInt(id),
      pump_ids: result.rows[0].pump_ids || []
    });
  } catch (error) {
    logger.error('Error fetching reader pumps', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// Keep legacy endpoint for backward compatibility
router.get('/readers/:id/pumps', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await db.query(
      'SELECT reader_id, pump_ids FROM rfid_readers WHERE reader_id = $1',
      [id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Reader not found' });
    }
    const pumpIds = result.rows[0].pump_ids || [];
    res.json({
      success: true,
      reader_id: parseInt(id),
      pumps: pumpIds.map(pid => ({ pump_id: pid, is_active: true }))
    });
  } catch (error) {
    logger.error('Error fetching reader pumps', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * @swagger
 * /api/rfid/readers/{id}/pump:
 *   put:
 *     summary: Reassign nozzle-pumps for a reader
 *     tags: [RFID]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - pump_ids
 *             properties:
 *               pump_ids:
 *                 type: array
 *                 items:
 *                   type: integer
 *     responses:
 *       200:
 *         description: Pumps reassigned
 */
router.put('/readers/:id/pump', async (req, res) => {
  try {
    const { id } = req.params;
    const { pump_ids } = req.body;

    if (!pump_ids || !Array.isArray(pump_ids) || pump_ids.length === 0) {
      return res.status(400).json({ 
        success: false, 
        error: 'pump_ids (non-empty array) is required' 
      });
    }

    const result = await db.query(`
      UPDATE rfid_readers SET pump_ids = $1, updated_at = NOW()
      WHERE reader_id = $2
      RETURNING *
    `, [pump_ids, id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Reader not found' });
    }

    // Reload RFID service
    try {
      const rfidService = require('../services/rfid-reader.service');
      await rfidService.reloadReaders();
    } catch (e) {
      logger.warn('Could not reload RFID service:', e.message);
    }

    res.json({
      success: true,
      message: `Reader ${id} now covers pumps [${pump_ids.join(',')}]`,
      reader: result.rows[0]
    });
  } catch (error) {
    logger.error('Error reassigning pumps', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================
// RFID Tags (tag inventory — register, assign, deactivate)
// ============================================

/**
 * @swagger
 * /api/rfid/tags:
 *   get:
 *     summary: List all registered RFID tags
 *     tags: [RFID]
 *     parameters:
 *       - in: query
 *         name: is_active
 *         schema: { type: boolean }
 *       - in: query
 *         name: assigned
 *         schema: { type: boolean }
 *         description: Filter assigned (true) or unassigned (false) tags
 *     responses:
 *       200:
 *         description: List of RFID tags
 */
router.get('/tags', async (req, res) => {
  try {
    const { is_active, assigned } = req.query;
    const stationId = process.env.OFFLINE_STATION_ID;

    let query = `
      SELECT 
        t.id, t.tag_number, t.label, t.is_active,
        t.attendant_id, t.assigned_at, t.deactivated_at, t.notes,
        t.registered_at, t.created_at,
        a.full_name as attendant_name
      FROM rfid_tags t
      LEFT JOIN attendants a ON t.attendant_id = a.id
      WHERE t.station_id = $1
    `;
    const params = [stationId];
    let paramCount = 1;

    if (is_active !== undefined) {
      params.push(is_active === 'true');
      query += ` AND t.is_active = $${++paramCount}`;
    }

    if (assigned === 'true') {
      query += ` AND t.attendant_id IS NOT NULL`;
    } else if (assigned === 'false') {
      query += ` AND t.attendant_id IS NULL`;
    }

    query += ` ORDER BY t.created_at DESC`;

    const result = await db.query(query, params);

    res.json({
      success: true,
      count: result.rows.length,
      tags: result.rows
    });
  } catch (error) {
    logger.error('Error fetching tags', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * @swagger
 * /api/rfid/tags:
 *   post:
 *     summary: Register a new RFID tag
 *     tags: [RFID]
 *     description: Registers a physical RFID tag into the system. The tag can be assigned to an attendant later.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - tag_number
 *             properties:
 *               tag_number:
 *                 type: string
 *                 description: Hex UID from the RFID card (e.g. "4A00E005")
 *               label:
 *                 type: string
 *                 description: Friendly label for the tag (e.g. "Blue Card #12")
 *               notes:
 *                 type: string
 *     responses:
 *       201:
 *         description: Tag registered
 *       409:
 *         description: Tag already registered at this station
 */
router.post('/tags', async (req, res) => {
  try {
    const { tag_number, label, notes } = req.body;
    const companyId = process.env.OFFLINE_COMPANY_ID;
    const stationId = process.env.OFFLINE_STATION_ID;

    if (!tag_number) {
      return res.status(400).json({ success: false, error: 'tag_number is required' });
    }

    const normalizedTag = tag_number.toUpperCase().trim();

    // Check if already registered at this station
    const existing = await db.query(
      `SELECT id, tag_number, attendant_id FROM rfid_tags WHERE UPPER(tag_number) = $1 AND station_id = $2`,
      [normalizedTag, stationId]
    );

    if (existing.rows.length > 0) {
      return res.status(409).json({
        success: false,
        error: `Tag ${normalizedTag} is already registered at this station`,
        existing_tag: existing.rows[0]
      });
    }

    const result = await db.query(`
      INSERT INTO rfid_tags (tag_number, label, company_id, station_id, notes, registered_at)
      VALUES ($1, $2, $3, $4, $5, NOW())
      RETURNING *
    `, [normalizedTag, label || null, companyId, stationId, notes || null]);

    res.status(201).json({
      success: true,
      message: `Tag ${normalizedTag} registered`,
      tag: result.rows[0]
    });
  } catch (error) {
    logger.error('Error registering tag', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * @swagger
 * /api/rfid/tags/bulk:
 *   post:
 *     summary: Register multiple RFID tags at once
 *     tags: [RFID]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - tags
 *             properties:
 *               tags:
 *                 type: array
 *                 items:
 *                   type: object
 *                   required:
 *                     - tag_number
 *                   properties:
 *                     tag_number:
 *                       type: string
 *                     label:
 *                       type: string
 *     responses:
 *       201:
 *         description: Tags registered
 */
router.post('/tags/bulk', async (req, res) => {
  try {
    const { tags } = req.body;
    const companyId = process.env.OFFLINE_COMPANY_ID;
    const stationId = process.env.OFFLINE_STATION_ID;

    if (!Array.isArray(tags) || tags.length === 0) {
      return res.status(400).json({ success: false, error: 'tags array is required and must not be empty' });
    }

    const registered = [];
    const errors = [];

    for (const t of tags) {
      if (!t.tag_number) {
        errors.push({ tag_number: t.tag_number, error: 'tag_number is required' });
        continue;
      }

      const normalizedTag = t.tag_number.toUpperCase().trim();

      try {
        const result = await db.query(`
          INSERT INTO rfid_tags (tag_number, label, company_id, station_id, registered_at)
          VALUES ($1, $2, $3, $4, NOW())
          ON CONFLICT (UPPER(tag_number), station_id) DO NOTHING
          RETURNING *
        `, [normalizedTag, t.label || null, companyId, stationId]);

        if (result.rows.length > 0) {
          registered.push(result.rows[0]);
        } else {
          errors.push({ tag_number: normalizedTag, error: 'Already registered' });
        }
      } catch (err) {
        errors.push({ tag_number: normalizedTag, error: err.message });
      }
    }

    res.status(201).json({
      success: errors.length === 0,
      message: `${registered.length}/${tags.length} tags registered`,
      registered,
      errors: errors.length > 0 ? errors : undefined
    });
  } catch (error) {
    logger.error('Error bulk registering tags', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * @swagger
 * /api/rfid/tags/{id}:
 *   get:
 *     summary: Get a single tag by ID
 *     tags: [RFID]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200:
 *         description: Tag details
 */
router.get('/tags/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const result = await db.query(`
      SELECT 
        t.*, 
        a.full_name as attendant_name
      FROM rfid_tags t
      LEFT JOIN attendants a ON t.attendant_id = a.id
      WHERE t.id = $1
    `, [id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Tag not found' });
    }

    res.json({ success: true, tag: result.rows[0] });
  } catch (error) {
    logger.error('Error fetching tag', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * @swagger
 * /api/rfid/tags/{id}/assign:
 *   put:
 *     summary: Assign a tag to an attendant
 *     tags: [RFID]
 *     description: |
 *       Assigns this tag to an attendant. If the attendant already has a different active tag,
 *       it will be unassigned first. Useful when an attendant is fired — unassign their tag
 *       and assign it to the replacement.
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - attendant_id
 *             properties:
 *               attendant_id:
 *                 type: string
 *                 format: uuid
 *     responses:
 *       200:
 *         description: Tag assigned to attendant
 */
router.put('/tags/:id/assign', async (req, res) => {
  try {
    const { id } = req.params;
    const { attendant_id } = req.body;

    if (!attendant_id) {
      return res.status(400).json({ success: false, error: 'attendant_id is required' });
    }

    // Check tag exists
    const tag = await db.query('SELECT * FROM rfid_tags WHERE id = $1', [id]);
    if (tag.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Tag not found' });
    }

    if (!tag.rows[0].is_active) {
      return res.status(400).json({ success: false, error: 'Cannot assign an inactive tag. Reactivate it first.' });
    }

    // Check attendant exists
    const attendant = await db.query('SELECT id, full_name FROM attendants WHERE id = $1', [attendant_id]);
    if (attendant.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Attendant not found' });
    }

    // Unassign any other active tag this attendant currently has at this station
    await db.query(
      `UPDATE rfid_tags SET attendant_id = NULL, assigned_at = NULL, updated_at = NOW()
       WHERE attendant_id = $1 AND station_id = $2 AND id != $3`,
      [attendant_id, tag.rows[0].station_id, id]
    );

    // Assign the tag
    const result = await db.query(`
      UPDATE rfid_tags SET 
        attendant_id = $1, 
        assigned_at = NOW(), 
        updated_at = NOW()
      WHERE id = $2
      RETURNING *
    `, [attendant_id, id]);

    // Also update attendants.tag_number for backward compatibility
    await db.query(
      'UPDATE attendants SET tag_number = $1 WHERE id = $2',
      [tag.rows[0].tag_number, attendant_id]
    );

    const att = attendant.rows[0];
    res.json({
      success: true,
      message: `Tag ${tag.rows[0].tag_number} assigned to ${att.full_name}`,
      tag: result.rows[0]
    });
  } catch (error) {
    logger.error('Error assigning tag', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * @swagger
 * /api/rfid/tags/{id}/unassign:
 *   put:
 *     summary: Unassign a tag from its current attendant
 *     tags: [RFID]
 *     description: Removes the attendant assignment. The tag stays registered and can be reassigned.
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200:
 *         description: Tag unassigned
 */
router.put('/tags/:id/unassign', async (req, res) => {
  try {
    const { id } = req.params;

    const tag = await db.query('SELECT * FROM rfid_tags WHERE id = $1', [id]);
    if (tag.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Tag not found' });
    }

    const oldAttendantId = tag.rows[0].attendant_id;

    const result = await db.query(`
      UPDATE rfid_tags SET 
        attendant_id = NULL, 
        assigned_at = NULL, 
        updated_at = NOW()
      WHERE id = $1
      RETURNING *
    `, [id]);

    // Clear attendants.tag_number for backward compat
    if (oldAttendantId) {
      await db.query(
        'UPDATE attendants SET tag_number = NULL WHERE id = $1 AND tag_number = $2',
        [oldAttendantId, tag.rows[0].tag_number]
      );
    }

    res.json({
      success: true,
      message: `Tag ${tag.rows[0].tag_number} unassigned`,
      tag: result.rows[0]
    });
  } catch (error) {
    logger.error('Error unassigning tag', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * @swagger
 * /api/rfid/tags/{id}/status:
 *   put:
 *     summary: Activate or deactivate a tag
 *     tags: [RFID]
 *     description: |
 *       Deactivate a tag if it's lost or stolen. Reactivate when recovered.
 *       Deactivating a tag also prevents it from being used for scanning.
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: integer }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - is_active
 *             properties:
 *               is_active:
 *                 type: boolean
 *               reason:
 *                 type: string
 *                 description: Reason for status change (e.g. "lost", "recovered", "stolen")
 *     responses:
 *       200:
 *         description: Tag status updated
 */
router.put('/tags/:id/status', async (req, res) => {
  try {
    const { id } = req.params;
    const { is_active, reason } = req.body;

    if (is_active === undefined) {
      return res.status(400).json({ success: false, error: 'is_active (boolean) is required' });
    }

    const tag = await db.query('SELECT * FROM rfid_tags WHERE id = $1', [id]);
    if (tag.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Tag not found' });
    }

    const updates = {
      is_active: is_active === true,
      deactivated_at: is_active ? null : new Date(),
      notes: reason ? `${tag.rows[0].notes ? tag.rows[0].notes + ' | ' : ''}${is_active ? 'Reactivated' : 'Deactivated'}: ${reason}` : tag.rows[0].notes,
      updated_at: new Date()
    };

    const result = await db.query(`
      UPDATE rfid_tags SET 
        is_active = $1, 
        deactivated_at = $2, 
        notes = $3, 
        updated_at = $4
      WHERE id = $5
      RETURNING *
    `, [updates.is_active, updates.deactivated_at, updates.notes, updates.updated_at, id]);

    res.json({
      success: true,
      message: `Tag ${tag.rows[0].tag_number} is now ${updates.is_active ? 'ACTIVE' : 'INACTIVE'}`,
      tag: result.rows[0]
    });
  } catch (error) {
    logger.error('Error updating tag status', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * @swagger
 * /api/rfid/tags/{id}:
 *   delete:
 *     summary: Delete an RFID tag
 *     description: Permanently removes an RFID tag from the system. The tag must be unassigned or inactive before deletion, unless force=true is provided.
 *     tags: [RFID]
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *         description: Tag ID
 *       - in: query
 *         name: force
 *         schema:
 *           type: boolean
 *           default: false
 *         description: Force delete even if tag is assigned to an attendant
 *     responses:
 *       200:
 *         description: Tag deleted successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 message:
 *                   type: string
 *                 tag:
 *                   type: object
 *       404:
 *         description: Tag not found
 *       409:
 *         description: Tag is assigned to an attendant (use force=true to override)
 */
router.delete('/tags/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const force = req.query.force === 'true';

    const tag = await db.query('SELECT * FROM rfid_tags WHERE id = $1', [id]);
    if (tag.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Tag not found' });
    }

    const tagData = tag.rows[0];

    // Safety check: don't delete assigned tags unless forced
    if (tagData.attendant_id && !force) {
      return res.status(409).json({
        success: false,
        error: `Tag ${tagData.tag_number} is assigned to an attendant. Unassign first or use ?force=true`,
        tag_number: tagData.tag_number,
        attendant_id: tagData.attendant_id
      });
    }

    const result = await db.query('DELETE FROM rfid_tags WHERE id = $1 RETURNING *', [id]);

    res.json({
      success: true,
      message: `Tag ${tagData.tag_number} deleted`,
      tag: result.rows[0]
    });
  } catch (error) {
    logger.error('Error deleting tag', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================
// Station Mode (RFID vs Manual)
// ============================================

/**
 * @swagger
 * /api/rfid/mode:
 *   get:
 *     summary: Get current station attendant mode (rfid or manual)
 *     tags: [RFID]
 *     description: |
 *       In RFID mode, attendants scan their card to be associated with pump transactions.
 *       In manual mode, attendants are manually assigned to pumps by the manager.
 *     responses:
 *       200:
 *         description: Current mode
 */
router.get('/mode', async (req, res) => {
  try {
    const stationId = process.env.OFFLINE_STATION_ID;

    const result = await db.query(
      'SELECT attendant_mode FROM station_settings WHERE station_id = $1',
      [stationId]
    );

    const mode = result.rows.length > 0 ? result.rows[0].attendant_mode : 'manual';

    res.json({
      success: true,
      station_id: stationId,
      attendant_mode: mode,
      description: mode === 'rfid'
        ? 'RFID mode — attendants scan their card to track pump transactions'
        : 'Manual mode — attendants are assigned to pumps by the manager'
    });
  } catch (error) {
    logger.error('Error fetching mode', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * @swagger
 * /api/rfid/mode:
 *   put:
 *     summary: Switch station attendant mode between rfid and manual
 *     tags: [RFID]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - mode
 *             properties:
 *               mode:
 *                 type: string
 *                 enum: [rfid, manual]
 *     responses:
 *       200:
 *         description: Mode switched
 */
router.put('/mode', async (req, res) => {
  try {
    const { mode } = req.body;
    const stationId = process.env.OFFLINE_STATION_ID;

    if (!['rfid', 'manual'].includes(mode)) {
      return res.status(400).json({ success: false, error: 'mode must be "rfid" or "manual"' });
    }

    const result = await db.query(`
      INSERT INTO station_settings (station_id, attendant_mode, updated_at)
      VALUES ($1, $2, NOW())
      ON CONFLICT (station_id) DO UPDATE SET
        attendant_mode = EXCLUDED.attendant_mode,
        updated_at = NOW()
      RETURNING *
    `, [stationId, mode]);

    // Also update any currently open shift to match
    await db.query(
      `UPDATE shifts SET attendant_mode = $1 WHERE station_id = $2 AND status = 'open'`,
      [mode, stationId]
    );

    // Tell PTS polling service to lock/unlock all pumps based on new mode
    try {
      const ptsPollingService = require('../services/pts-polling.service');
      await ptsPollingService.switchPumpLockMode(mode);
    } catch (ptsErr) {
      logger.warn(`PTS pump lock mode switch failed (non-fatal): ${ptsErr.message}`);
    }

    logger.info(`✅ Station mode switched to: ${mode}`);

    res.json({
      success: true,
      message: `Station attendant mode set to ${mode}`,
      attendant_mode: mode,
      description: mode === 'rfid'
        ? 'RFID mode — attendants scan their card to track pump transactions'
        : 'Manual mode — attendants are assigned to pumps by the manager'
    });
  } catch (error) {
    logger.error('Error switching mode', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================
// Attendant Tag Management (legacy — use /tags endpoints above)
// ============================================

/**
 * @swagger
 * /api/rfid/attendants:
 *   get:
 *     summary: Get attendants with their RFID tags
 *     tags: [RFID]
 */
router.get('/attendants', async (req, res) => {
  try {
    const result = await db.query(`
      SELECT id, full_name, phone, tag_number, blocked, authorized_pumps
      FROM attendants
      WHERE station_id = $1
      ORDER BY full_name
    `, [process.env.OFFLINE_STATION_ID]);

    res.json({
      success: true,
      count: result.rows.length,
      attendants: result.rows
    });
  } catch (error) {
    logger.error('Error fetching attendants', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * @swagger
 * /api/rfid/attendants/{id}/tag:
 *   put:
 *     summary: Assign or update RFID tag for an attendant
 *     tags: [RFID]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - tag_number
 *             properties:
 *               tag_number:
 *                 type: string
 *                 description: Hex tag number (e.g., "4A00E005")
 *               authorized_pumps:
 *                 type: array
 *                 items:
 *                   type: integer
 *                 description: Specific pumps this attendant can use (optional)
 *     responses:
 *       200:
 *         description: Tag assigned
 */
router.put('/attendants/:id/tag', async (req, res) => {
  try {
    const { id } = req.params;
    const { tag_number, authorized_pumps } = req.body;

    if (!tag_number) {
      return res.status(400).json({ 
        success: false, 
        error: 'tag_number is required' 
      });
    }

    // Normalize tag to uppercase
    const normalizedTag = tag_number.toUpperCase();

    // Check if tag is already assigned to another attendant
    const existing = await db.query(`
      SELECT id, full_name FROM attendants 
      WHERE tag_number = $1 AND id != $2
    `, [normalizedTag, id]);

    if (existing.rows.length > 0) {
      return res.status(409).json({
        success: false,
        error: `Tag ${normalizedTag} is already assigned to ${existing.rows[0].full_name}`
      });
    }

    const result = await db.query(`
      UPDATE attendants SET
        tag_number = $1,
        authorized_pumps = $2
      WHERE id = $3
      RETURNING id, full_name, tag_number, authorized_pumps
    `, [normalizedTag, authorized_pumps || null, id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Attendant not found' });
    }

    res.json({
      success: true,
      message: `Tag ${normalizedTag} assigned to ${result.rows[0].full_name}`,
      attendant: result.rows[0]
    });
  } catch (error) {
    logger.error('Error assigning tag', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * @swagger
 * /api/rfid/attendants/{id}/tag:
 *   delete:
 *     summary: Remove RFID tag from an attendant
 *     tags: [RFID]
 */
router.delete('/attendants/:id/tag', async (req, res) => {
  try {
    const { id } = req.params;

    const result = await db.query(`
      UPDATE attendants SET tag_number = NULL
      WHERE id = $1
      RETURNING id, full_name
    `, [id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Attendant not found' });
    }

    res.json({
      success: true,
      message: `Tag removed from ${result.rows[0].full_name}`
    });
  } catch (error) {
    logger.error('Error removing tag', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * @swagger
 * /api/rfid/attendants/{id}/block:
 *   put:
 *     summary: Block/unblock an attendant from using RFID
 *     tags: [RFID]
 */
router.put('/attendants/:id/block', async (req, res) => {
  try {
    const { id } = req.params;
    const { blocked } = req.body;

    const result = await db.query(`
      UPDATE attendants SET blocked = $1
      WHERE id = $2
      RETURNING id, full_name, blocked
    `, [blocked === true, id]);

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Attendant not found' });
    }

    res.json({
      success: true,
      message: `${result.rows[0].full_name} is now ${blocked ? 'BLOCKED' : 'UNBLOCKED'}`,
      attendant: result.rows[0]
    });
  } catch (error) {
    logger.error('Error blocking attendant', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================
// RFID Service Status & Logs
// ============================================

/**
 * @swagger
 * /api/rfid/status:
 *   get:
 *     summary: Get RFID service status
 *     tags: [RFID]
 */
router.get('/status', async (req, res) => {
  try {
    const rfidService = require('../services/rfid-reader.service');
    const status = rfidService.getStatus();
    res.json({ success: true, ...status });
  } catch (error) {
    res.json({
      success: false,
      error: 'RFID service not available',
      message: error.message
    });
  }
});

/**
 * @swagger
 * /api/rfid/logs:
 *   get:
 *     summary: Get recent RFID activity logs
 *     tags: [RFID]
 */
router.get('/logs', async (req, res) => {
  try {
    const { limit = 50 } = req.query;
    const rfidService = require('../services/rfid-reader.service');
    const logs = rfidService.getLogs(parseInt(limit));
    res.json({ success: true, count: logs.length, logs });
  } catch (error) {
    res.json({ success: false, error: error.message, logs: [] });
  }
});

/**
 * @swagger
 * /api/rfid/reload:
 *   post:
 *     summary: Reload RFID readers from database
 *     tags: [RFID]
 */
router.post('/reload', async (req, res) => {
  try {
    const rfidService = require('../services/rfid-reader.service');
    await rfidService.reloadReaders();
    res.json({ success: true, message: 'RFID readers reloaded' });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================
// Active RFID Contexts (who is on which pump)
// ============================================

/**
 * @swagger
 * /api/rfid/active:
 *   get:
 *     summary: Get active RFID contexts — which attendant is tracking which pumps
 *     tags: [RFID]
 *     description: Shows all pumps currently attributed to an RFID-scanned attendant. Context expires after the configured validity window.
 *     responses:
 *       200:
 *         description: Active RFID tracking contexts
 */
router.get('/active', async (req, res) => {
  try {
    const ptsPollingService = require('../services/pts-polling.service');
    const active = ptsPollingService.getActiveRfidContexts ? ptsPollingService.getActiveRfidContexts() : [];
    res.json({
      success: true,
      count: active.length,
      contexts: active
    });
  } catch (error) {
    res.json({ success: true, count: 0, contexts: [], note: 'PTS polling service not available' });
  }
});

// ============================================
// Authorization History
// ============================================

/**
 * @swagger
 * /api/rfid/authorizations:
 *   get:
 *     summary: Get RFID authorization history
 *     tags: [RFID]
 */
router.get('/authorizations', async (req, res) => {
  try {
    const { limit = 100, pump_id, authorized, from, to } = req.query;

    let query = `
      SELECT 
        ra.*,
        a.full_name as attendant_name
      FROM rfid_authorizations ra
      LEFT JOIN attendants a ON ra.attendant_id = a.id
      WHERE 1=1
    `;
    const params = [];
    let paramCount = 0;

    if (pump_id) {
      params.push(pump_id);
      query += ` AND ra.pump_id = $${++paramCount}`;
    }

    if (authorized !== undefined) {
      params.push(authorized === 'true');
      query += ` AND ra.authorized = $${++paramCount}`;
    }

    if (from) {
      params.push(from);
      query += ` AND ra.authorization_datetime >= $${++paramCount}`;
    }

    if (to) {
      params.push(to);
      query += ` AND ra.authorization_datetime <= $${++paramCount}`;
    }

    params.push(parseInt(limit));
    query += ` ORDER BY ra.authorization_datetime DESC LIMIT $${++paramCount}`;

    const result = await db.query(query, params);

    res.json({
      success: true,
      count: result.rows.length,
      authorizations: result.rows
    });
  } catch (error) {
    logger.error('Error fetching authorizations', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================
// RFID Transactions
// ============================================

/**
 * @swagger
 * /api/rfid/transactions:
 *   get:
 *     summary: Get RFID fueling transactions
 *     tags: [RFID]
 *     parameters:
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 100 }
 *       - in: query
 *         name: from
 *         schema: { type: string, format: date-time }
 *       - in: query
 *         name: to
 *         schema: { type: string, format: date-time }
 *       - in: query
 *         name: attendant_id
 *         schema: { type: string }
 *       - in: query
 *         name: status
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: List of RFID transactions
 */
router.get('/transactions', async (req, res) => {
  try {
    const { limit = '100', from, to, attendant_id, status } = req.query;
    const params = [];
    let paramCount = 0;

    let query = `
      SELECT 
        rt.transaction_id,
        rt.authorization_id,
        rt.pump_id,
        rt.attendant_id,
        rt.tag_number,
        rt.pts_transaction_number,
        rt.nozzle_number,
        rt.fuel_grade_id,
        rt.fuel_grade_name,
        rt.volume,
        rt.price,
        rt.amount,
        rt.start_datetime,
        rt.end_datetime,
        rt.status,
        rt.created_at,
        a.full_name AS attendant_name,
        p.name AS pump_name
      FROM rfid_transactions rt
      LEFT JOIN attendants a ON a.id = rt.attendant_id
      LEFT JOIN pumps p ON p.pts2_pump_id = rt.pump_id
      WHERE 1=1
    `;

    if (attendant_id) {
      params.push(attendant_id);
      query += ` AND rt.attendant_id = $${++paramCount}`;
    }

    if (status) {
      params.push(status);
      query += ` AND rt.status = $${++paramCount}`;
    }

    if (from) {
      params.push(from);
      query += ` AND rt.start_datetime >= $${++paramCount}`;
    }

    if (to) {
      params.push(to);
      query += ` AND rt.start_datetime <= $${++paramCount}`;
    }

    params.push(parseInt(limit));
    query += ` ORDER BY rt.start_datetime DESC LIMIT $${++paramCount}`;

    const result = await db.query(query, params);

    res.json({
      success: true,
      count: result.rows.length,
      transactions: result.rows
    });
  } catch (error) {
    logger.error('Error fetching RFID transactions', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
