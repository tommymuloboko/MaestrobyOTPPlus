/**
 * PTS-2 Polling Service
 * Wraps FuelService and adds WebSocket broadcasting
 */

const EventEmitter = require('events');
const FuelService = require('./fuel.service');
const logger = require('../utils/logger')('PTSPolling');
const database = require('../utils/database');
const dualDb = require('../utils/dual-db');
const connectionStatus = require('./connection-status.service');

// Note: RFID service is loaded lazily to avoid circular dependency
let rfidReaderService = null;

class PTSPollingService extends EventEmitter {
  constructor() {
    super();
    this.isRunning = false;
    this.fuelService = null;

    // Station configuration (set from environment or during start)
    // Support both OFFLINE_* and regular env variable names
    this.stationId = process.env.OFFLINE_STATION_ID || process.env.STATION_ID || null;
    this.companyId = process.env.OFFLINE_COMPANY_ID || process.env.COMPANY_ID || null;

    // Per-pump RFID contexts (Map: pumpNumber → { tagNumber, attendant, readTime, readerId })
    this.rfidContexts = new Map();
    this.rfidTagValidityMs = parseInt(process.env.RFID_TAG_VALIDITY_MS) || 60000; // 1 minute

    // Pump lock/unlock management for RFID mode
    // In RFID mode: pumps are locked by default, unlocked on card scan, re-locked after fill or timeout
    this.unlockTimeouts = new Map();  // pumpNumber → setTimeout handle
    this.lockedPumps = new Set();     // Track which pumps we have locked
    this.rfidModeActive = false;      // Whether we're in RFID lock mode
    this.unlockTimeoutMs = parseInt(process.env.RFID_UNLOCK_TIMEOUT_MS) || 30000; // 30 seconds to start filling

    // Tank measurement history (time-series for trend reports)
    // Throttle stored rows per tank so we don't write one every poll.
    this.tankMeasurementLastStored = new Map(); // pts2_tank_id → epoch ms of last stored row
    this.tankMeasurementIntervalMs = parseInt(process.env.TANK_MEASUREMENT_INTERVAL_MS) || 300000; // 5 min

    // Configuration from environment
    this.config = {
      url: process.env.PTS_URL || 'https://192.168.1.90/jsonPTS',
      username: process.env.PTS_USERNAME || 'admin',
      password: process.env.PTS_PASSWORD || 'admin',
      timeout: parseInt(process.env.PTS_TIMEOUT) || 30000,
      pollingInterval: parseInt(process.env.PTS_POLLING_INTERVAL) || 1000
    };

    // Communication logs (circular buffer)
    this.logs = [];
    this.maxLogs = 500;

    // WebSocket clients (set externally via setWsClients)
    this.wsClients = new Set();
  }

  /**
   * Add log entry
   */
  addLog(level, message, data = null) {
    const entry = {
      timestamp: new Date().toISOString(),
      level,
      message,
      data
    };

    this.logs.push(entry);
    if (this.logs.length > this.maxLogs) {
      this.logs.shift();
    }

    // Console logging
    if (level === 'error') {
      logger.error(message, data);
    } else if (level === 'debug') {
      logger.debug(message, data);
    } else if (level === 'warn') {
      logger.warn(message);
    } else {
      logger.info(message);
    }
  }

  /**
   * Get recent logs
   */
  getLogs(limit = 100) {
    return this.logs.slice(-limit);
  }

  /**
   * Broadcast to WebSocket clients
   */
  broadcast(type, data) {
    const message = JSON.stringify({
      type,
      timestamp: new Date().toISOString(),
      data
    });

    this.wsClients.forEach(client => {
      if (client.readyState === 1) { // WebSocket.OPEN
        try {
          client.send(message);
        } catch (err) {
          logger.error('WebSocket send error', err);
        }
      }
    });

    // Also emit as event for internal listeners
    this.emit(type, data);
  }

  /**
   * Set WebSocket clients collection
   */
  setWsClients(clients) {
    this.wsClients = clients;
  }

  /**
   * Start the polling service
   */
  async start() {
    if (this.isRunning) {
      this.addLog('warn', 'PTS Polling Service already running');
      return;
    }

    this.addLog('info', '🔄 Starting PTS Polling Service');
    this.addLog('info', `📡 Connecting to: ${this.config.url}`);
    this.addLog('info', `👤 Username: ${this.config.username}`);
    this.addLog('info', `⏱️  Poll interval: ${this.config.pollingInterval}ms`);

    try {
      // Create FuelService with config
      this.fuelService = new FuelService(this.config);

      // Listen to FuelService events
      this.fuelService.on('statusUpdate', (data) => {
        // data.status is the raw PTS packet: { Id, Type, Data: { ...all fields } }
        this.addLog('info', `⛽ Pump ${data.pump} status: ${data.status.Type}`, {
          pump: data.pump,
          type: data.status.Type,
          nozzle: data.status.Data?.Nozzle
        });
        this.broadcast('pumpStatus', data);
      });

      this.fuelService.on('tankUpdate', (data) => {
        this.addLog('info', `🛢️  Tank ${data.tank}: ${data.status.ProductVolume}L (${data.status.TankFillingPercentage}%)`, {
          tank: data.tank,
          volume: data.status.ProductVolume,
          percentage: data.status.TankFillingPercentage,
          temperature: data.status.Temperature
        });
        this.broadcast('tankStatus', data);

        // Persist a throttled time-series row for tank trend reports.
        this.storeTankMeasurement(data.tank, data.status).catch(err =>
          this.addLog('warn', `⚠️ Failed to store tank measurement: ${err.message}`)
        );
      });

      this.fuelService.on('pumpFilling', (data) => {
        this.addLog('info', `🚰 Pump ${data.pump} FILLING started`);
        this.broadcast('pumpFilling', data);
      });

      this.fuelService.on('pumpIdle', (data) => {
        this.addLog('info', `✅ Pump ${data.pump} now IDLE`);
        this.broadcast('pumpIdle', data);
      });

      this.fuelService.on('transactionComplete', async (data) => {
        this.addLog('info', `💰 Pump ${data.pump} transaction #${data.transaction} complete`);
        this.broadcast('transactionComplete', data);

        // Fetch full transaction details from PTS-2 (includes Tag, Volume, Amount, FuelGrade, etc.)
        let ptsTransaction = null;
        try {
          ptsTransaction = await this.fuelService.getPumpTransactionInfo(data.pump, data.transaction);
          if (ptsTransaction) {
            this.addLog('info', `📋 PTS transaction details: Tag=${ptsTransaction.Tag || 'none'}, Vol=${ptsTransaction.Volume}, Amt=${ptsTransaction.Amount}, Fuel=${ptsTransaction.FuelGradeName}, State=${ptsTransaction.State}`);
          }
        } catch (err) {
          this.addLog('warn', `⚠️ Could not fetch PTS transaction details: ${err.message}`);
        }

        // Store the transaction (online or offline) with full PTS data
        await this.storeTransaction(data, ptsTransaction);

        // PTS-2 handles locking automatically after transaction (AutoCloseTransaction=true)
        // Pump returns to idle and requires a new PumpAuthorize (card scan) for next fill
        if (this.rfidModeActive) {
          this.addLog('info', `✅ Pump ${data.pump} transaction done — PTS-2 auto-closed, requires new card scan`);
          this.broadcast('pumpTransactionDone', { pump: data.pump, reason: 'transaction_complete' });
        }
      });

      // Start polling
      await this.fuelService.startPolling();

      // Integrate with RFID reader service (if available)
      this.setupRfidIntegration();

      // Start continuous pump transaction report poller (every 2 minutes)
      const TRANSACTION_POLL_MS = parseInt(process.env.TRANSACTION_POLL_INTERVAL_MS || '120000');
      this.transactionPollInterval = setInterval(() => {
        this.pollAndStorePumpTransactions().catch(err =>
          this.addLog('warn', `⚠️ Transaction report poll failed: ${err.message}`)
        );
      }, TRANSACTION_POLL_MS);
      // Run once immediately after a short startup delay
      setTimeout(() => {
        this.pollAndStorePumpTransactions().catch(err =>
          this.addLog('warn', `⚠️ Initial transaction report poll failed: ${err.message}`)
        );
      }, 15000);

      this.isRunning = true;
      this.addLog('info', '✅ PTS Polling Service started successfully');

      // Check station mode and lock pumps if RFID mode
      // Delay slightly to ensure PTS connection is stable
      setTimeout(() => this.initPumpLockMode(), 5000);

    } catch (error) {
      this.addLog('error', `❌ Failed to start PTS Polling: ${error.message}`, error);
      throw error;
    }
  }

