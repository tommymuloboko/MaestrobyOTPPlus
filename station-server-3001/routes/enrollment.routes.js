/**
 * RFID Tag Enrollment Routes
 * 
 * Manages a dedicated "enrollment reader" that scans new cards for registration.
 * Flow:
 *   1. Register an enrollment reader (ip, port)
 *   2. Service polls it — when a card is scanned, it appears as "pending" on screen
 *   3. Manager decides to register (save to DB) or dismiss the scanned tag
 *   4. Once registered, manager assigns the tag to an attendant
 */

const express = require('express');
const logger = require('../utils/logger')('Enrollment');
const db = require('../utils/db');

const router = express.Router();

const stationId = () => process.env.OFFLINE_STATION_ID;
const companyId = () => process.env.OFFLINE_COMPANY_ID;

// ─── Ensure DB column exists ───────────────────────────────────

async function ensureSchema() {
  try {
    // Add 'purpose' column to rfid_readers if it doesn't exist
    await db.query(`
      ALTER TABLE rfid_readers
        ADD COLUMN IF NOT EXISTS purpose VARCHAR(20) DEFAULT 'pump'
    `);
    logger.info('✅ Enrollment schema ready (rfid_readers.purpose column)');
  } catch (err) {
    logger.warn('Schema migration note:', err.message);
  }
}
ensureSchema();

// ─── Enrollment Reader CRUD ────────────────────────────────────

/**
 * GET /api/enrollment/reader
 * Get the enrollment reader for this station (there should be at most one)
 */
