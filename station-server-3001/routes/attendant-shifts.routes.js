const express = require('express');
const logger = require('../utils/logger')('AttendantShiftsRoutes');
const db = require('../utils/db');
const { offlineAuthMiddleware, requireRole } = require('../middleware/offline-auth');

const router = express.Router();

/**
 * @swagger
 * tags:
 *   name: AttendantShifts
 *   description: Attendant shift management and close declaration endpoints
 */

/**
 * @swagger
 * /api/attendant-shifts/open:
 *   post:
 *     summary: Open a new shift
 *     description: Creates a new attendant shift
 *     tags: [AttendantShifts]
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
 *               - attendant_id
 *             properties:
 *               company_id:
 *                 type: string
 *                 format: uuid
 *               station_id:
 *                 type: string
 *                 format: uuid
 *               attendant_id:
 *                 type: string
 *                 format: uuid
 *               tag_number:
 *                 type: string
 *                 description: RFID tag number
 *               opened_by_user_id:
 *                 type: string
 *                 format: uuid
 *     responses:
 *       201:
 *         description: Shift opened successfully
 *       400:
 *         description: Missing required fields or shift already open
 *       500:
 *         description: Server error
 */
router.post('/open', async (req, res) => {
  try {
    const { company_id, station_id, attendant_id, tag_number, opened_by_user_id } = req.body;

    // Validate required fields
    if (!company_id || !station_id || !attendant_id) {
      return res.status(400).json({
        error: true,
        message: 'Missing required fields: company_id, station_id, attendant_id'
      });
    }

    // Check if attendant already has an open shift
    const openShiftCheck = await db.query(
      'SELECT id FROM attendant_shifts WHERE attendant_id = $1 AND is_open = true AND is_ended = false',
      [attendant_id]
    );

    if (openShiftCheck.rows.length > 0) {
      return res.status(400).json({
        error: true,
        message: 'Attendant already has an open shift',
        existing_shift_id: openShiftCheck.rows[0].id
      });
    }

    // Create new shift
    const result = await db.query(
      `INSERT INTO attendant_shifts 
        (company_id, station_id, attendant_id, tag_number, started_at, is_open, is_ended, is_pending_verification, is_verified, is_disputed, opened_by_user_id, created_at)
       VALUES ($1, $2, $3, $4, NOW(), true, false, false, false, false, $5, NOW())
       RETURNING id, company_id, station_id, attendant_id, tag_number, started_at, is_open, is_ended, opened_by_user_id, created_at`,
      [company_id, station_id, attendant_id, tag_number || null, opened_by_user_id || req.user?.id || null]
    );

    const shift = result.rows[0];

    logger.info(`✅ Opened shift ${shift.id} for attendant ${attendant_id}`);

    res.status(201).json({
      error: false,
      data: shift
    });

  } catch (error) {
    logger.error('Error opening shift', error);
    res.status(500).json({
      error: true,
      message: error.message
    });
  }
});

/**
 * @swagger
 * /api/attendant-shifts/{shiftId}:
 *   get:
 *     summary: Get shift details
 *     description: Retrieves shift details including close declaration and verification summary
 *     tags: [AttendantShifts]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: shiftId
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     responses:
 *       200:
 *         description: Shift details retrieved
 *       404:
 *         description: Shift not found
 *       500:
 *         description: Server error
 */
router.get('/:shiftId', async (req, res) => {
  try {
    const { shiftId } = req.params;

    // Get shift details
    const shiftResult = await db.query(
      `SELECT s.*, a.attendant_no, e.full_name as attendant_name
       FROM attendant_shifts s
       LEFT JOIN attendants a ON s.attendant_id = a.id
       LEFT JOIN employees e ON a.employee_id = e.id
       WHERE s.id = $1`,
      [shiftId]
    );

    if (shiftResult.rows.length === 0) {
      return res.status(404).json({
        error: true,
        message: 'Shift not found'
      });
    }

    const shift = shiftResult.rows[0];

    // Get close declaration if exists
    // Note: shift_close_declarations table removed - functionality disabled
    const declarationResult = { rows: [] };

    // Get verification summary if exists  
    // Note: shift_verification_summary table removed - functionality disabled
    const verificationResult = { rows: [] };

    // Get transaction summary for this shift
    const txSummaryResult = await db.query(
      `SELECT 
         COUNT(*) as transaction_count,
         COALESCE(SUM(amount), 0) as total_amount,
         COUNT(CASE WHEN is_verified THEN 1 END) as verified_count
       FROM fuel_transactions_raw
       WHERE shift_id = $1`,
      [shiftId]
    );

    res.json({
      error: false,
      data: {
        shift: shift,
        close_declaration: declarationResult.rows[0] || null,
        verification_summary: verificationResult.rows[0] || null,
        transaction_summary: {
          transaction_count: parseInt(txSummaryResult.rows[0]?.transaction_count || 0),
          total_amount: parseFloat(txSummaryResult.rows[0]?.total_amount || 0),
          verified_count: parseInt(txSummaryResult.rows[0]?.verified_count || 0)
        }
      }
    });

  } catch (error) {
    logger.error('Error fetching shift details', error);
    res.status(500).json({
      error: true,
      message: error.message
    });
  }
});