  // ============================================
  // RFID Pump Lock/Unlock Management
  // ============================================

  /**
   * Initialize pump lock mode based on station_settings.
   * In RFID mode: all pumps are locked, only RFID scan unlocks them.
   * In Manual mode: all pumps stay unlocked.
   */
  async initPumpLockMode() {
    try {
      const result = await database.query(
        'SELECT attendant_mode FROM station_settings LIMIT 1'
      );

      const mode = result.rows.length > 0 ? result.rows[0].attendant_mode : 'manual';

      if (mode === 'rfid') {
        this.addLog('info', '🏷️ Station is in RFID mode — pumps require PumpAuthorize via card scan');
        this.rfidModeActive = true;
      } else {
        this.addLog('info', '🔓 Station is in MANUAL mode — pumps operate freely');
        this.rfidModeActive = false;
      }
    } catch (error) {
      this.addLog('warn', `⚠️ Could not check station mode, defaulting to manual: ${error.message}`);
      this.rfidModeActive = false;
    }
  }

  /**
   * Lock all active pumps at this station.
   * Queries the pumps table and sends PumpLock for each.
   */
  async lockAllPumps() {
    try {
      const result = await database.query(
        'SELECT pts2_pump_id FROM pumps WHERE is_active = true ORDER BY pts2_pump_id'
      );

      const pumpNumbers = result.rows.map(r => r.pts2_pump_id);
      this.addLog('info', `🔒 Locking ${pumpNumbers.length} pumps: [${pumpNumbers.join(',')}]`);

      let locked = 0;
      for (const pumpNumber of pumpNumbers) {
        try {
          await this.lockPump(pumpNumber);
          this.lockedPumps.add(pumpNumber);
          locked++;
        } catch (err) {
          this.addLog('warn', `⚠️ Failed to lock pump ${pumpNumber}: ${err.message}`);
        }
      }

      this.addLog('info', `✅ Locked ${locked}/${pumpNumbers.length} pumps`);
      this.broadcast('allPumpsLocked', { pumps: Array.from(this.lockedPumps), count: locked });
    } catch (error) {
      this.addLog('error', `❌ Failed to lock all pumps: ${error.message}`);
    }
  }

  /**
   * Unlock all active pumps at this station.
   */
  async unlockAllPumps() {
    try {
      const result = await database.query(
        'SELECT pts2_pump_id FROM pumps WHERE is_active = true ORDER BY pts2_pump_id'
      );

      const pumpNumbers = result.rows.map(r => r.pts2_pump_id);
      this.addLog('info', `🔓 Unlocking ${pumpNumbers.length} pumps: [${pumpNumbers.join(',')}]`);

      let unlocked = 0;
      for (const pumpNumber of pumpNumbers) {
        try {
          await this.unlockPump(pumpNumber);
          this.lockedPumps.delete(pumpNumber);
          unlocked++;
        } catch (err) {
          this.addLog('warn', `⚠️ Failed to unlock pump ${pumpNumber}: ${err.message}`);
        }
      }

      // Clear any pending relock timeouts
      for (const [pump, timer] of this.unlockTimeouts) {
        clearTimeout(timer);
      }
      this.unlockTimeouts.clear();

      this.addLog('info', `✅ Unlocked ${unlocked}/${pumpNumbers.length} pumps`);
      this.broadcast('allPumpsUnlocked', { pumps: pumpNumbers, count: unlocked });
    } catch (error) {
      this.addLog('error', `❌ Failed to unlock all pumps: ${error.message}`);
    }
  }

  /**
   * Switch RFID lock mode on/off.
   * Called when station_settings.attendant_mode changes.
   * @param {string} mode - 'rfid' or 'manual'
   */
  async switchPumpLockMode(mode) {
    if (mode === 'rfid') {
      this.addLog('info', '🏷️ Switching to RFID mode — pumps require PumpAuthorize via card scan');
      this.rfidModeActive = true;
    } else {
      this.addLog('info', '🔓 Switching to MANUAL mode — pumps operate freely');
      this.rfidModeActive = false;
    }
  }

  /**
   * Authorize pumps for an RFID scan.
   * Sends PumpAuthorize once per pump and returns. PTS-2 owns the transaction
   * lifecycle from that point on (AutoCloseTransaction = true).
   * @param {number[]} pumpIds - Pump numbers to authorize
   * @param {object} attendant - { id, no, name }
   */
  async unlockPumpsForRfid(pumpIds, attendant, tagNumber) {
    const attendantLabel = attendant.name || attendant.no || attendant.id;

    for (const pumpId of pumpIds) {
      const status = this.fuelService?.pumpStatuses?.get(pumpId);
      const pumpType = status?.Type;

      if (pumpType && pumpType !== 'PumpIdleStatus') {
        this.addLog('warn', `⏸️ Pump ${pumpId} is ${pumpType} — ignoring scan, won't re-authorize`);
        continue;
      }

      try {
        await this.authorizePumpRfid(pumpId, tagNumber);
        this.addLog('info', `✅ Pump ${pumpId} authorized for ${attendantLabel} (tag: ${tagNumber || 'none'})`);
      } catch (err) {
        this.addLog('error', `❌ Failed to authorize pump ${pumpId} for RFID: ${err.message}`);
      }
    }

    this.broadcast('pumpsUnlockedForRfid', {
      pumpIds,
      attendant: attendantLabel
    });
  }

  /**
   * Setup RFID reader integration
   */
  setupRfidIntegration() {
    try {
      // Lazy load RFID service to avoid circular dependency
      if (!rfidReaderService) {
        rfidReaderService = require('./rfid-reader.service');
      }

      // Listen for RFID tag reads
      rfidReaderService.on('attendantIdentified', (data) => {
        this.handleRfidTagRead(data);
      });

      rfidReaderService.on('unknownTag', (data) => {
        this.addLog('warn', `❓ Unknown RFID tag: ${data.tagNumber}`);
        this.broadcast('unknownRfidTag', data);
      });

      // Listen for enrollment scans (dedicated tag-registration reader)
      rfidReaderService.on('enrollmentScan', (data) => {
        this.addLog('info', `🆕 Enrollment scan: ${data.tag_number} (new: ${data.is_new}, assigned: ${data.is_assigned})`);
        this.broadcast('enrollmentScan', data);
      });

      this.addLog('info', '🏷️ RFID integration enabled');

    } catch (error) {
      this.addLog('warn', `⚠️ RFID integration not available: ${error.message}`);
    }
  }