router.get('/reader', async (req, res) => {
  try {
    const result = await db.query(`
      SELECT reader_id, reader_name, ip_address, port, device_address,
             location, is_active, purpose, created_at, updated_at
      FROM rfid_readers
      WHERE purpose = 'enrollment'
        AND station_id = $1
      ORDER BY created_at DESC
      LIMIT 1
    `, [stationId()]);

    if (result.rows.length === 0) {
      return res.json({ success: true, reader: null });
    }

    // Check live connection status
    let connected = false;
    try {
      const rfidService = require('../services/rfid-reader.service');
      connected = rfidService.isReaderConnected(result.rows[0].ip_address, result.rows[0].port);
    } catch (_) {}

    res.json({
      success: true,
      reader: { ...result.rows[0], connected }
    });
  } catch (error) {
    logger.error('Error fetching enrollment reader', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/enrollment/reader
 * Register (or update) the enrollment reader
 * Body: { reader_name, ip_address, port?, device_address? }
 */
router.post('/reader', async (req, res) => {
  try {
    const { reader_name, ip_address, port = 8080, device_address = 0 } = req.body;

    if (!reader_name || !ip_address) {
      return res.status(400).json({
        success: false,
        error: 'reader_name and ip_address are required'
      });
    }

    // Upsert: one enrollment reader per station
    const result = await db.query(`
      INSERT INTO rfid_readers
        (company_id, station_id, reader_name, ip_address, port, device_address, pump_ids, location, purpose, is_active)
      VALUES ($1, $2, $3, $4, $5, $6, $7, 'Enrollment Station', 'enrollment', true)
      ON CONFLICT (ip_address, port) DO UPDATE SET
        reader_name  = EXCLUDED.reader_name,
        purpose      = 'enrollment',
        device_address = EXCLUDED.device_address,
        is_active    = true,
        updated_at   = NOW()
      RETURNING *
    `, [companyId(), stationId(), reader_name, ip_address, port, device_address, []]);

    const reader = result.rows[0];

    // Reload RFID service so it picks up the new reader
    try {
      const rfidService = require('../services/rfid-reader.service');
      await rfidService.reloadReaders();
    } catch (e) {
      logger.warn('Could not reload RFID service:', e.message);
    }

    res.status(201).json({
      success: true,
      message: `Enrollment reader registered at ${ip_address}:${port}`,
      reader
    });
  } catch (error) {
    logger.error('Error registering enrollment reader', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * DELETE /api/enrollment/reader
 * Remove the enrollment reader
 */
router.delete('/reader', async (req, res) => {
  try {
    const result = await db.query(`
      UPDATE rfid_readers
      SET is_active = false, purpose = 'pump'
      WHERE purpose = 'enrollment' AND station_id = $1
      RETURNING reader_id, ip_address, port
    `, [stationId()]);

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'No enrollment reader found' });
    }

    // Reload RFID service
    try {
      const rfidService = require('../services/rfid-reader.service');
      await rfidService.reloadReaders();
    } catch (e) {
      logger.warn('Could not reload RFID service:', e.message);
    }

    res.json({ success: true, message: 'Enrollment reader removed' });
  } catch (error) {
    logger.error('Error removing enrollment reader', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/enrollment/reader/test
 * Test TCP connection to the enrollment reader
 */
router.post('/reader/test', async (req, res) => {
  try {
    const { ip_address, port = 8080 } = req.body;

    if (!ip_address) {
      return res.status(400).json({ success: false, error: 'ip_address is required' });
    }

    const rfidService = require('../services/rfid-reader.service');
    const result = await rfidService.testConnection(ip_address, port);
    res.json({ success: result.success, ...result });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// ─── Scanned Tags (unassigned) ─────────────────────────────────

/**
 * GET /api/enrollment/scanned
 * Get recently scanned tags that are unassigned (ready for pairing)
 * Query: ?limit=50
 */
router.get('/scanned', async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);

    const result = await db.query(`
      SELECT t.id, t.tag_number, t.label, t.attendant_id, t.is_active,
             t.registered_at, t.created_at,
             a.full_name as attendant_name
      FROM rfid_tags t
      LEFT JOIN attendants a ON t.attendant_id = a.id
      WHERE t.station_id = $1
      ORDER BY t.created_at DESC
      LIMIT $2
    `, [stationId(), limit]);

    res.json({
      success: true,
      count: result.rows.length,
      tags: result.rows
    });
  } catch (error) {
    logger.error('Error fetching scanned tags', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/enrollment/assign
 * Quick-assign a scanned tag to an attendant
 * Body: { tag_id, attendant_id }
 */
router.post('/assign', async (req, res) => {
  try {
    const { tag_id, attendant_id } = req.body;

    if (!tag_id || !attendant_id) {
      return res.status(400).json({
        success: false,
        error: 'tag_id and attendant_id are required'
      });
    }

    // Verify tag exists
    const tag = await db.query(
      'SELECT id, tag_number, attendant_id FROM rfid_tags WHERE id = $1 AND station_id = $2',
      [tag_id, stationId()]
    );

    if (tag.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Tag not found' });
    }

    if (tag.rows[0].attendant_id) {
      return res.status(409).json({
        success: false,
        error: 'Tag is already assigned. Unassign it first.'
      });
    }

    // Verify attendant exists
    const attendant = await db.query(
      'SELECT id, full_name FROM attendants WHERE id = $1',
      [attendant_id]
    );

    if (attendant.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Attendant not found' });
    }

    // Assign
    const result = await db.query(`
      UPDATE rfid_tags
      SET attendant_id = $1, is_active = true, updated_at = NOW()
      WHERE id = $2
      RETURNING *
    `, [attendant_id, tag_id]);

    // Also update legacy attendants.tag_number column
    await db.query(
      'UPDATE attendants SET tag_number = $1 WHERE id = $2',
      [tag.rows[0].tag_number, attendant_id]
    ).catch(() => {});

    res.json({
      success: true,
      message: `Tag ${tag.rows[0].tag_number} assigned to ${attendant.rows[0].full_name}`,
      tag: result.rows[0]
    });
  } catch (error) {
    logger.error('Error assigning tag', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/enrollment/unassign
 * Unassign a tag from its attendant
 * Body: { tag_id }
 */
router.post('/unassign', async (req, res) => {
  try {
    const { tag_id } = req.body;

    if (!tag_id) {
      return res.status(400).json({ success: false, error: 'tag_id is required' });
    }

    const result = await db.query(`
      UPDATE rfid_tags
      SET attendant_id = NULL, updated_at = NOW()
      WHERE id = $1 AND station_id = $2
      RETURNING *
    `, [tag_id, stationId()]);

    if (result.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Tag not found' });
    }

    res.json({
      success: true,
      message: `Tag ${result.rows[0].tag_number} unassigned`,
      tag: result.rows[0]
    });
  } catch (error) {
    logger.error('Error unassigning tag', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * DELETE /api/enrollment/tag/:tagId
 * Delete a registered tag that is NOT assigned to any attendant
 */
router.delete('/tag/:tagId', async (req, res) => {
  try {
    const { tagId } = req.params;

    // Check tag exists and is not assigned
    const tag = await db.query(
      'SELECT id, tag_number, attendant_id FROM rfid_tags WHERE id = $1 AND station_id = $2',
      [tagId, stationId()]
    );

    if (tag.rows.length === 0) {
      return res.status(404).json({ success: false, error: 'Tag not found' });
    }

    if (tag.rows[0].attendant_id) {
      return res.status(409).json({
        success: false,
        error: 'Cannot delete an assigned tag. Unassign it first.'
      });
    }

    await db.query(
      'DELETE FROM rfid_tags WHERE id = $1 AND station_id = $2',
      [tagId, stationId()]
    );

    logger.info(`🗑️ Tag ${tag.rows[0].tag_number} deleted`);

    res.json({
      success: true,
      message: `Tag ${tag.rows[0].tag_number} deleted`
    });
  } catch (error) {
    logger.error('Error deleting tag', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/enrollment/attendants
 * List attendants available for tag assignment
 */
router.get('/attendants', async (req, res) => {
  try {
    const result = await db.query(`
      SELECT a.id, a.full_name, a.tag_number,
             t.tag_number as rfid_tag
      FROM attendants a
      LEFT JOIN rfid_tags t ON t.attendant_id = a.id AND t.is_active = true
      WHERE a.station_id = $1 AND a.blocked = false
      ORDER BY a.full_name
    `, [stationId()]);

    res.json({
      success: true,
      attendants: result.rows
    });
  } catch (error) {
    logger.error('Error fetching attendants', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ─── Pending (unregistered) scans ──────────────────────────────

/**
 * GET /api/enrollment/pending
 * Get tags scanned on the enrollment reader that haven't been registered yet.
 * These are held in-memory in the RFID service.
 */
router.get('/pending', async (req, res) => {
  try {
    const rfidService = require('../services/rfid-reader.service');
    const pending = rfidService.getPendingEnrollmentScans();

    // Also check which are already in DB (in case registered between scans)
    const sid = stationId();
    const filtered = [];
    for (const p of pending) {
      const exists = await db.query(
        `SELECT id FROM rfid_tags WHERE UPPER(tag_number) = $1 AND station_id = $2`,
        [p.tag_number, sid]
      );
      if (exists.rows.length === 0) {
        filtered.push(p);
      } else {
        // Already registered — remove from pending
        rfidService.removePendingEnrollmentScan(p.tag_number);
      }
    }

    res.json({
      success: true,
      count: filtered.length,
      pending: filtered
    });
  } catch (error) {
    logger.error('Error fetching pending scans', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/enrollment/register-tag
 * Register (save to DB) a pending scanned tag.
 * Body: { tag_number }
 */
router.post('/register-tag', async (req, res) => {
  try {
    const { tag_number } = req.body;
    if (!tag_number) {
      return res.status(400).json({ success: false, error: 'tag_number is required' });
    }

    const normalizedTag = tag_number.toUpperCase();
    const sid = stationId();
    const cid = companyId();

    // Check if already registered
    const existing = await db.query(
      `SELECT id, tag_number FROM rfid_tags WHERE UPPER(tag_number) = $1 AND station_id = $2`,
      [normalizedTag, sid]
    );

    if (existing.rows.length > 0) {
      // Already registered — just remove from pending and return
      try {
        const rfidService = require('../services/rfid-reader.service');
        rfidService.removePendingEnrollmentScan(normalizedTag);
      } catch (_) {}

      return res.json({
        success: true,
        message: 'Tag was already registered',
        tag: existing.rows[0]
      });
    }

    // Insert into rfid_tags
    const result = await db.query(`
      INSERT INTO rfid_tags (tag_number, company_id, station_id, is_active, registered_at)
      VALUES ($1, $2, $3, true, NOW())
      RETURNING id, tag_number, attendant_id, is_active, registered_at, created_at
    `, [normalizedTag, cid, sid]);

    const tag = result.rows[0];
    logger.info(`✅ Tag ${normalizedTag} registered via enrollment`);

    // Remove from in-memory pending list
    try {
      const rfidService = require('../services/rfid-reader.service');
      rfidService.removePendingEnrollmentScan(normalizedTag);
    } catch (_) {}

    res.status(201).json({
      success: true,
      message: `Tag ${normalizedTag} registered`,
      tag
    });
  } catch (error) {
    logger.error('Error registering tag', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * POST /api/enrollment/dismiss
 * Dismiss (discard) a pending scanned tag without registering it.
 * Body: { tag_number }
 */
router.post('/dismiss', async (req, res) => {
  try {
    const { tag_number } = req.body;
    if (!tag_number) {
      return res.status(400).json({ success: false, error: 'tag_number is required' });
    }

    const normalizedTag = tag_number.toUpperCase();

    try {
      const rfidService = require('../services/rfid-reader.service');
      rfidService.removePendingEnrollmentScan(normalizedTag);
    } catch (_) {}

    logger.info(`🗑️ Pending tag ${normalizedTag} dismissed`);

    res.json({
      success: true,
      message: `Tag ${normalizedTag} dismissed`
    });
  } catch (error) {
    logger.error('Error dismissing tag', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