/**
 * @swagger
 * /api/attendant-shifts/{shiftId}/end:
 *   post:
 *     summary: End a shift
 *     description: Ends an open shift, setting ended_at and state flags
 *     tags: [AttendantShifts]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: shiftId
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
 *               ended_by_user_id:
 *                 type: string
 *                 format: uuid
 *               notes:
 *                 type: string
 *     responses:
 *       200:
 *         description: Shift ended successfully
 *       400:
 *         description: Shift already ended
 *       404:
 *         description: Shift not found
 *       500:
 *         description: Server error
 */
router.post('/:shiftId/end', async (req, res) => {
  try {
    const { shiftId } = req.params;
    const { ended_by_user_id, notes } = req.body;

    // Check if shift exists and is open
    const shiftCheck = await db.query(
      'SELECT id, is_open, is_ended FROM attendant_shifts WHERE id = $1',
      [shiftId]
    );

    if (shiftCheck.rows.length === 0) {
      return res.status(404).json({
        error: true,
        message: 'Shift not found'
      });
    }

    if (shiftCheck.rows[0].is_ended) {
      return res.status(400).json({
        error: true,
        message: 'Shift is already ended'
      });
    }

    // End the shift - set is_pending_verification = true per spec
    const result = await db.query(
      `UPDATE attendant_shifts 
       SET is_open = false, 
           is_ended = true, 
           is_pending_verification = true,
           ended_at = NOW()
       WHERE id = $1
       RETURNING id, company_id, station_id, attendant_id, tag_number, started_at, ended_at, is_open, is_ended, is_pending_verification`,
      [shiftId]
    );

    const shift = result.rows[0];

    logger.info(`✅ Ended shift ${shiftId}`);

    res.json({
      error: false,
      data: shift
    });

  } catch (error) {
    logger.error('Error ending shift', error);
    res.status(500).json({
      error: true,
      message: error.message
    });
  }
});

/**
 * @swagger
 * /api/attendant-shifts/{shiftId}/verify:
 *   post:
 *     summary: Verify a shift
 *     description: Compute and save verification summary for a shift
 *     tags: [AttendantShifts]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: shiftId
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
 *             required:
 *               - verified_total
 *             properties:
 *               verified_by_user_id:
 *                 type: string
 *                 format: uuid
 *               verified_total:
 *                 type: number
 *               is_disputed:
 *                 type: boolean
 *                 default: false
 *               notes:
 *                 type: string
 *     responses:
 *       200:
 *         description: Shift verified successfully
 *       404:
 *         description: Shift not found
 *       500:
 *         description: Server error
 */
router.post('/:shiftId/verify', async (req, res) => {
  try {
    const { shiftId } = req.params;
    const { verified_by_user_id, verified_total, is_disputed = false, notes } = req.body;

    // Check if shift exists
    const shiftCheck = await db.query(
      'SELECT id, is_ended FROM attendant_shifts WHERE id = $1',
      [shiftId]
    );

    if (shiftCheck.rows.length === 0) {
      return res.status(404).json({
        error: true,
        message: 'Shift not found'
      });
    }

    // Get computed total from transactions
    const computedResult = await db.query(
      `SELECT COALESCE(SUM(amount), 0) as computed_total
       FROM fuel_transactions_raw
       WHERE shift_id = $1`,
      [shiftId]
    );
    const computed_total = parseFloat(computedResult.rows[0].computed_total);

    // Note: Declaration and verification tables removed - simplified verification
    const variance_amount = 0;
    const currency = 'ZMW';

    // Update shift flags only
    await db.query(
      `UPDATE attendant_shifts 
       SET is_verified = $2, 
           is_disputed = $3,
           is_pending_verification = false
       WHERE id = $1`,
      [shiftId, !is_disputed, is_disputed]
    );

    logger.info(`✅ Shift ${shiftId} verified (disputed: ${is_disputed})`);

    res.json({
      error: false,
      data: {
        shift_id: shiftId,
        computed_total: computed_total,
        is_verified: !is_disputed,
        is_disputed: is_disputed,
        notes: notes
      }
    });

  } catch (error) {
    logger.error('Error verifying shift', error);
    res.status(500).json({
      error: true,
      message: error.message
    });
  }
});