  /**
   * Handle RFID tag read event
   * RFID is for TRACKING only — no PTS authorization is sent.
   * Sets per-pump RFID context so subsequent transactions get attributed.
   */
  handleRfidTagRead(data) {
    const pumpIds = data.pumpIds || [];
    const attendant = {
      id: data.attendantId,
      no: data.attendantNo,
      name: data.attendantName
    };

    // Initialize per-pump context map if needed
    if (!this.rfidContexts) {
      this.rfidContexts = new Map();
    }

    const now = new Date();

    // Set RFID context for ALL nozzle-pumps this reader covers
    for (const pumpId of pumpIds) {
      this.rfidContexts.set(pumpId, {
        tagNumber: data.tagNumber,
        attendant: attendant,
        readTime: now,
        readerId: data.readerId,
        stationId: data.stationId
      });
    }

    this.addLog('info', `🏷️ RFID context set: ${data.attendantName || data.attendantNo} (${data.tagNumber}) → Pumps [${pumpIds.join(',')}]`);

    // RFID mode: auto-assign attendant to pumps in the current open shift
    this.autoAssignAttendantIfRfidMode(data);

    // RFID lock mode: authorize the pumps for this scan (with auto-relock timeout)
    if (this.rfidModeActive && pumpIds.length > 0) {
      this.unlockPumpsForRfid(pumpIds, attendant, data.tagNumber);
    }

    // Broadcast RFID scan to WebSocket clients (for UI display)
    this.broadcast('rfidScan', {
      tagNumber: data.tagNumber,
      attendantId: data.attendantId,
      attendantName: data.attendantName || data.attendantNo,
      pumpIds: pumpIds,
      timestamp: now.toISOString()
    });

    // Also broadcast legacy event
    this.broadcast('rfidTagRead', {
      tagNumber: data.tagNumber,
      attendant: attendant,
      pumpIds: pumpIds,
      timestamp: now.toISOString()
    });
  }

  /**
   * Auto-assign attendant to nozzle-pumps when shift is in RFID mode.
   * Creates shift_attendants entries so cashup knows who was on which pump.
   */
  async autoAssignAttendantIfRfidMode(data) {
    try {
      const pumpIds = data.pumpIds || [];
      if (!data.attendantId || pumpIds.length === 0) return;

      // Find the current open shift at this station
      const shiftResult = await database.query(
        `SELECT id, attendant_mode FROM shifts 
         WHERE station_id = $1 AND status = 'open' 
         ORDER BY start_datetime DESC LIMIT 1`,
        [data.stationId || this.stationId]
      );

      if (shiftResult.rows.length === 0) return;
      const shift = shiftResult.rows[0];

      if (shift.attendant_mode !== 'rfid') return;

      // Auto-assign attendant to ALL nozzle-pumps this reader covers
      for (const pumpId of pumpIds) {
        await database.query(
          `INSERT INTO shift_attendants (shift_id, attendant_id, pump_id, created_at)
           VALUES ($1, $2, $3, now())
           ON CONFLICT DO NOTHING`,
          [shift.id, data.attendantId, pumpId]
        );
      }

      this.addLog('info', `🏷️ RFID auto-assigned ${data.attendantName || data.attendantNo} to pumps [${pumpIds.join(',')}] (shift ${shift.id.substring(0, 8)})`);
    } catch (error) {
      this.addLog('warn', `⚠️ RFID auto-assign failed: ${error.message}`);
    }
  }

  // NOTE: authorizeAndStorePump and authorizePumpWithAmount removed.
  // RFID is for tracking only — pumps are not authorized via RFID scan.
  // PTS authorization is handled separately (manual or always-on).

  /**
   * Get RFID context for a specific pump (for transaction linking)
   * @param {number} pumpNumber - The pump/nozzle number
   * @returns {object|null} RFID context or null if expired/missing
   */
  getRfidContextForPump(pumpNumber) {
    if (!this.rfidContexts || !this.rfidContexts.has(pumpNumber)) {
      return null;
    }

    const ctx = this.rfidContexts.get(pumpNumber);

    // Check if RFID tag is still valid (within validity window)
    const age = Date.now() - ctx.readTime.getTime();
    if (age > this.rfidTagValidityMs) {
      this.addLog('debug', `RFID context for pump ${pumpNumber} expired (${Math.round(age / 1000)}s old)`);
      this.rfidContexts.delete(pumpNumber);
      return null;
    }

    return {
      tagNumber: ctx.tagNumber,
      attendant: ctx.attendant,
      readTime: ctx.readTime,
      readerId: ctx.readerId,
      ageMs: age
    };
  }

  /**
   * Clear RFID context for a specific pump (after transaction is linked)
   * @param {number} pumpNumber - The pump/nozzle number
   */
  clearRfidContextForPump(pumpNumber) {
    if (this.rfidContexts) {
      this.rfidContexts.delete(pumpNumber);
    }
  }

  /**
   * Clear all RFID contexts (e.g. on shift close)
   */
  clearAllRfidContexts() {
    if (this.rfidContexts) {
      this.rfidContexts.clear();
    }
    this.addLog('debug', 'Cleared all RFID contexts');
  }

  /**
   * Get all active RFID contexts (for UI display)
   * @returns {object[]} Array of active contexts with pump numbers
   */
  getActiveRfidContexts() {
    if (!this.rfidContexts) return [];

    const active = [];
    const now = Date.now();

    for (const [pumpNumber, ctx] of this.rfidContexts.entries()) {
      const age = now - ctx.readTime.getTime();
      if (age <= this.rfidTagValidityMs) {
        active.push({
          pumpId: pumpNumber,
          tagNumber: ctx.tagNumber,
          attendantId: ctx.attendant?.id,
          attendantName: ctx.attendant?.name || ctx.attendant?.no,
          readTime: ctx.readTime.toISOString(),
          ageSeconds: Math.round(age / 1000),
          readerId: ctx.readerId
        });
      } else {
        this.rfidContexts.delete(pumpNumber);
      }
    }

    return active;
  }

  /**
   * Validate attendant has an open shift and return shift details
   * @param {string} attendantId - UUID of the attendant
   * @returns {object} { success: boolean, shift?: object, error?: string }
   */
  async validateAndGetOpenShift(attendantId) {
    try {
      const result = await database.query(`
        SELECT 
          ast.id,
          ast.station_id,
          ast.attendant_id,
          ast.tag_number,
          ast.started_at,
          a.name as attendant_name,
          a.no as attendant_no
        FROM attendant_shifts ast
        LEFT JOIN attendants a ON a.id = ast.attendant_id
        WHERE ast.attendant_id = $1
          AND ast.station_id = $2
          AND ast.is_open = true
          AND ast.ended_at IS NULL
        ORDER BY ast.started_at DESC
        LIMIT 1
      `, [attendantId, this.stationId]);

      if (result.rows.length === 0) {
        this.addLog('warn', `⚠️ No open shift for attendant ${attendantId} at station ${this.stationId}`);
        return {
          success: false,
          error: `No open shift found for attendant at this station. Please open a shift first.`
        };
      }

      const shift = result.rows[0];
      this.addLog('info', `✅ Found open shift ${shift.id} for ${shift.attendant_name || shift.attendant_no}`);

      return {
        success: true,
        shift: shift
      };
    } catch (error) {
      this.addLog('error', `❌ Error checking shift: ${error.message}`);
      return {
        success: false,
        error: `Error checking shift: ${error.message}`
      };
    }
  }

