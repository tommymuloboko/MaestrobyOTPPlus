/**
 * PTS Routes - View real-time pump and tank status from PTS-2 controller
 */

const express = require('express');
const router = express.Router();
const ptsPollingService = require('../services/pts-polling.service');
const db = require('../utils/db');
const dualDb = require('../utils/dual-db');
const logger = require('../utils/logger')('PTSRoutes');

/**
 * @swagger
 * /api/pts/status:
 *   get:
 *     tags: [PTS]
 *     summary: Get PTS polling service status
 *     description: Returns the current status of the PTS polling service including connection state
 *     responses:
 *       200:
 *         description: PTS service status
 */
router.get('/status', (req, res) => {
  try {
    const status = ptsPollingService.getStatus();
    res.json({
      success: true,
      data: status
    });
  } catch (error) {
    logger.error('Error getting PTS status', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * @swagger
 * /api/pts/pumps:
 *   get:
 *     tags: [PTS]
 *     summary: Get all pumps status
 *     description: Returns cached pump status from PTS-2 controller (updated every 1 second)
 *     responses:
 *       200:
 *         description: All pumps status
 */
router.get('/pumps', (req, res) => {
  try {
    const pumps = ptsPollingService.getCachedPumpsStatus();
    res.json({
      success: true,
      timestamp: new Date().toISOString(),
      count: pumps.length,
      data: pumps
    });
  } catch (error) {
    logger.error('Error getting pumps status', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * @swagger
 * /api/pts/pumps/{pumpNumber}:
 *   get:
 *     tags: [PTS]
 *     summary: Get specific pump status
 *     parameters:
 *       - in: path
 *         name: pumpNumber
 *         required: true
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: Pump status
 */
router.get('/pumps/:pumpNumber', (req, res) => {
  try {
    const pumpNumber = parseInt(req.params.pumpNumber);
    const pump = ptsPollingService.getCachedPumpsStatus(pumpNumber);

    if (!pump) {
      return res.status(404).json({
        success: false,
        error: `Pump ${pumpNumber} not found`
      });
    }

    res.json({
      success: true,
      timestamp: new Date().toISOString(),
      data: pump
    });
  } catch (error) {
    logger.error('Error getting pump status', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * @swagger
 * /api/pts/tanks:
 *   get:
 *     tags: [PTS]
 *     summary: Get all tanks status
 *     description: Returns cached tank status from PTS-2 controller (updated every 5 seconds)
 *     responses:
 *       200:
 *         description: All tanks status
 */
router.get('/tanks', (req, res) => {
  try {
    const tanks = ptsPollingService.getCachedTanksStatus();
    res.json({
      success: true,
      timestamp: new Date().toISOString(),
      count: tanks.length,
      data: tanks
    });
  } catch (error) {
    logger.error('Error getting tanks status', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * @swagger
 * /api/pts/tanks/{tankNumber}:
 *   get:
 *     tags: [PTS]
 *     summary: Get specific tank status
 *     parameters:
 *       - in: path
 *         name: tankNumber
 *         required: true
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: Tank status
 */
router.get('/tanks/:tankNumber', (req, res) => {
  try {
    const tankNumber = parseInt(req.params.tankNumber);
    const tank = ptsPollingService.getCachedTanksStatus(tankNumber);

    if (!tank) {
      return res.status(404).json({
        success: false,
        error: `Tank ${tankNumber} not found`
      });
    }

    res.json({
      success: true,
      timestamp: new Date().toISOString(),
      data: tank
    });
  } catch (error) {
    logger.error('Error getting tank status', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * @swagger
 * /api/pts/logs:
 *   get:
 *     tags: [PTS]
 *     summary: Get recent PTS communication logs
 *     parameters:
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 100
 *     responses:
 *       200:
 *         description: Recent PTS logs
 */
router.get('/logs', (req, res) => {
  try {
    const limit = parseInt(req.query.limit) || 100;
    const logs = ptsPollingService.getLogs(limit);
    res.json({
      success: true,
      count: logs.length,
      data: logs
    });
  } catch (error) {
    logger.error('Error getting PTS logs', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * @swagger
 * /api/pts/pump/{pumpNumber}/lock:
 *   post:
 *     tags: [PTS]
 *     summary: Lock a pump
 *     parameters:
 *       - in: path
 *         name: pumpNumber
 *         required: true
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: Pump locked
 */
router.post('/pump/:pumpNumber/lock', async (req, res) => {
  try {
    const pumpNumber = parseInt(req.params.pumpNumber);
    const result = await ptsPollingService.lockPump(pumpNumber);
    res.json({
      success: true,
      data: result
    });
  } catch (error) {
    logger.error('Error locking pump', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * @swagger
 * /api/pts/pump/{pumpNumber}/unlock:
 *   post:
 *     tags: [PTS]
 *     summary: Unlock a pump
 *     parameters:
 *       - in: path
 *         name: pumpNumber
 *         required: true
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: Pump unlocked
 */
router.post('/pump/:pumpNumber/unlock', async (req, res) => {
  try {
    const pumpNumber = parseInt(req.params.pumpNumber);
    const result = await ptsPollingService.unlockPump(pumpNumber);
    res.json({
      success: true,
      data: result
    });
  } catch (error) {
    logger.error('Error unlocking pump', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * @swagger
 * /api/pts/pump/{pumpNumber}/authorize:
 *   post:
 *     tags: [PTS]
 *     summary: Authorize a pump for dispensing
 *     description: |
 *       Authorizes a pump for fuel dispensing. **Requires an attendant with an open shift.**
 *       The transaction will be automatically linked to the active shift.
 *     parameters:
 *       - in: path
 *         name: pumpNumber
 *         required: true
 *         schema:
 *           type: integer
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
 *                 description: The attendant authorizing the pump (must have open shift)
 *               nozzle:
 *                 type: integer
 *                 description: Nozzle number
 *               presetType:
 *                 type: string
 *                 enum: [Volume, Amount]
 *                 description: Type of preset limit
 *               dose:
 *                 type: number
 *                 description: Preset dose/limit value
 *               price:
 *                 type: number
 *                 description: Price per liter
 *     responses:
 *       200:
 *         description: Pump authorized successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 data:
 *                   type: object
 *                 shift:
 *                   type: object
 *                   properties:
 *                     id:
 *                       type: string
 *                     attendant_id:
 *                       type: string
 *                     attendant_name:
 *                       type: string
 *       400:
 *         description: Missing attendant_id or no open shift
 *       404:
 *         description: No open shift found for attendant
 */
router.post('/pump/:pumpNumber/authorize', async (req, res) => {
  try {
    const pumpNumber = parseInt(req.params.pumpNumber);
    const { attendant_id, nozzle, presetType, dose, price } = req.body;

    // Validate attendant_id is provided
    if (!attendant_id) {
      return res.status(400).json({
        success: false,
        error: 'attendant_id is required. Attendant must have an open shift to authorize pump.'
      });
    }

    // Check if attendant has an open shift at this station
    const shiftResult = await ptsPollingService.validateAndGetOpenShift(attendant_id);

    if (!shiftResult.success) {
      return res.status(404).json({
        success: false,
        error: shiftResult.error,
        message: 'Attendant must have an open shift before authorizing pump'
      });
    }

    const shift = shiftResult.shift;

    // Set the shift context for this authorization (will be used when transaction completes)
    ptsPollingService.setAuthorizationContext({
      shiftId: shift.id,
      attendantId: attendant_id,
      attendantName: shift.attendant_name,
      tagNumber: shift.tag_number,
      pumpNumber: pumpNumber
    });

    // Now authorize the pump with attendant info
    const result = await ptsPollingService.authorizePump(
      pumpNumber,
      nozzle,
      presetType,
      dose,
      price,
      shift.attendant_name || attendant_id
    );

    logger.info('Pump authorized with shift context', {
      pump: pumpNumber,
      shift: shift.id,
      attendant: attendant_id
    });

    res.json({
      success: true,
      data: result,
      shift: {
        id: shift.id,
        attendant_id: attendant_id,
        attendant_name: shift.attendant_name,
        tag_number: shift.tag_number
      }
    });
  } catch (error) {
    logger.error('Error authorizing pump', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * @swagger
 * /api/pts/pump/{pumpNumber}/stop:
 *   post:
 *     tags: [PTS]
 *     summary: Stop a pump
 *     parameters:
 *       - in: path
 *         name: pumpNumber
 *         required: true
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: Pump stopped
 */
router.post('/pump/:pumpNumber/stop', async (req, res) => {
  try {
    const pumpNumber = parseInt(req.params.pumpNumber);
    const result = await ptsPollingService.stopPump(pumpNumber);
    res.json({
      success: true,
      data: result
    });
  } catch (error) {
    logger.error('Error stopping pump', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * @swagger
 * /api/pts/pump/{pumpNumber}/emergency-stop:
 *   post:
 *     tags: [PTS]
 *     summary: Emergency stop a pump
 *     parameters:
 *       - in: path
 *         name: pumpNumber
 *         required: true
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: Pump emergency stopped
 */
router.post('/pump/:pumpNumber/emergency-stop', async (req, res) => {
  try {
    const pumpNumber = parseInt(req.params.pumpNumber);
    const result = await ptsPollingService.emergencyStopPump(pumpNumber);
    res.json({
      success: true,
      message: `Emergency stop issued for pump ${pumpNumber}`,
      data: result
    });
  } catch (error) {
    logger.error('Error emergency stopping pump', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * @swagger
 * /api/pts/pump/{pumpNumber}/suspend:
 *   post:
 *     tags: [PTS]
 *     summary: Suspend (pause) a pump filling
 *     description: Temporarily pauses the filling process. Only works while the pump is in filling status.
 *     parameters:
 *       - in: path
 *         name: pumpNumber
 *         required: true
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: Pump suspended
 */
router.post('/pump/:pumpNumber/suspend', async (req, res) => {
  try {
    const pumpNumber = parseInt(req.params.pumpNumber);
    const result = await ptsPollingService.suspendPump(pumpNumber);
    res.json({
      success: true,
      message: `Pump ${pumpNumber} suspended`,
      data: result
    });
  } catch (error) {
    logger.error('Error suspending pump', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * @swagger
 * /api/pts/pump/{pumpNumber}/resume:
 *   post:
 *     tags: [PTS]
 *     summary: Resume a suspended pump
 *     description: Resumes a previously suspended pump filling.
 *     parameters:
 *       - in: path
 *         name: pumpNumber
 *         required: true
 *         schema:
 *           type: integer
 *     responses:
 *       200:
 *         description: Pump resumed
 */
router.post('/pump/:pumpNumber/resume', async (req, res) => {
  try {
    const pumpNumber = parseInt(req.params.pumpNumber);
    const result = await ptsPollingService.resumePump(pumpNumber);
    res.json({
      success: true,
      message: `Pump ${pumpNumber} resumed`,
      data: result
    });
  } catch (error) {
    logger.error('Error resuming pump', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * @swagger
 * /api/pts/emergency-stop-all:
 *   post:
 *     tags: [PTS]
 *     summary: Emergency stop ALL pumps
 *     responses:
 *       200:
 *         description: All pumps emergency stopped
 */
router.post('/emergency-stop-all', async (req, res) => {
  try {
    const pumps = ptsPollingService.getCachedPumpsStatus();
    const results = [];
    for (const pump of pumps) {
      try {
        const result = await ptsPollingService.emergencyStopPump(pump.number || pump.Pump);
        results.push({ pump: pump.number || pump.Pump, success: true, data: result });
      } catch (err) {
        results.push({ pump: pump.number || pump.Pump, success: false, error: err.message });
      }
    }
    res.json({ success: true, message: 'Emergency stop sent to all pumps', results });
  } catch (error) {
    logger.error('Error emergency stopping all pumps', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * @swagger
 * /api/pts/poll:
 *   post:
 *     tags: [PTS]
 *     summary: Force immediate poll
 *     description: Force an immediate poll of all pumps and tanks
 *     responses:
 *       200:
 *         description: Poll completed
 */
router.post('/poll', async (req, res) => {
  try {
    const result = await ptsPollingService.forcePoll();
    res.json({
      success: true,
      data: result
    });
  } catch (error) {
    logger.error('Error forcing poll', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================
// REPORT ENDPOINTS
// ============================================

/**
 * @swagger
 * /api/pts/reports/pump-transactions:
 *   get:
 *     tags: [PTS]
 *     summary: Get pump transaction report from PTS controller
 *     description: |
 *       Queries the PTS controller directly for pump transaction history
 *       within a date range. Supports single or multiple pumps.
 *     parameters:
 *       - in: query
 *         name: pump
 *         required: true
 *         schema:
 *           type: string
 *         description: Pump number (e.g. "1") or comma-separated list (e.g. "1,2,3")
 *       - in: query
 *         name: start
 *         required: true
 *         schema:
 *           type: string
 *           format: date-time
 *         description: Start datetime (ISO format, e.g. "2026-02-25T00:00:00")
 *       - in: query
 *         name: end
 *         required: true
 *         schema:
 *           type: string
 *           format: date-time
 *         description: End datetime (ISO format, e.g. "2026-02-26T23:59:59")
 *     responses:
 *       200:
 *         description: Pump transaction report
 *       400:
 *         description: Missing required parameters
 *       500:
 *         description: PTS error
 */
router.get('/reports/pump-transactions', async (req, res) => {
  try {
    const { pump, start, end } = req.query;

    if (!pump || !start || !end) {
      return res.status(400).json({
        success: false,
        error: 'Missing required parameters: pump, start, end'
      });
    }

    // Parse pump numbers (support comma-separated: "1,2,3")
    const pumpNumbers = String(pump).split(',').map(p => parseInt(p.trim())).filter(p => !isNaN(p));

    if (pumpNumbers.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'Invalid pump number(s)'
      });
    }

    const transactions = await ptsPollingService.getReportPumpTransactions(
      pumpNumbers,
      String(start).trim(),
      String(end).trim()
    );

    res.json({
      success: true,
      timestamp: new Date().toISOString(),
      query: {
        pumps: pumpNumbers,
        start: String(start),
        end: String(end)
      },
      count: transactions.length,
      data: transactions
    });
  } catch (error) {
    logger.error('Error getting pump transaction report', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * GET /api/pts/reports/stored-transactions
 * Query pump transactions stored locally from the continuous poller.
 * Params: pump (optional), dateFrom, dateTo, limit (default 500)
 */
router.get('/reports/stored-transactions', async (req, res) => {
  try {
    const { pump, dateFrom, dateTo, limit = 500 } = req.query;

    const conditions = [];
    const params = [];

    if (pump && pump !== '0') {
      params.push(parseInt(pump));
      conditions.push(`pump = $${params.length}`);
    }
    if (dateFrom) {
      params.push(new Date(String(dateFrom).trim()).toISOString());
      conditions.push(`datetime_end >= $${params.length}`);
    }
    if (dateTo) {
      params.push(new Date(String(dateTo).trim()).toISOString());
      conditions.push(`datetime_end <= $${params.length}`);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    params.push(Math.min(parseInt(String(limit)) || 500, 5000));

    const result = await db.query(`
      SELECT id, station_id, pump, nozzle, fuel_grade_id, fuel_grade_name,
             transaction_number, datetime_start, datetime_end,
             volume, tc_volume, price, amount, total_volume, total_amount,
             tag, flow_rate, is_offline, is_paid, user_id, polled_at, created_at
      FROM pump_transaction_reports
      ${where}
      ORDER BY datetime_end DESC
      LIMIT $${params.length}
    `, params);

    res.json({
      success: true,
      timestamp: new Date().toISOString(),
      count: result.rows.length,
      data: result.rows,
    });
  } catch (error) {
    logger.error('Error querying stored pump transactions', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ============================================
// PUMP SIMULATOR ENDPOINTS (for testing)
// ============================================

/**
 * @swagger
 * /api/pump-simulator/authorize:
 *   post:
 *     tags: [PTS]
 *     summary: Authorize pump with preset amount from simulator
 *     description: After RFID scan unlocks pump, simulator sends the preset amount and server authorizes PTS
 */
router.post('/authorize', async (req, res) => {
  try {
    const { pumpId, amount, tagNumber, attendantId, attendantName } = req.body;

    logger.info(`🎮 Simulator authorize request: Pump ${pumpId}, K${amount}, Tag: ${tagNumber}`);

    if (!pumpId || !amount) {
      return res.status(400).json({
        success: false,
        error: 'pumpId and amount are required'
      });
    }

    // Get company and station from environment
    const companyId = process.env.OFFLINE_COMPANY_ID || process.env.COMPANY_ID;
    const stationId = process.env.OFFLINE_STATION_ID || process.env.STATION_ID;

    if (!companyId || !stationId) {
      return res.status(400).json({
        success: false,
        error: 'Station/Company not configured'
      });
    }

    // 1. Send authorization to PTS with the simulator's amount
    try {
      await ptsPollingService.authorizePumpWithAmount(pumpId, amount, attendantName || 'Simulator');
      logger.info(`✅ PTS authorized: Pump ${pumpId} for K${amount}`);
    } catch (ptsError) {
      logger.error(`❌ PTS authorization failed: ${ptsError.message}`);
      return res.status(500).json({
        success: false,
        error: `PTS authorization failed: ${ptsError.message}`
      });
    }

    // 2. Store authorization record in database
    const result = await db.query(`
      INSERT INTO fuel_transactions_raw 
      (company_id, station_id, pump_id, amount, currency, time, tag_number, attendant_id, transaction_id, is_verified, created_at)
      VALUES ($1, $2, $3, $4, 'ZMW', NOW(), $5, $6, $7, false, NOW())
      RETURNING id
    `, [
      companyId,
      stationId,
      pumpId,
      amount,
      tagNumber,
      attendantId,
      0  // Placeholder - will be updated when fueling completes
    ]);

    logger.info(`💾 Authorization stored: ID=${result.rows[0].id}`);

    // Queue for sync to Supabase
    await dualDb.addToSyncQueue('fuel_transactions_raw', result.rows[0].id, 'INSERT', {
      company_id: companyId,
      station_id: stationId,
      pump_id: pumpId,
      amount: amount,
      tag_number: tagNumber,
      attendant_id: attendantId
    });

    // 3. Broadcast to WebSocket clients
    ptsPollingService.broadcast('pumpAuthorized', {
      id: result.rows[0].id,
      pumpId: pumpId,
      amount: amount,
      tagNumber: tagNumber,
      attendantId: attendantId,
      attendantName: attendantName,
      timestamp: new Date().toISOString()
    });

    res.json({
      success: true,
      message: `Pump ${pumpId} authorized for K${amount}`,
      authorizationId: result.rows[0].id
    });

  } catch (error) {
    logger.error('Pump simulator authorize error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * @swagger
 * /api/pump-simulator/transaction:
 *   post:
 *     tags: [PTS]
 *     summary: Record simulated pump transaction
 *     description: Records a transaction from the HTML pump simulator
 */
router.post('/transaction', async (req, res) => {
  try {
    const { pumpId, amount, tagNumber, attendant, timestamp } = req.body;

    logger.info(`Pump simulator transaction: Pump ${pumpId}, K${amount}, Tag: ${tagNumber}`);

    // Get company and station from service
    const companyId = process.env.OFFLINE_COMPANY_ID || process.env.COMPANY_ID;
    const stationId = process.env.OFFLINE_STATION_ID || process.env.STATION_ID;

    if (!companyId || !stationId) {
      return res.status(400).json({
        success: false,
        error: 'Station/Company not configured'
      });
    }

    // Look up attendant by tag
    let attendantId = null;
    try {
      const attendantResult = await db.query(`
        SELECT id FROM attendants WHERE UPPER(tag_number) = UPPER($1) LIMIT 1
      `, [tagNumber]);
      if (attendantResult.rows.length > 0) {
        attendantId = attendantResult.rows[0].id;
      }
    } catch (e) {
      logger.warn('Could not look up attendant:', e.message);
    }

    // Generate a simulated transaction ID
    const transactionId = Math.floor(Date.now() / 1000) % 100000;

    // Store in fuel_transactions_raw
    const result = await db.query(`
      INSERT INTO fuel_transactions_raw 
      (company_id, station_id, pump_id, amount, currency, time, tag_number, attendant_id, transaction_id, is_verified, created_at)
      VALUES ($1, $2, $3, $4, 'ZMW', $5, $6, $7, $8, false, NOW())
      RETURNING id
    `, [
      companyId,
      stationId,
      pumpId,
      amount,
      timestamp || new Date().toISOString(),
      tagNumber,
      attendantId,
      transactionId
    ]);

    logger.info(`✅ Simulator transaction stored: ID=${result.rows[0].id}`);

    // Queue for sync to Supabase
    await dualDb.addToSyncQueue('fuel_transactions_raw', result.rows[0].id, 'INSERT', {
      company_id: companyId,
      station_id: stationId,
      pump_id: pumpId,
      amount: amount,
      tag_number: tagNumber,
      attendant_id: attendantId,
      transaction_id: transactionId
    });

    // Broadcast to WebSocket clients
    ptsPollingService.broadcast('transactionComplete', {
      id: result.rows[0].id,
      pumpId,
      amount,
      tagNumber,
      attendant,
      transactionId,
      timestamp: new Date().toISOString()
    });

    res.json({
      success: true,
      transactionId: result.rows[0].id,
      ptsTransactionId: transactionId
    });

  } catch (error) {
    logger.error('Pump simulator transaction error:', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