/**
 * @swagger
 * /api/attendant-shifts/{shiftId}/dispute:
 *   post:
 *     summary: Mark shift as disputed
 *     description: Mark a shift as disputed due to variance or other issues
 *     tags: [AttendantShifts]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: shiftId
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
 *               disputed_by_user_id:
 *                 type: string
 *                 format: uuid
 *               notes:
 *                 type: string
 *     responses:
 *       200:
 *         description: Shift marked as disputed
 *       404:
 *         description: Shift not found
 *       500:
 *         description: Server error
 */
router.post('/:shiftId/dispute', async (req, res) => {
  try {
    const { shiftId } = req.params;
    const { disputed_by_user_id, notes } = req.body;

    // Check if shift exists
    const shiftCheck = await db.query(
      'SELECT id FROM attendant_shifts WHERE id = $1',
      [shiftId]
    );

    if (shiftCheck.rows.length === 0) {
      return res.status(404).json({
        error: true,
        message: 'Shift not found'
      });
    }

    // Update shift as disputed
    await db.query(
      `UPDATE attendant_shifts 
       SET is_disputed = true, 
           is_verified = false
       WHERE id = $1`,
      [shiftId]
    );

    logger.info(`✅ Shift ${shiftId} marked as disputed`);

    res.json({
      error: false,
      message: 'Shift marked as disputed',
      data: {
        shift_id: shiftId,
        is_disputed: true,
        notes: notes
      }
    });

  } catch (error) {
    logger.error('Error disputing shift', error);
    res.status(500).json({
      error: true,
      message: error.message
    });
  }
});

/**
 * @swagger
 * /api/attendant-shifts/{shiftId}/verification:
 *   get:
 *     summary: Get verification summary
 *     description: Retrieve the verification summary for a shift
 *     tags: [AttendantShifts]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: shiftId
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *     responses:
 *       200:
 *         description: Verification summary retrieved
 *       404:
 *         description: Shift not found
 *       500:
 *         description: Server error
 */
router.get('/:shiftId/verification', async (req, res) => {
  try {
    const { shiftId } = req.params;

    // Check if shift exists
    const shiftCheck = await db.query(
      'SELECT id, is_verified, is_disputed FROM attendant_shifts WHERE id = $1',
      [shiftId]
    );

    if (shiftCheck.rows.length === 0) {
      return res.status(404).json({
        error: true,
        message: 'Shift not found'
      });
    }

    const shift = shiftCheck.rows[0];

    // Note: shift_verification_summary table removed - return basic shift verification status
    res.json({
      error: false,
      data: {
        shift_id: shiftId,
        is_verified: shift.is_verified,
        is_disputed: shift.is_disputed,
        message: 'Verification summary table removed - showing basic shift status'
      }
    });

  } catch (error) {
    logger.error('Error fetching verification summary', error);
    res.status(500).json({
      error: true,
      message: error.message
    });
  }
});

/**
 * @swagger
 * /api/attendant-shifts/{shiftId}/resolve-raw:
 *   post:
 *     summary: Resolve raw transactions to a shift
 *     description: Bulk assign raw transactions to a shift and attendant
 *     tags: [AttendantShifts]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: shiftId
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
 *             required:
 *               - raw_ids
 *             properties:
 *               raw_ids:
 *                 type: array
 *                 items:
 *                   type: integer
 *                 description: Array of raw transaction IDs
 *               attendant_id:
 *                 type: string
 *                 format: uuid
 *               tag_number:
 *                 type: string
 *     responses:
 *       200:
 *         description: Transactions resolved successfully
 *       400:
 *         description: Missing required fields
 *       404:
 *         description: Shift not found
 *       500:
 *         description: Server error
 */
router.post('/:shiftId/resolve-raw', async (req, res) => {
  try {
    const { shiftId } = req.params;
    const { raw_ids, attendant_id, tag_number } = req.body;

    // Validate required fields
    if (!raw_ids || !Array.isArray(raw_ids) || raw_ids.length === 0) {
      return res.status(400).json({
        error: true,
        message: 'Missing required field: raw_ids (array of transaction IDs)'
      });
    }

    // Check if shift exists
    const shiftCheck = await db.query(
      'SELECT id, attendant_id, tag_number FROM attendant_shifts WHERE id = $1',
      [shiftId]
    );

    if (shiftCheck.rows.length === 0) {
      return res.status(404).json({
        error: true,
        message: 'Shift not found'
      });
    }

    const shift = shiftCheck.rows[0];
    const finalAttendantId = attendant_id || shift.attendant_id;
    const finalTagNumber = tag_number || shift.tag_number;

    // Update raw transactions to link to this shift
    const result = await db.query(
      `UPDATE fuel_transactions_raw 
       SET shift_id = $1,
           attendant_id = $2,
           tag_number = $3
       WHERE id = ANY($4)
       RETURNING id`,
      [shiftId, finalAttendantId, finalTagNumber, raw_ids]
    );

    const updatedCount = result.rows.length;

    logger.info(`✅ Resolved ${updatedCount} raw transactions to shift ${shiftId}`);

    res.json({
      error: false,
      message: `${updatedCount} transactions resolved to shift`,
      data: {
        shift_id: shiftId,
        resolved_count: updatedCount,
        resolved_ids: result.rows.map(r => r.id)
      }
    });

  } catch (error) {
    logger.error('Error resolving raw transactions', error);
    res.status(500).json({
      error: true,
      message: error.message
    });
  }
});