  /**
   * Set authorization context (shift info for pump authorization)
   * This will be used when the transaction completes
   * @param {object} context - { shiftId, attendantId, attendantName, tagNumber, pumpNumber }
   */
  setAuthorizationContext(context) {
    // Store context keyed by pump number for when transaction completes
    if (!this.authorizationContexts) {
      this.authorizationContexts = {};
    }

    this.authorizationContexts[context.pumpNumber] = {
      ...context,
      timestamp: new Date()
    };

    this.addLog('info', `🔐 Authorization context set for pump ${context.pumpNumber}: shift=${context.shiftId}`);
  }

  /**
   * Get authorization context for a pump
   * @param {number} pumpNumber - Pump number
   * @returns {object|null} Authorization context or null
   */
  getAuthorizationContext(pumpNumber) {
    if (!this.authorizationContexts || !this.authorizationContexts[pumpNumber]) {
      return null;
    }

    const context = this.authorizationContexts[pumpNumber];

    // Check if context is still valid (within 30 minutes)
    const age = Date.now() - context.timestamp.getTime();
    const maxAgeMs = 30 * 60 * 1000; // 30 minutes

    if (age > maxAgeMs) {
      this.addLog('debug', `Authorization context for pump ${pumpNumber} expired`);
      delete this.authorizationContexts[pumpNumber];
      return null;
    }

    return context;
  }

  /**
   * Clear authorization context for a pump (after transaction stored)
   * @param {number} pumpNumber - Pump number
   */
  clearAuthorizationContext(pumpNumber) {
    if (this.authorizationContexts && this.authorizationContexts[pumpNumber]) {
      delete this.authorizationContexts[pumpNumber];
      this.addLog('debug', `Cleared authorization context for pump ${pumpNumber}`);
    }
  }

  /**
   * Continuously poll PTS-2 for all pump transactions (Pump=0) and store in
   * pump_transaction_reports. Uses MAX(datetime_end) as the rolling start window
   * so each run only fetches new transactions.
   */
  async pollAndStorePumpTransactions() {
    if (!this.fuelService || !this.fuelService.ptsClient) {
      this.addLog('debug', 'Transaction report poll skipped – PTS not connected');
      return;
    }

    // Determine start of query window: last recorded datetime_end, or 24h ago
    let dateTimeStart;
    try {
      const lastRow = await database.queryLocal(
        `SELECT MAX(datetime_end) AS last_end FROM pump_transaction_reports`
      );
      const lastEnd = lastRow.rows[0]?.last_end;
      if (lastEnd) {
        // Overlap by 5 seconds to avoid missing transactions on boundary
        const d = new Date(lastEnd);
        d.setSeconds(d.getSeconds() - 5);
        dateTimeStart = d.toISOString().slice(0, 19);
      } else {
        const yesterday = new Date();
        yesterday.setHours(yesterday.getHours() - 24);
        dateTimeStart = yesterday.toISOString().slice(0, 19);
      }
    } catch {
      const yesterday = new Date();
      yesterday.setHours(yesterday.getHours() - 24);
      dateTimeStart = yesterday.toISOString().slice(0, 19);
    }

    // End of window is now (minus 3 seconds to avoid in-progress transactions)
    const endDate = new Date();
    endDate.setSeconds(endDate.getSeconds() - 3);
    const dateTimeEnd = endDate.toISOString().slice(0, 19);

    this.addLog('info', `📊 Polling all pump transactions: ${dateTimeStart} → ${dateTimeEnd}`);

    // Pump=0 returns ALL pumps in a single packet (per PTS-2 spec note 2)
    const response = await this.fuelService.ptsClient.createComplexRequest([{
      function: this.fuelService.ptsClient.ReportGetPumpTransactions.bind(this.fuelService.ptsClient),
      arguments: [0, dateTimeStart, dateTimeEnd]
    }]);

    if (!response.Packets || !response.Packets[0]) {
      this.addLog('warn', '⚠️ No packet in transaction report response');
      return;
    }

    const packet = response.Packets[0];
    if (packet.Error) {
      this.addLog('warn', `⚠️ Transaction report error: ${packet.Message}`);
      return;
    }

    const transactions = Array.isArray(packet.Data) ? packet.Data : [];
    if (transactions.length === 0) {
      this.addLog('debug', '📊 No new pump transactions found');
      return;
    }

    this.addLog('info', `📊 Storing ${transactions.length} pump transaction(s)`);

    let stored = 0;
    const polledAt = new Date().toISOString();

    for (const tx of transactions) {
      try {
        await database.queryLocal(`
          INSERT INTO pump_transaction_reports
            (station_id, pump, nozzle, fuel_grade_id, fuel_grade_name, transaction_number,
             datetime_start, datetime_end, volume, tc_volume, price, amount,
             total_volume, total_amount, tag, flow_rate, is_offline, is_paid, user_id, polled_at)
          VALUES
            ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)
          ON CONFLICT (pump, transaction_number, datetime_end) DO NOTHING
        `, [
          this.stationId || null,
          tx.Pump,
          tx.Nozzle ?? null,
          tx.FuelGradeId ?? null,
          tx.FuelGradeName ?? null,
          tx.Transaction,
          tx.DateTimeStart ? new Date(tx.DateTimeStart).toISOString() : null,
          new Date(tx.DateTime).toISOString(),
          tx.Volume ?? null,
          tx.TCVolume ?? null,
          tx.Price ?? null,
          tx.Amount ?? null,
          tx.TotalVolume ?? null,
          tx.TotalAmount ?? null,
          tx.Tag ?? null,
          tx.FlowRate ?? null,
          tx.IsOffline ?? null,
          tx.IsPaid ?? null,
          tx.UserId ?? null,
          polledAt,
        ]);
        stored++;
      } catch (err) {
        this.addLog('warn', `⚠️ Failed to store transaction ${tx.Transaction} pump ${tx.Pump}: ${err.message}`);
      }
    }

    this.addLog('info', `✅ Stored ${stored} / ${transactions.length} pump transactions`);
  }

  /**
   * Stop the polling service
   */
  async stop() {
    if (!this.isRunning) {
      return;
    }

    this.addLog('info', '🛑 Stopping PTS Polling Service');

    if (this.fuelService) {
      await this.fuelService.stopPolling();
      this.fuelService.removeAllListeners();
      this.fuelService = null;
    }

    // Remove RFID listeners
    if (rfidReaderService) {
      rfidReaderService.removeAllListeners('attendantIdentified');
      rfidReaderService.removeAllListeners('unknownTag');
    }

    // Clear all unlock timeout timers
    for (const [pump, timer] of this.unlockTimeouts) {
      clearTimeout(timer);
    }
    this.unlockTimeouts.clear();
    this.lockedPumps.clear();

    if (this.transactionPollInterval) {
      clearInterval(this.transactionPollInterval);
      this.transactionPollInterval = null;
    }

    this.isRunning = false;
    this.addLog('info', '✅ PTS Polling Service stopped');
  }

  /**
   * Force an immediate poll
   */
  async forcePoll() {
    if (!this.fuelService) {
      throw new Error('PTS service not running');
    }

    this.addLog('info', '🔄 Forcing immediate poll...');

    await this.fuelService.pollAllPumps();
    await this.fuelService.pollAllTanks();

    return {
      success: true,
      pumps: this.getCachedPumpsStatus(),
      tanks: this.getCachedTanksStatus()
    };
  }

  /**
   * Get cached pump statuses
   */
  getCachedPumpsStatus(pumpNumber = null) {
    if (!this.fuelService) {
      return pumpNumber ? null : [];
    }

    const statuses = this.fuelService.getPumpStatuses();

    if (pumpNumber) {
      return statuses[pumpNumber] || null;
    }

    return Object.entries(statuses).map(([pump, status]) => ({
      pump: parseInt(pump),
      ...status,
      lastUpdate: new Date().toISOString()
    }));
  }

  /**
   * Get cached tank statuses
   */
  getCachedTanksStatus(tankNumber = null) {
    if (!this.fuelService) {
      return tankNumber ? null : [];
    }

    const statuses = this.fuelService.getTankStatuses();

    if (tankNumber) {
      return statuses[tankNumber] || null;
    }

    return Object.entries(statuses).map(([tank, status]) => ({
      tank: parseInt(tank),
      ...status,
      lastUpdate: new Date().toISOString()
    }));
  }

  /**
   * Persist a throttled tank measurement row (time-series for trend reports).
   * Stores at most one row per tank per tankMeasurementIntervalMs. Idempotent
   * on (pts2_tank_id, date_time) so duplicate timestamps are ignored.
   * `status` is the raw PTS ProbeMeasurements Data block.
   */
  async storeTankMeasurement(tankNumber, status) {
    if (!status || tankNumber == null) return;

    // Throttle: skip if we stored a row for this tank recently.
    const now = Date.now();
    const last = this.tankMeasurementLastStored.get(tankNumber) || 0;
    if (now - last < this.tankMeasurementIntervalMs) return;

    // Measurement timestamp: prefer the probe's DateTime, else now.
    const dateTime = status.DateTime || new Date().toISOString();

    const result = await database.queryLocal(
      `INSERT INTO tank_measurements
        (station_id, pts2_tank_id, date_time, fuel_grade_id, fuel_grade_name, status,
         alarms, product_height, water_height, temperature, product_volume,
         water_volume, product_ullage, tank_filling_percentage)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
       ON CONFLICT (pts2_tank_id, date_time) DO NOTHING
       RETURNING id`,
      [
        this.stationId, tankNumber, dateTime,
        status.FuelGradeId != null ? status.FuelGradeId : null,
        status.FuelGradeName || null,
        status.Status || null,
        Array.isArray(status.Alarms) ? JSON.stringify(status.Alarms) : null,
        status.ProductHeight != null ? status.ProductHeight : null,
        status.WaterHeight != null ? status.WaterHeight : null,
        status.Temperature != null ? status.Temperature : null,
        status.ProductVolume != null ? status.ProductVolume : null,
        status.WaterVolume != null ? status.WaterVolume : null,
        status.ProductUllage != null ? status.ProductUllage : null,
        status.TankFillingPercentage != null ? status.TankFillingPercentage : null
      ]
    );

    // Only advance the throttle clock once a row is committed (or de-duped).
    this.tankMeasurementLastStored.set(tankNumber, now);
    if (result.rows && result.rows.length > 0) {
      this.addLog('debug', `📈 Stored tank ${tankNumber} measurement (${dateTime})`);
    }
  }

  /**
   * Close a transaction on PTS-2 (acknowledges PumpEndOfTransactionStatus)
   * Per protocol: PTS-2 keeps sending PumpEndOfTransactionStatus until PumpCloseTransaction is sent
   */
  async closeTransaction(pumpNumber, transactionNumber) {
    if (!this.fuelService) {
      throw new Error('PTS service not running');
    }

    this.addLog('info', `📋 Closing transaction #${transactionNumber} on pump ${pumpNumber}`);

    const response = await this.fuelService.ptsClient.createComplexRequest([{
      function: this.fuelService.ptsClient.PumpCloseTransaction.bind(this.fuelService.ptsClient),
      arguments: [pumpNumber, transactionNumber]
    }]);

    if (response.Packets && response.Packets[0]) {
      if (response.Packets[0].Error) {
        throw new Error(response.Packets[0].Message || 'Close transaction failed');
      }
      this.addLog('info', `✅ Transaction #${transactionNumber} closed on pump ${pumpNumber}`);
      return response.Packets[0].Data;
    }

    throw new Error('Invalid response');
  }

  /**
   * Authorize a pump for RFID fueling via PumpAuthorize.
   * FullTank type — attendant sets dose at the pump keypad.
   * No nozzle restriction — whichever nozzle is lifted gets authorized.
   * AutoCloseTransaction = true — PTS-2 auto-closes when fueling ends.
   */
  async authorizePumpRfid(pumpNumber, tagHex) {
    if (!this.fuelService) {
      throw new Error('PTS service not running');
    }

    this.addLog('info', `🏷️ Authorizing pump ${pumpNumber} via RFID (tag: ${tagHex || 'none'})`);

    const response = await this.fuelService.ptsClient.createComplexRequest([{
      function: this.fuelService.ptsClient.PumpAuthorize.bind(this.fuelService.ptsClient),
      arguments: [pumpNumber, null, 'FullTank', null, null, { tag: tagHex, autoClose: true, noTagVerification: true }]
    }]);

    if (response.Packets && response.Packets[0]) {
      if (response.Packets[0].Error) {
        throw new Error(response.Packets[0].Message || 'Authorize failed');
      }
      this.addLog('info', `✅ Pump ${pumpNumber} authorized (transaction: ${response.Packets[0].Data?.Transaction || 'pending'})`);
      return response.Packets[0].Data;
    }

    throw new Error('Invalid response');
  }

  /**
   * Lock a pump
   */
  async lockPump(pumpNumber) {
    if (!this.fuelService) {
      throw new Error('PTS service not running');
    }

    this.addLog('info', `🔒 Locking pump ${pumpNumber}`);

    const response = await this.fuelService.ptsClient.createComplexRequest([{
      function: this.fuelService.ptsClient.PumpLock.bind(this.fuelService.ptsClient),
      arguments: [pumpNumber]
    }]);

    if (response.Packets && response.Packets[0]) {
      if (response.Packets[0].Error) {
        throw new Error(response.Packets[0].Message || 'Lock failed');
      }
      this.addLog('info', `✅ Pump ${pumpNumber} locked`);
      return response.Packets[0].Data;
    }

    throw new Error('Invalid response');
  }

  /**
   * Unlock a pump
   */
  async unlockPump(pumpNumber) {
    if (!this.fuelService) {
      throw new Error('PTS service not running');
    }

    this.addLog('info', `🔓 Unlocking pump ${pumpNumber}`);

    const response = await this.fuelService.ptsClient.createComplexRequest([{
      function: this.fuelService.ptsClient.PumpUnlock.bind(this.fuelService.ptsClient),
      arguments: [pumpNumber]
    }]);

    if (response.Packets && response.Packets[0]) {
      if (response.Packets[0].Error) {
        throw new Error(response.Packets[0].Message || 'Unlock failed');
      }
      this.addLog('info', `✅ Pump ${pumpNumber} unlocked`);
      return response.Packets[0].Data;
    }

    throw new Error('Invalid response');
  }

  /**
   * Authorize a pump
   */
  async authorizePump(pumpNumber, nozzle, presetType, presetDose, price, user) {
    if (!this.fuelService) {
      throw new Error('PTS service not running');
    }

    this.addLog('info', `✅ Authorizing pump ${pumpNumber}`, { nozzle, presetType, presetDose, price, user });

    return await this.fuelService.authorizePump(pumpNumber, nozzle, presetType, presetDose, price, user);
  }

  /**
   * Stop a pump
   */
  async stopPump(pumpNumber) {
    if (!this.fuelService) {
      throw new Error('PTS service not running');
    }

    this.addLog('warn', `🛑 Stopping pump ${pumpNumber}`);
    return await this.fuelService.stopPump(pumpNumber);
  }