/**
 * @swagger
 * /api/attendant-shifts/{shiftId}/close-declaration:
 *   post:
 *     summary: Submit or update close declaration
 *     description: Submit or update a close declaration for a shift. Uses upsert since shift_id is unique.
 *     tags: [AttendantShifts]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: shiftId
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *         description: The shift ID
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               declared_cash:
 *                 type: number
 *                 default: 0
 *                 description: Cash amount declared
 *               declared_card:
 *                 type: number
 *                 default: 0
 *                 description: Card payment amount declared
 *               declared_debtors:
 *                 type: number
 *                 default: 0
 *                 description: Debtors amount declared
 *               declared_other:
 *                 type: object
 *                 description: Additional declaration details (JSON)
 *               declared_total:
 *                 type: number
 *                 default: 0
 *                 description: Total declared amount (should equal sum of above)
 *               currency:
 *                 type: string
 *                 default: ZMW
 *                 description: Currency code (3 characters)
 *     responses:
 *       200:
 *         description: Declaration submitted successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: boolean
 *                   example: false
 *                 data:
 *                   type: object
 *                   properties:
 *                     id:
 *                       type: string
 *                       format: uuid
 *                     shift_id:
 *                       type: string
 *                       format: uuid
 *                     currency:
 *                       type: string
 *                     declared_total:
 *                       type: number
 *                     declared_cash:
 *                       type: number
 *                     declared_card:
 *                       type: number
 *                     declared_debtors:
 *                       type: number
 *                     declared_other:
 *                       type: object
 *                     submitted_at:
 *                       type: string
 *                       format: date-time
 *       400:
 *         description: Missing required fields
 *       404:
 *         description: Shift not found
 *       500:
 *         description: Server error
 */
router.post('/:shiftId/close-declaration', async (req, res) => {
  try {
    const { shiftId } = req.params;

    // Verify shift exists
    const shiftCheck = await db.query(
      'SELECT id FROM attendant_shifts WHERE id = $1',
      [shiftId]
    );

    if (shiftCheck.rows.length === 0) {
      return res.status(404).json({
        error: true,
        message: 'Shift not found'
      });
    }

    // Note: shift_close_declarations table removed - functionality disabled
    res.status(410).json({
      error: true,
      message: 'Close declaration functionality has been removed'
    });

  } catch (error) {
    logger.error('Error submitting shift close declaration', error);
    res.status(500).json({
      error: true,
      message: error.message
    });
  }
});

/**
 * @swagger
 * /api/attendant-shifts/{shiftId}/close-declaration:
 *   get:
 *     summary: Get shift close declaration
 *     description: Retrieve the close declaration for a specific shift
 *     tags: [AttendantShifts]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: shiftId
 *         required: true
 *         schema:
 *           type: string
 *           format: uuid
 *         description: The shift ID
 *     responses:
 *       200:
 *         description: Declaration retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 error:
 *                   type: boolean
 *                   example: false
 *                 data:
 *                   type: object
 *                   nullable: true
 *                   properties:
 *                     id:
 *                       type: string
 *                       format: uuid
 *                     shift_id:
 *                       type: string
 *                       format: uuid
 *                     currency:
 *                       type: string
 *                     declared_total:
 *                       type: number
 *                     declared_cash:
 *                       type: number
 *                     declared_mobile:
 *                       type: number
 *                     declared_other:
 *                       type: object
 *                     submitted_at:
 *                       type: string
 *                       format: date-time
 *                     submitted_by_user_id:
 *                       type: string
 *                       format: uuid
 *       404:
 *         description: Shift not found
 *       500:
 *         description: Server error
 */
router.get('/:shiftId/close-declaration', async (req, res) => {
  try {
    const { shiftId } = req.params;

    // Verify shift exists
    const shiftCheck = await db.query(
      'SELECT id FROM attendant_shifts WHERE id = $1',
      [shiftId]
    );

    if (shiftCheck.rows.length === 0) {
      return res.status(404).json({
        error: true,
        message: 'Shift not found'
      });
    }

    // Note: shift_close_declarations table removed - functionality disabled
    res.status(410).json({
      error: true,
      message: 'Close declaration functionality has been removed'
    });

  } catch (error) {
    logger.error('Error fetching shift close declaration', error);
    res.status(500).json({
      error: true,
      message: error.message
    });
  }
});

module.exports = router;