  /**
   * Emergency stop a pump
   */
  async emergencyStopPump(pumpNumber) {
    if (!this.fuelService) {
      throw new Error('PTS service not running');
    }

    this.addLog('warn', `🚨 EMERGENCY STOP pump ${pumpNumber}`);
    return await this.fuelService.emergencyStopPump(pumpNumber);
  }

  /**
   * Suspend (pause) a pump filling
   */
  async suspendPump(pumpNumber) {
    if (!this.fuelService?.ptsClient) {
      throw new Error('PTS service not running');
    }

    this.addLog('warn', `⏸️ Suspending pump ${pumpNumber}`);
    const response = await this.fuelService.ptsClient.createComplexRequest([
      {
        function: this.fuelService.ptsClient.PumpSuspend.bind(this.fuelService.ptsClient),
        arguments: [pumpNumber],
      },
    ]);
    if (response?.Packets?.[0]?.Error) {
      throw new Error(response.Packets[0].Error);
    }
    return response?.Packets?.[0]?.Data;
  }

  /**
   * Resume a suspended pump
   */
  async resumePump(pumpNumber) {
    if (!this.fuelService?.ptsClient) {
      throw new Error('PTS service not running');
    }

    this.addLog('info', `▶️ Resuming pump ${pumpNumber}`);
    const response = await this.fuelService.ptsClient.createComplexRequest([
      {
        function: this.fuelService.ptsClient.PumpResume.bind(this.fuelService.ptsClient),
        arguments: [pumpNumber],
      },
    ]);
    if (response?.Packets?.[0]?.Error) {
      throw new Error(response.Packets[0].Error);
    }
    return response?.Packets?.[0]?.Data;
  }

  /**
   * Store a completed transaction (online or offline)
   * This is called when PTS reports a transaction complete
   */
  async storeTransaction(data, ptsTransaction = null) {
    // Primary source: PTS-2 transaction details (has Tag, Volume, Amount, FuelGrade, DateTime)
    // Fallback: RFID context maps (legacy approach)
    let tagNumber = null;
    let attendantId = null;
    let shiftId = null;
    let amount = 0;

    // 1. Get tag from PTS transaction (most reliable — PTS-2 stored it during PumpAuthorize)
    if (ptsTransaction?.Tag) {
      tagNumber = ptsTransaction.Tag;
      this.addLog('info', `🏷️ Tag from PTS transaction: ${tagNumber}`);
    }

    // 2. Get amount from PTS transaction details, fallback to status packet
    if (ptsTransaction?.Amount) {
      amount = ptsTransaction.Amount;
    } else {
      amount = data.status?.Data?.Amount || data.status?.Data?.LastAmount || data.status?.Data?.Volume || data.status?.Data?.LastVolume || 0;
    }

    // 3. Look up attendant from tag (PTS tag → DB lookup)
    if (tagNumber) {
      try {
        const attendantResult = await database.query(`
          SELECT a.id as attendant_id, COALESCE(a.full_name, 'Unknown') as attendant_name
          FROM rfid_tags t
          JOIN attendants a ON t.attendant_id = a.id
          WHERE UPPER(t.tag_number) = UPPER($1)
            AND t.is_active = true
            AND t.station_id = $2
          LIMIT 1
        `, [tagNumber, this.stationId]);

        if (attendantResult.rows.length > 0) {
          attendantId = attendantResult.rows[0].attendant_id;
          this.addLog('info', `👤 Attendant from PTS tag: ${attendantResult.rows[0].attendant_name} (${tagNumber})`);

          // Find open shift for this attendant
          const shiftResult = await database.query(`
            SELECT ast.id FROM attendant_shifts ast
            WHERE ast.station_id = $1 AND ast.attendant_id = $2 AND ast.ended_at IS NULL
            ORDER BY ast.started_at DESC LIMIT 1
          `, [this.stationId, attendantId]);

          if (shiftResult.rows.length > 0) {
            shiftId = shiftResult.rows[0].id;
            this.addLog('info', `📋 Shift from PTS tag attendant: ${shiftId}`);
          }
        } else {
          // Try legacy attendants.tag_number column
          const legacyResult = await database.query(`
            SELECT a.id as attendant_id, COALESCE(a.full_name, 'Unknown') as attendant_name
            FROM attendants a
            WHERE UPPER(a.tag_number) = UPPER($1) AND a.blocked = false AND a.station_id = $2
            LIMIT 1
          `, [tagNumber, this.stationId]);

          if (legacyResult.rows.length > 0) {
            attendantId = legacyResult.rows[0].attendant_id;
            this.addLog('info', `👤 Attendant from legacy tag: ${legacyResult.rows[0].attendant_name} (${tagNumber})`);
          }
        }
      } catch (lookupErr) {
        this.addLog('warn', `⚠️ Tag→attendant lookup failed: ${lookupErr.message}`);
      }
    }

    // 4. Fallback to RFID context if PTS had no tag (non-RFID authorization)
    if (!tagNumber) {
      const authContext = this.getAuthorizationContext(data.pump);
      const rfidContext = this.getRfidContextForPump(data.pump);

      if (authContext) {
        shiftId = authContext.shiftId;
        attendantId = authContext.attendantId;
        tagNumber = authContext.tagNumber;
        this.addLog('info', `🔐 Fallback: auth context shift=${shiftId}`);
        this.clearAuthorizationContext(data.pump);
      } else if (rfidContext) {
        attendantId = rfidContext.attendant?.id;
        tagNumber = rfidContext.tagNumber;
        this.addLog('info', `🏷️ Fallback: RFID context tag=${tagNumber}`);
        this.clearRfidContextForPump(data.pump);
      }
    } else {
      // Clean up contexts since PTS tag was used
      this.clearAuthorizationContext(data.pump);
      this.clearRfidContextForPump(data.pump);
    }

    const txn = {
      company_id: this.companyId,
      station_id: this.stationId,
      pump_id: data.pump,
      transaction_id: data.transaction,
      amount: amount,
      currency: 'ZMW',
      time: ptsTransaction?.DateTime || ptsTransaction?.DateTimeStart || new Date().toISOString(),
      tag_number: tagNumber,
      shift_id: shiftId,
      attendant_id: attendantId
    };

    // Skip if missing critical data
    if (!txn.station_id || !txn.company_id) {
      this.addLog('warn', '⚠️ Cannot store transaction - missing station_id or company_id');
      return;
    }

    // Store the fill in fuel_transactions_raw — the table every report, shift
    // reconciliation and the transactions page reads from.
    //
    // This write used to be gated on `connectionStatus.isOnline`, which means
    // "is Supabase reachable". Supabase was retired, so the gate was false for
    // good and every completed fill fell through to `pending_transactions` —
    // a table nothing reads and nothing drains. The gate was wrong regardless:
    // at a station `database.query()` targets the LOCAL pool (see
    // utils/database.js), so this INSERT never needed the internet at all.
    //
    // Pushing onward to a remote is a separate, best-effort concern; it must not
    // decide whether the station keeps its own books.
    {
      try {
        const result = await database.query(`
          INSERT INTO fuel_transactions_raw 
          (company_id, station_id, pump_id, transaction_id, amount, currency, time, tag_number, shift_id, attendant_id, is_verified, created_at)
          VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, false, NOW())
          ON CONFLICT (station_id, pump_id, transaction_id) DO NOTHING
          RETURNING id
        `, [
          txn.company_id,
          txn.station_id,
          txn.pump_id,
          txn.transaction_id,
          txn.amount,
          txn.currency,
          txn.time,
          txn.tag_number,
          txn.shift_id,
          txn.attendant_id
        ]);

        if (result.rows.length > 0) {
          this.addLog('info', `✅ Transaction stored: ${result.rows[0].id} (shift: ${txn.shift_id || 'none'})`);

          // Best effort — a queue failure must not cost us the transaction we
          // have already committed above.
          try {
            await dualDb.addToSyncQueue('fuel_transactions_raw', result.rows[0].id, 'INSERT', txn);
          } catch (queueError) {
            this.addLog('warn', `Stored, but could not queue for sync: ${queueError.message}`);
          }

          // If we don't have shift, try to link to open shift as fallback
          if (!txn.shift_id) {
            await this.linkTransactionToShift(result.rows[0].id, txn);
          }
        } else {
          this.addLog('debug', `Transaction ${txn.transaction_id} already exists (duplicate)`);
        }
        return;
      } catch (dbError) {
        this.addLog('error', `Could not store transaction ${txn.transaction_id}: ${dbError.message} — parking it in pending_transactions`);
        // Fall through to the parking table
      }
    }

    // Last resort: the INSERT above genuinely failed. Park the payload so the
    // fill is not lost, and replay it with scripts/replay-pending-transactions.js.
    //
    // Only (type, data, created_at) are written. This used to also name
    // company_id, station_id and status — columns that exist in NO definition of
    // this table (see scripts/setup-local-schema.js and
    // scripts/migrate-add-missing-tables.js, which agree on
    // id/type/data/created_at/synced/sync_attempts/last_error). So the "safe"
    // fallback threw every time it was reached and the fill was dropped, not
    // parked. Everything a replay needs is inside the JSON payload anyway.
    try {
      const result = await database.queryLocal(`
        INSERT INTO pending_transactions (type, data, created_at)
        VALUES ('fuel_transaction', $1, NOW())
        RETURNING id
      `, [JSON.stringify(txn)]);
      this.addLog('warn', `💾 Transaction parked in pending_transactions: ${result.rows[0]?.id} — NOT visible in reports until replayed`);
    } catch (localError) {
      this.addLog('error', `Failed to store transaction locally: ${localError.message}`);
    }
  }

  /**
   * Try to link a remote transaction to an open shift
   * @param {number} transactionId - Database ID of the transaction
   * @param {object} txn - Transaction data
   * @param {object} rfidAttendant - Optional attendant from RFID scan
   */
  async linkTransactionToShift(transactionId, txn, rfidAttendant = null) {
    try {
      // If we have RFID attendant, use that directly
      if (rfidAttendant?.id) {
        // Find open shift for this attendant at this station
        const shiftResult = await database.query(`
          SELECT ast.id
          FROM attendant_shifts ast
          WHERE ast.station_id = $1
            AND ast.attendant_id = $2
            AND ast.ended_at IS NULL
          ORDER BY ast.started_at DESC
          LIMIT 1
        `, [txn.station_id, rfidAttendant.id]);

        if (shiftResult.rows.length > 0) {
          await database.query(`
            UPDATE fuel_transactions_raw 
            SET shift_id = $1, attendant_id = $2
            WHERE id = $3
          `, [shiftResult.rows[0].id, rfidAttendant.id, transactionId]);

          this.addLog('info', `🔗 Linked transaction to RFID attendant shift ${shiftResult.rows[0].id}`);
          return;
        } else {
          // No shift but we have RFID - at least link the attendant
          await database.query(`
            UPDATE fuel_transactions_raw 
            SET attendant_id = $1
            WHERE id = $2
          `, [rfidAttendant.id, transactionId]);

          this.addLog('info', `🔗 Linked transaction to RFID attendant (no active shift)`);
          return;
        }
      }

      // Fallback: Find any open shift for this station
      const shiftResult = await database.query(`
        SELECT ast.id, ast.attendant_id
        FROM attendant_shifts ast
        WHERE ast.station_id = $1
          AND ast.ended_at IS NULL
          AND ast.started_at <= $2
        ORDER BY ast.started_at DESC
        LIMIT 1
      `, [txn.station_id, txn.time]);

      if (shiftResult.rows.length > 0) {
        const shift = shiftResult.rows[0];
        await database.query(`
          UPDATE fuel_transactions_raw 
          SET shift_id = $1, attendant_id = $2
          WHERE id = $3
        `, [shift.id, shift.attendant_id, transactionId]);

        this.addLog('info', `🔗 Linked transaction to shift ${shift.id}`);
      }
    } catch (linkError) {
      this.addLog('debug', `Could not link transaction to shift: ${linkError.message}`);
    }
  }

  /**
   * Set station and company IDs (called during initialization)
   */
  setStationConfig(stationId, companyId) {
    this.stationId = stationId;
    this.companyId = companyId;
    this.addLog('info', `📍 Station config set: ${stationId} / ${companyId}`);
  }

  /**
   * Get service status
   */
  async getStatus() {
    // Get local transaction stats from PostgreSQL
    let localStats = { pending: 0 };
    try {
      const result = await database.queryLocal(
        `SELECT COUNT(*) as pending FROM pending_transactions WHERE status = 'pending'`
      );
      localStats.pending = parseInt(result.rows[0]?.pending || '0');
    } catch (error) {
      // Table may not exist yet
    }

    return {
      isRunning: this.isRunning,
      config: {
        url: this.config.url,
        username: this.config.username,
        pollingInterval: this.config.pollingInterval,
        stationId: this.stationId,
        companyId: this.companyId
      },
      rfidLockMode: {
        active: this.rfidModeActive,
        lockedPumps: Array.from(this.lockedPumps),
        pendingRelockTimeouts: Array.from(this.unlockTimeouts.keys()),
        unlockTimeoutSeconds: this.unlockTimeoutMs / 1000
      },
      configuredPumps: this.fuelService ? this.fuelService.getConfiguredPumps() : [],
      configuredTanks: this.fuelService ? this.fuelService.getConfiguredProbes() : [],
      wsClients: this.wsClients.size,
      logCount: this.logs.length,
      localTransactions: localStats,
      connectionOnline: connectionStatus.isOnline
    };
  }

  /**
   * Get pump transaction report from PTS controller
   * @param {number|number[]} pumpNumbers - Pump number(s) to query
   * @param {string} dateTimeStart - Start datetime (ISO format)
   * @param {string} dateTimeEnd - End datetime (ISO format)
   * @returns {Promise<Array>} Array of transaction objects from PTS
   */
  async getReportPumpTransactions(pumpNumbers, dateTimeStart, dateTimeEnd) {
    if (!this.fuelService || !this.fuelService.ptsClient) {
      throw new Error('PTS service not running');
    }

    // Normalize to array
    const pumps = Array.isArray(pumpNumbers) ? pumpNumbers : [pumpNumbers];

    // Sanitize datetime strings (trim whitespace/newlines from URL params)
    const startClean = dateTimeStart.trim();
    const endClean = dateTimeEnd.trim();

    this.addLog('info', `📊 Fetching pump transaction report`, {
      pumps,
      dateTimeStart: startClean,
      dateTimeEnd: endClean
    });

    // Build one command per pump
    const commands = pumps.map(pumpNumber => ({
      function: this.fuelService.ptsClient.ReportGetPumpTransactions.bind(this.fuelService.ptsClient),
      arguments: [pumpNumber, startClean, endClean]
    }));

    const response = await this.fuelService.ptsClient.createComplexRequest(commands);

    // Debug: log the raw PTS response
    this.addLog('debug', '📊 Raw PTS report response', {
      hasPackets: !!response.Packets,
      packetCount: response.Packets ? response.Packets.length : 0,
      packets: response.Packets ? response.Packets.map(p => ({
        Id: p.Id,
        Type: p.Type,
        Error: p.Error,
        Message: p.Message,
        dataIsArray: Array.isArray(p.Data),
        dataLength: Array.isArray(p.Data) ? p.Data.length : (p.Data ? 'object' : 'null')
      })) : []
    });

    // Collect transactions from all packets
    const allTransactions = [];

    if (response.Packets) {
      response.Packets.forEach((packet, index) => {
        if (packet.Error === true) {
          this.addLog('warn', `⚠️ Report error for pump ${pumps[index]}: ${packet.Message}`);
          return;
        }

        // Data is an array of transaction objects for ReportPumpTransactions
        const transactions = Array.isArray(packet.Data) ? packet.Data : [];
        this.addLog('info', `📊 Pump ${pumps[index]}: ${transactions.length} transactions found`);
        allTransactions.push(...transactions);
      });
    }

    return allTransactions;
  }

  // ═══════════════════════════════════════════════
  //  FUEL GRADES & PRICE SCHEDULER
  // ═══════════════════════════════════════════════

  /**
   * Get fuel grades configuration from PTS-2
   */
  async getFuelGradesConfiguration() {
    if (!this.fuelService || !this.fuelService.ptsClient) {
      throw new Error('PTS service not running');
    }

    const response = await this.fuelService.ptsClient.createComplexRequest([{
      function: this.fuelService.ptsClient.GetFuelGradesConfiguration.bind(this.fuelService.ptsClient),
      arguments: []
    }]);

    if (response.Packets && response.Packets[0]) {
      if (response.Packets[0].Error) {
        throw new Error(response.Packets[0].Message || 'Failed to get fuel grades');
      }
      return response.Packets[0].Data;
    }
    throw new Error('Invalid response');
  }

  /**
   * Get current fuel grade prices from PTS-2
   */
  async getFuelGradesPrices() {
    if (!this.fuelService || !this.fuelService.ptsClient) {
      throw new Error('PTS service not running');
    }

    const response = await this.fuelService.ptsClient.createComplexRequest([{
      function: this.fuelService.ptsClient.GetFuelGradesPrices.bind(this.fuelService.ptsClient),
      arguments: []
    }]);

    if (response.Packets && response.Packets[0]) {
      if (response.Packets[0].Error) {
        throw new Error(response.Packets[0].Message || 'Failed to get prices');
      }
      return response.Packets[0].Data;
    }
    throw new Error('Invalid response');
  }

  /**
   * Set fuel grade prices immediately on PTS-2
   * @param {Array} fuelGrades - [{Id, Name, Price}]
   */
  async setFuelGradesPrices(fuelGrades) {
    if (!this.fuelService || !this.fuelService.ptsClient) {
      throw new Error('PTS service not running');
    }

    const normalizedFuelGrades = (Array.isArray(fuelGrades) ? fuelGrades : [])
      .map((fg) => {
        const fuelGradeId = Number(fg.FuelGradeId ?? fg.Id);
        const price = Number(fg.Price);
        if (!Number.isInteger(fuelGradeId) || fuelGradeId < 1 || fuelGradeId > 10) {
          return null;
        }
        if (!Number.isFinite(price) || price < 0) {
          return null;
        }
        return {
          FuelGradeId: fuelGradeId,
          Price: price,
        };
      })
      .filter(Boolean);

    if (normalizedFuelGrades.length === 0) {
      throw new Error('No valid fuel grade prices supplied');
    }

    this.addLog('info', `💰 Setting fuel grade prices: ${JSON.stringify(normalizedFuelGrades)}`);

    const response = await this.fuelService.ptsClient.createComplexRequest([{
      function: this.fuelService.ptsClient.SetFuelGradesPrices.bind(this.fuelService.ptsClient),
      arguments: [normalizedFuelGrades]
    }]);

    if (response.Packets && response.Packets[0]) {
      if (response.Packets[0].Error) {
        throw new Error(response.Packets[0].Message || 'Failed to set prices');
      }
      this.addLog('info', `✅ Fuel grade prices updated`);
      return response.Packets[0].Data;
    }
    throw new Error('Invalid response');
  }

  /**
   * Get price scheduler configuration from PTS-2
   */
  async getPricesSchedulerConfiguration() {
    if (!this.fuelService || !this.fuelService.ptsClient) {
      throw new Error('PTS service not running');
    }

    const response = await this.fuelService.ptsClient.createComplexRequest([{
      function: this.fuelService.ptsClient.GetPricesSchedulerConfiguration.bind(this.fuelService.ptsClient),
      arguments: []
    }]);

    if (response.Packets && response.Packets[0]) {
      if (response.Packets[0].Error) {
        throw new Error(response.Packets[0].Message || 'Failed to get scheduler');
      }
      return response.Packets[0].Data;
    }
    throw new Error('Invalid response');
  }

  /**
   * Set price scheduler configuration on PTS-2
   * @param {Array} schedules - [{Id, Enabled, FuelGradeId, Price, DateTime, EveryMonday...}]
   */
  async setPricesSchedulerConfiguration(schedules) {
    if (!this.fuelService || !this.fuelService.ptsClient) {
      throw new Error('PTS service not running');
    }

    this.addLog('info', `📅 Setting price schedules: ${schedules.length} entries`);

    const response = await this.fuelService.ptsClient.createComplexRequest([{
      function: this.fuelService.ptsClient.SetPricesSchedulerConfiguration.bind(this.fuelService.ptsClient),
      arguments: [schedules]
    }]);

    if (response.Packets && response.Packets[0]) {
      if (response.Packets[0].Error) {
        throw new Error(response.Packets[0].Message || 'Failed to set schedules');
      }
      this.addLog('info', `✅ Price schedules updated`);
      return response.Packets[0].Data;
    }
    throw new Error('Invalid response');
  }

  /**
   * Get prices for a specific pump from PTS-2
   */
  async getPumpPrices(pumpNumber) {
    if (!this.fuelService || !this.fuelService.ptsClient) {
      throw new Error('PTS service not running');
    }

    const response = await this.fuelService.ptsClient.createComplexRequest([{
      function: this.fuelService.ptsClient.PumpGetPrices.bind(this.fuelService.ptsClient),
      arguments: [pumpNumber]
    }]);

    if (response.Packets && response.Packets[0]) {
      if (response.Packets[0].Error) {
        throw new Error(response.Packets[0].Message || 'Failed to get pump prices');
      }
      return response.Packets[0].Data;
    }
    throw new Error('Invalid response');
  }

  /**
   * Set prices for a specific pump on PTS-2
   * @param {number} pumpNumber
   * @param {Array} prices - array of price objects
   */
  async setPumpPrices(pumpNumber, prices) {
    if (!this.fuelService || !this.fuelService.ptsClient) {
      throw new Error('PTS service not running');
    }

    this.addLog('info', `💰 Setting prices for pump ${pumpNumber}`);

    const response = await this.fuelService.ptsClient.createComplexRequest([{
      function: this.fuelService.ptsClient.PumpSetPrices.bind(this.fuelService.ptsClient),
      arguments: [pumpNumber, prices]
    }]);

    if (response.Packets && response.Packets[0]) {
      if (response.Packets[0].Error) {
        throw new Error(response.Packets[0].Message || 'Failed to set pump prices');
      }
      this.addLog('info', `✅ Pump ${pumpNumber} prices updated`);
      return response.Packets[0].Data;
    }
    throw new Error('Invalid response');
  }
}

// Export singleton
module.exports = new PTSPollingService();

