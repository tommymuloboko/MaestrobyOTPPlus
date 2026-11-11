/**
 * IS8540-Q-A RFID Reader Service
 * Handles TCP/IP communication with IS8540-Q-A card readers
 * via HI-LINK WiFi-serial bridge modules.
 * 
 * Protocol: ISO14443 Type-A, STX/ETX framed packets with BCC checksum
 * Packet: [0xAA] [STATION_ID] [DATALENGTH] [CMD/STATUS] [DATA...] [BCC] [0xBB]
 * 
 * Reader Specs:
 * - Default Port: 8080 (via HI-LINK bridge)
 * - Bridge Baudrate: 9600 (must be configured in HI-LINK web UI)
 * - Mode: Poll-based (GET_SNR every 500ms)
 * 
 * Supports:
 * - Multiple readers (one per pump)
 * - LED/Buzzer feedback (success/denied)
 * - Auto-reconnect with exponential backoff
 * - Stale connection detection
 */

const net = require('net');
const EventEmitter = require('events');
const logger = require('../utils/logger')('RFIDReader');
const database = require('../utils/database');

// IS8540 protocol constants
const START_BYTE = 0xAA;
const END_BYTE = 0xBB;

class RFIDReaderService extends EventEmitter {
  constructor() {
    super();
    
    // Multi-reader support
    this.readers = new Map();        // reader key -> config
    this.connections = new Map();     // reader key -> socket
    this.pollIntervals = new Map();   // reader key -> poll interval
    this.rxBuffers = new Map();       // reader key -> receive buffer
    this.retryTimers = new Map();     // reader key -> timeout
    this.retryAttempts = new Map();   // reader key -> attempt count
    this.lastActivity = new Map();    // reader key -> timestamp
    this.lastCardReads = new Map();   // reader key -> {hex, timestamp}

    // Timing configuration
    this.CARD_DEBOUNCE_MS = parseInt(process.env.RFID_DEDUP_MS) || 2000;
    this.POLL_INTERVAL_MS = parseInt(process.env.RFID_POLL_INTERVAL_MS) || 500;
    this.MAX_RETRY_DELAY = 30000;      // Max 30 seconds between retries
    this.CONNECTION_TIMEOUT = 10000;    // 10 second connection timeout
    this.SOCKET_TIMEOUT = 120000;       // 2 minute socket timeout for idle
    this.MONITOR_INTERVAL = 15000;      // Health check every 15 seconds

    // Station context
    this.stationId = process.env.OFFLINE_STATION_ID || process.env.STATION_ID || null;
    this.companyId = process.env.OFFLINE_COMPANY_ID || process.env.COMPANY_ID || null;

    // Service state
    this.isRunning = false;
    this.monitorInterval = null;
    this.enabled = process.env.RFID_ENABLED !== 'false';

    // Statistics
    this.stats = {
      totalReads: 0,
      successfulLookups: 0,
      failedLookups: 0,
      lastTagRead: null,
      lastTagTime: null
    };

    // Communication logs (circular buffer)
    this.logs = [];
    this.maxLogs = 200;
  }

  // ============================================
  // IS8540 Protocol Commands
  // ============================================

  /**
   * Build an IS8540 command packet
   * @param {number} readerStationId - Device address (0x00 for broadcast)
   * @param {number} cmd - Command byte
   * @param {number[]} data - Data bytes
   * @returns {Buffer}
   */
  buildCommand(readerStationId, cmd, data = []) {
    const dataLen = 1 + data.length;
    const packet = [START_BYTE, readerStationId, dataLen, cmd, ...data];
    let bcc = 0;
    for (let i = 1; i < packet.length; i++) bcc ^= packet[i];
    packet.push(bcc, END_BYTE);
    return Buffer.from(packet);
  }

  /**
   * Build GET_SNR command (poll for card UID)
   * @param {number} readerStationId - Device address (0x00 for broadcast)
   * @returns {Buffer}
   */
  buildGetSNR(readerStationId = 0x00) {
    return this.buildCommand(readerStationId, 0x25, [0x26, 0x00]);
  }

  /**
   * Build buzzer command
   * @param {number} readerStationId - Device address
   * @param {number} count - Number of buzzes
   * @param {number} freq - Duration of each buzz in 20ms units (5 = 100ms)
   * @returns {Buffer}
   */
  buildBuzzCommand(readerStationId = 0x00, count = 2, freq = 5) {
    return this.buildCommand(readerStationId, 0x89, [freq, count]);
  }

  /**
   * Build LED command
   * @param {number} readerStationId - Device address
   * @param {number} count - Number of flashes
   * @param {number} freq - On-time in 20ms units (5 = 100ms)
   * @param {number} mode - LED selection mode
   * @returns {Buffer}
   */
  buildLEDCommand(readerStationId = 0x00, count = 3, freq = 5, mode = 0x00) {
    return this.buildCommand(readerStationId, 0x88, [mode, freq, count]);
  }

  /**
   * Verify BCC checksum of a received frame
   */
  verifyBCC(frame) {
    let bcc = 0;
    for (let i = 1; i < frame.length - 2; i++) bcc ^= frame[i];
    return bcc === frame[frame.length - 2];
  }

  /**
   * Extract complete frames from receive buffer
   */
  extractFrames(rxBuffer) {
    const frames = [];
    while (true) {
      const startIdx = rxBuffer.indexOf(START_BYTE);
      if (startIdx === -1) { rxBuffer = Buffer.alloc(0); break; }
      if (startIdx > 0) rxBuffer = rxBuffer.slice(startIdx);
      if (rxBuffer.length < 3) break;

      const dataLen = rxBuffer[2];
      const frameLen = dataLen + 5; // STX + STATION_ID + DATALENGTH + ... + BCC + ETX
      if (dataLen === 0 || dataLen > 124) { rxBuffer = rxBuffer.slice(1); continue; }
      if (rxBuffer.length < frameLen) break;
      if (rxBuffer[frameLen - 1] !== END_BYTE) { rxBuffer = rxBuffer.slice(1); continue; }

      frames.push(rxBuffer.slice(0, frameLen));
      rxBuffer = rxBuffer.slice(frameLen);
    }
    return { frames, remaining: rxBuffer };
  }

  /**
   * Parse UID from a response frame
   * @returns {string|null} Hex UID string or null
   */
  parseUID(frame) {
    if (!this.verifyBCC(frame)) return null;
    const dataLen = frame[2];
    const status = frame[3];
    if (status !== 0x00) return null;

    if (dataLen === 0x06) {
      const uid = frame.slice(5, 9).toString('hex').toUpperCase();
      return uid !== '00000000' ? uid : null;
    } else if (dataLen === 0x05) {
      const uid = frame.slice(4, 8).toString('hex').toUpperCase();
      return uid !== '00000000' ? uid : null;
    }
    return null;
  }

  // ============================================
  // Logging
  // ============================================

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

  getLogs(limit = 50) {
    return this.logs.slice(-limit);
  }

  // ============================================
  // Service Lifecycle
  // ============================================

  /**
   * Start the RFID reader service
   */
  async start() {
    if (!this.enabled) {
      this.addLog('warn', '⚠️ RFID Reader disabled (RFID_ENABLED=false)');
      return;
    }

    if (this.isRunning) {
      this.addLog('warn', 'RFID Reader service already running');
      return;
    }

    this.isRunning = true;
    this.addLog('info', '🔄 Starting RFID Reader Service');

    // Start health monitoring
    this.startMonitoring();

    // Load and connect to all active readers from database
    await this.loadReadersFromDatabase();
  }

  /**
   * Load active readers from database and connect to them
   * Each reader covers multiple nozzle-pumps (pump_ids array)
   * RFID is for tracking only — no PTS authorization
   */
  async loadReadersFromDatabase() {
    try {
      this.addLog('info', '📡 Loading RFID readers from database...');
      
      // Query readers with their nozzle-pump assignments
      const result = await database.query(`
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
          COALESCE(r.purpose, 'pump') as purpose
        FROM rfid_readers r
        WHERE r.is_active = true
        ORDER BY r.reader_id
      `);

      if (result.rows.length === 0) {
        this.addLog('warn', '⚠️ No active RFID readers configured in database');
        this.addLog('info', '💡 Add readers via POST /api/rfid/readers');
        return;
      }

      this.addLog('info', `📡 Found ${result.rows.length} active RFID reader(s)`);

      for (const reader of result.rows) {
        const pumpIds = reader.pump_ids || [];
        this.addLog('info', `🔌 Connecting to reader: ${reader.reader_name} (${reader.ip_address}:${reader.port}) → Pumps [${pumpIds.join(',')}]`);
        this.connectReader({
          reader_id: reader.reader_id,
          company_id: reader.company_id,
          station_id: reader.station_id,
          reader_name: reader.reader_name,
          ip_address: reader.ip_address,
          port: reader.port,
          device_address: reader.device_address || 0x00,
          pump_ids: pumpIds,    // Array of nozzle-pumps this reader covers
          location: reader.location,
          purpose: reader.purpose || 'pump'
        });
      }

    } catch (error) {
      this.addLog('error', `❌ Failed to load readers from database: ${error.message}`);
      // Don't throw - service can still work if readers are added manually
    }
  }

  /**
   * Reload readers from database (useful after configuration changes)
   */
  async reloadReaders() {
    this.addLog('info', '🔄 Reloading RFID readers...');
    this.disconnectAll();
    await this.loadReadersFromDatabase();
  }

  /**
   * Stop the RFID reader service
   */
  stop() {
    this.addLog('info', '🛑 Stopping RFID Reader Service');
    this.isRunning = false;

    this.stopMonitoring();
    this.disconnectAll();

    this.addLog('info', '✅ RFID Reader Service stopped');
  }

  // ============================================
  // Reader Connection Management
  // ============================================

  /**
   * Connect to an RFID reader
   * @param {Object} readerConfig - {reader_id, ip_address, port, pump_id, device_address}
   */
  connectReader(readerConfig) {
    const key = `${readerConfig.ip_address}:${readerConfig.port}`;
    const readerStationId = readerConfig.device_address || 0x00;

    if (this.connections.has(key) && !this.connections.get(key).destroyed) {
      this.addLog('debug', `Reader ${key} already connected`);
      return;
    }

    // Clear any existing retry timer and poll interval
    if (this.retryTimers.has(key)) {
      clearTimeout(this.retryTimers.get(key));
      this.retryTimers.delete(key);
    }
    if (this.pollIntervals.has(key)) {
      clearInterval(this.pollIntervals.get(key));
      this.pollIntervals.delete(key);
    }

    const socket = new net.Socket();
    socket.setKeepAlive(true, 10000);
    socket.setTimeout(this.SOCKET_TIMEOUT);

    // Initialize receive buffer for this reader
    this.rxBuffers.set(key, Buffer.alloc(0));

    // Pre-build the GET_SNR command for this reader
    const cmdGetSNR = this.buildGetSNR(readerStationId);

    // Connection established — start polling
    socket.on('connect', () => {
      const pumpIds = readerConfig.pump_ids || [];
      this.addLog('info', `✅ Connected to RFID reader ${key} → Pumps [${pumpIds.join(',')}]`);
      this.readers.set(key, readerConfig);
      this.connections.set(key, socket);
      this.retryAttempts.set(key, 0);
      this.lastActivity.set(key, Date.now());
      this.emit('readerConnected', readerConfig);

      // Start polling for cards with GET_SNR command
      const interval = setInterval(() => {
        if (socket && !socket.destroyed) {
          socket.write(cmdGetSNR);
        }
      }, this.POLL_INTERVAL_MS);
      this.pollIntervals.set(key, interval);
      this.addLog('debug', `Started polling reader ${key} every ${this.POLL_INTERVAL_MS}ms`);
    });

    // Data received — parse IS8540 framed responses
    socket.on('data', (data) => {
      this.lastActivity.set(key, Date.now());
      this.handleReaderData(key, readerConfig, data);
    });

    // Socket timeout (idle)
    socket.on('timeout', () => {
      this.addLog('warn', `⏱️ RFID reader ${key} socket timeout - reconnecting`);
      socket.destroy();
    });

    // Error
    socket.on('error', (err) => {
      this.addLog('error', `❌ RFID reader ${key} error: ${err.message}`);
      this.emit('readerError', { readerConfig, error: err });
    });

    // Connection closed — clean up poll interval and auto-reconnect
    socket.on('close', (hadError) => {
      this.addLog('warn', `🔌 RFID reader ${key} disconnected ${hadError ? '(with error)' : ''}`);
      this.connections.delete(key);
      this.lastActivity.delete(key);
      this.rxBuffers.delete(key);

      if (this.pollIntervals.has(key)) {
        clearInterval(this.pollIntervals.get(key));
        this.pollIntervals.delete(key);
      }

      this.emit('readerDisconnected', readerConfig);

      // Auto-reconnect with exponential backoff
      if (this.isRunning) {
        this.scheduleReconnect(readerConfig);
      }
    });

    this.addLog('info', `🔌 Connecting to RFID reader ${key}...`);

    // Connection timeout
    const connectionTimeout = setTimeout(() => {
      if (!this.connections.has(key)) {
        this.addLog('error', `Connection timeout for reader ${key}`);
        socket.destroy();
      }
    }, this.CONNECTION_TIMEOUT);

    socket.once('connect', () => {
      clearTimeout(connectionTimeout);
    });

    socket.connect(readerConfig.port, readerConfig.ip_address);
  }

  /**
   * Schedule reconnection with exponential backoff
   */
  scheduleReconnect(readerConfig) {
    const key = `${readerConfig.ip_address}:${readerConfig.port}`;

    // Keep reader config for reconnection
    if (!this.readers.has(key)) {
      this.readers.set(key, readerConfig);
    }

    const attempts = this.retryAttempts.get(key) || 0;
    const delay = Math.min(1000 * Math.pow(2, attempts), this.MAX_RETRY_DELAY);

    this.addLog('debug', `Reconnecting to ${key} in ${delay / 1000}s (attempt ${attempts + 1})...`);

    const timer = setTimeout(() => {
      this.retryAttempts.set(key, attempts + 1);
      this.connectReader(readerConfig);
    }, delay);

    this.retryTimers.set(key, timer);
  }

  /**
   * Disconnect from a specific reader
   */
  disconnectReader(ipAddress, port) {
    const key = `${ipAddress}:${port}`;
    const socket = this.connections.get(key);

    if (socket) {
      socket.destroy();
    }

    if (this.pollIntervals.has(key)) {
      clearInterval(this.pollIntervals.get(key));
      this.pollIntervals.delete(key);
    }

    this.connections.delete(key);
    this.readers.delete(key);
    this.lastActivity.delete(key);
    this.lastCardReads.delete(key);
    this.rxBuffers.delete(key);

    if (this.retryTimers.has(key)) {
      clearTimeout(this.retryTimers.get(key));
      this.retryTimers.delete(key);
    }
    this.retryAttempts.delete(key);

    this.addLog('info', `Disconnected from reader ${key}`);
  }

  /**
   * Disconnect all readers
   */
  disconnectAll() {
    for (const [key, socket] of this.connections.entries()) {
      socket.destroy();
      this.addLog('debug', `Disconnected from reader ${key}`);
    }

    for (const interval of this.pollIntervals.values()) {
      clearInterval(interval);
    }

    this.connections.clear();
    this.readers.clear();
    this.pollIntervals.clear();
    this.rxBuffers.clear();
    this.lastActivity.clear();
    this.lastCardReads.clear();

    for (const timer of this.retryTimers.values()) {
      clearTimeout(timer);
    }
    this.retryTimers.clear();
    this.retryAttempts.clear();
  }

  // ============================================
  // Health Monitoring
  // ============================================

  /**
   * Start health monitoring
   */
  startMonitoring() {
    this.addLog('info', `Starting RFID reader health monitoring (every ${this.MONITOR_INTERVAL / 1000}s)`);

    this.monitorInterval = setInterval(() => {
      for (const [key, readerConfig] of this.readers.entries()) {
        const socket = this.connections.get(key);
        const connected = socket && !socket.destroyed;

        if (!connected && !this.retryTimers.has(key)) {
          this.addLog('warn', `Reader ${key} not connected, initiating reconnection...`);
          this.connectReader(readerConfig);
        } else if (connected) {
          // Check for stale connections
          const lastActivity = this.lastActivity.get(key);
          const idleTime = Date.now() - (lastActivity || Date.now());

          if (idleTime > this.SOCKET_TIMEOUT) {
            this.addLog('warn', `Reader ${key} appears stale (idle ${Math.round(idleTime / 1000)}s) - reconnecting`);
            socket.destroy();
          }
        }
      }
    }, this.MONITOR_INTERVAL);
  }

  /**
   * Stop health monitoring
   */
  stopMonitoring() {
    if (this.monitorInterval) {
      clearInterval(this.monitorInterval);
      this.monitorInterval = null;
      this.addLog('debug', 'RFID reader monitoring stopped');
    }
  }

  // ============================================
  // Data Handling (IS8540 Protocol)
  // ============================================

  /**
   * Handle data from reader (IS8540 STX/ETX framed protocol)
   * Accumulates data in per-reader rxBuffer and extracts complete frames.
   * Uses presence-based detection: only fires on the "card appeared" transition.
   * A card must be removed (no-card response) before it can trigger again.
   */
  handleReaderData(readerKey, readerConfig, data) {
    // Accumulate into per-reader receive buffer
    let rxBuffer = this.rxBuffers.get(readerKey) || Buffer.alloc(0);
    rxBuffer = Buffer.concat([rxBuffer, data]);

    // Prevent buffer overflow
    if (rxBuffer.length > 1024) rxBuffer = rxBuffer.slice(-512);

    // Extract complete frames
    const result = this.extractFrames(rxBuffer);
    this.rxBuffers.set(readerKey, result.remaining);

    for (const frame of result.frames) {
      // Parse UID from response
      const uid = this.parseUID(frame);

      if (!uid || uid.length < 8) {
        // No card present (error 0x83) or bad frame — mark card as removed
        const lastRead = this.lastCardReads.get(readerKey);
        if (lastRead && lastRead.present) {
          lastRead.present = false;
          this.lastCardReads.set(readerKey, lastRead);
        }
        continue;
      }

      // Card detected — check if this is a new presentation
      const lastRead = this.lastCardReads.get(readerKey);

      // Skip if same card is still present (hasn't been removed yet)
      if (lastRead && lastRead.hex === uid && lastRead.present) {
        continue;
      }

      // New card or same card re-presented after removal
      this.lastCardReads.set(readerKey, { hex: uid, timestamp: Date.now(), present: true });

      const pumpIds = readerConfig.pump_ids || [];
      this.addLog('info', `🏷️ Card scanned on ${readerKey} → Pumps [${pumpIds.join(',')}]: ${uid.match(/.{2}/g).join(':')}`);

      // Update stats
      this.stats.totalReads++;
      this.stats.lastTagRead = uid;
      this.stats.lastTagTime = new Date();

      // Emit raw card event
      this.emit('cardScanned', {
        reader_id: readerConfig.reader_id,
        pump_ids: readerConfig.pump_ids || [],
        ip_address: readerConfig.ip_address,
        port: readerConfig.port,
        tag_number: uid,
        tag_decimal: this.parseCardNumber(Buffer.from(uid, 'hex')),
        timestamp: new Date()
      });

      // Enrollment reader → auto-register tag, skip pump authorization
      if (readerConfig.purpose === 'enrollment') {
        this.processEnrollmentScan(uid, readerConfig);
        continue;
      }

      // Look up attendant and emit appropriate events
      this.processTagRead(uid, readerConfig);
    }
  }

  /**
   * Parse 4-byte card number to decimal
   */
  parseCardNumber(bytes) {
    const num = (bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3];
    return num.toString().padStart(10, '0');
  }

  /**
   * Process tag read - look up attendant and emit events
   * Each reader covers multiple nozzle-pumps (pump_ids array)
   * RFID is for tracking only — no PTS authorization is sent
   */
  async processTagRead(tagNumber, readerConfig) {
    const normalizedTag = tagNumber.toUpperCase();
    const pumpIds = readerConfig.pump_ids || [];

    // Look up attendant
    const attendant = await this.lookupAttendant(normalizedTag);

    if (attendant) {
      this.stats.successfulLookups++;
      this.addLog('info', `✅ Tag matched: ${attendant.attendant_name} (${normalizedTag}) → Tracking pumps [${pumpIds.join(',')}]`);

      // Send green LED/buzzer to reader
      this.sendGreenBuzzer(readerConfig.ip_address, readerConfig.port);

      // Emit matched tag event with all nozzle-pumps
      this.emit('tagRead', {
        tagNumber: normalizedTag,
        attendant: attendant,
        pumpIds: pumpIds,
        readerId: readerConfig.reader_id,
        stationId: readerConfig.station_id,
        companyId: readerConfig.company_id,
        timestamp: new Date().toISOString(),
        matched: true
      });

      // Emit attendant identified — pts-polling will set RFID context for all pumps
      this.emit('attendantIdentified', {
        attendantId: attendant.attendant_id,
        attendantName: attendant.attendant_name,
        tagNumber: normalizedTag,
        pumpIds: pumpIds,
        readerId: readerConfig.reader_id,
        stationId: readerConfig.station_id,
        companyId: readerConfig.company_id,
        timestamp: new Date().toISOString()
      });

      this.addLog('info', `🏷️ Attendant ${attendant.attendant_name} now tracking pumps [${pumpIds.join(',')}]`);

    } else {
      this.stats.failedLookups++;
      this.addLog('warn', `❓ Unknown tag: ${normalizedTag} - Access DENIED`);

      // Send red LED/buzzer to reader
      this.sendRedBuzzer(readerConfig.ip_address, readerConfig.port);

      // Emit unmatched tag event
      this.emit('tagRead', {
        tagNumber: normalizedTag,
        attendant: null,
        pumpIds: pumpIds,
        readerId: readerConfig.reader_id,
        stationId: readerConfig.station_id,
        companyId: readerConfig.company_id,
        timestamp: new Date().toISOString(),
        matched: false
      });

      this.emit('unknownTag', {
        tagNumber: normalizedTag,
        pumpIds: pumpIds,
        readerId: readerConfig.reader_id,
        stationId: readerConfig.station_id,
        companyId: readerConfig.company_id,
        timestamp: new Date().toISOString()
      });
    }
  }

  /**
   * Process a card scanned on an enrollment reader.
   * Does NOT auto-register — just checks DB and emits 'enrollmentScan' so the
   * frontend can show the tag and let the manager decide to register it.
   * Pending (unregistered) scans are kept in-memory via pendingEnrollmentScans.
   */
  async processEnrollmentScan(tagNumber, readerConfig) {
    const normalizedTag = tagNumber.toUpperCase();
    const sid = readerConfig.station_id || this.stationId;

    try {
      // Check if tag already exists at this station
      const existing = await database.query(
        `SELECT id, tag_number, attendant_id, is_active FROM rfid_tags
         WHERE UPPER(tag_number) = $1 AND station_id = $2`,
        [normalizedTag, sid]
      );

      let isRegistered = false;
      let tag = null;
      let attendantName = null;

      if (existing.rows.length > 0) {
        tag = existing.rows[0];
        isRegistered = true;
        this.addLog('info', `🏷️ Enrollment scan — existing tag ${normalizedTag} (assigned: ${!!tag.attendant_id})`);

        if (tag.attendant_id) {
          const att = await database.query(
            'SELECT full_name FROM attendants WHERE id = $1',
            [tag.attendant_id]
          );
          if (att.rows.length > 0) attendantName = att.rows[0].full_name;
        }
      } else {
        // Not in DB — add to pending in-memory list (no DB insert)
        if (!this.pendingEnrollmentScans) this.pendingEnrollmentScans = [];

        // Avoid duplicate pending entries
        const alreadyPending = this.pendingEnrollmentScans.some(
          p => p.tag_number === normalizedTag && p.station_id === sid
        );
        if (!alreadyPending) {
          this.pendingEnrollmentScans.push({
            tag_number: normalizedTag,
            station_id: sid,
            company_id: readerConfig.company_id || this.companyId,
            reader_id: readerConfig.reader_id,
            scanned_at: new Date().toISOString()
          });
          this.addLog('info', `🆕 Enrollment scan — NEW tag pending approval: ${normalizedTag}`);
        } else {
          this.addLog('info', `🏷️ Enrollment scan — tag already pending: ${normalizedTag}`);
        }
      }

      // Buzz success (card was read OK)
      this.sendGreenBuzzer(readerConfig.ip_address, readerConfig.port);

      // Emit enrollment-specific event (PTS polling will broadcast via WebSocket)
      this.emit('enrollmentScan', {
        tag_id: tag ? tag.id : null,
        tag_number: normalizedTag,
        attendant_id: tag ? (tag.attendant_id || null) : null,
        attendant_name: attendantName,
        is_new: !isRegistered,
        is_registered: isRegistered,
        is_assigned: !!(tag && tag.attendant_id),
        reader_id: readerConfig.reader_id,
        timestamp: new Date().toISOString()
      });

    } catch (error) {
      this.addLog('error', `❌ Enrollment scan error: ${error.message}`);
      this.sendRedBuzzer(readerConfig.ip_address, readerConfig.port);
    }
  }

  /**
   * Get pending (unregistered) enrollment scans.
   * Called by enrollment routes.
   */
  getPendingEnrollmentScans() {
    return this.pendingEnrollmentScans || [];
  }

  /**
   * Remove a tag from the pending list (after it's been registered).
   */
  removePendingEnrollmentScan(tagNumber) {
    if (!this.pendingEnrollmentScans) return;
    this.pendingEnrollmentScans = this.pendingEnrollmentScans.filter(
      p => p.tag_number !== tagNumber.toUpperCase()
    );
  }

  /**
   * Look up attendant by RFID tag
   * Queries LOCAL PostgreSQL — uses rfid_tags table joined to attendants
   */
  async lookupAttendant(tagNumber) {
    try {
      // Query rfid_tags → attendants. Tag must be active + assigned + attendant must be active & not blocked
      const query = `
        SELECT 
          a.id as attendant_id,
          a.company_id,
          a.station_id,
          t.tag_number,
          a.blocked,
          a.authorized_pumps,
          a.phone,
          COALESCE(a.full_name, 'Unknown') as attendant_name
        FROM rfid_tags t
        JOIN attendants a ON t.attendant_id = a.id
        WHERE UPPER(t.tag_number) = UPPER($1)
          AND t.is_active = true
          AND t.attendant_id IS NOT NULL
          AND a.blocked = false
          AND t.station_id = $2
      `;

      const result = await database.query(query, [tagNumber, this.stationId]);
      
      if (result.rows.length > 0) {
        const row = result.rows[0];
        this.addLog('info', `✅ Found attendant: ${row.attendant_name} (Tag: ${tagNumber})`);
        return {
          attendant_id: row.attendant_id,
          attendant_name: row.attendant_name,
          tag_number: row.tag_number,
          station_id: row.station_id,
          company_id: row.company_id,
          blocked: row.blocked,
          authorized_pumps: row.authorized_pumps,
          phone: row.phone,
        };
      }

      // Fallback: check old attendants.tag_number column for backward compatibility
      const fallbackResult = await database.query(`
        SELECT 
          a.id as attendant_id, a.company_id, a.station_id,
          a.tag_number, a.blocked, a.authorized_pumps, a.phone,
          COALESCE(a.full_name, 'Unknown') as attendant_name
        FROM attendants a
        WHERE UPPER(a.tag_number) = UPPER($1)
          AND a.blocked = false
          AND a.station_id = $2
      `, [tagNumber, this.stationId]);

      if (fallbackResult.rows.length > 0) {
        const row = fallbackResult.rows[0];
        this.addLog('info', `✅ Found attendant (legacy): ${row.attendant_name} (Tag: ${tagNumber})`);
        return {
          attendant_id: row.attendant_id,
          attendant_name: row.attendant_name,
          tag_number: row.tag_number,
          station_id: row.station_id,
          company_id: row.company_id,
          blocked: row.blocked,
          authorized_pumps: row.authorized_pumps,
          phone: row.phone,
        };
      }

      this.addLog('debug', `Tag ${tagNumber} not found in database`);
      return null;
    } catch (error) {
      this.addLog('error', `Error looking up tag: ${error.message}`);
      return null;
    }
  }

  // ============================================
  // LED/Buzzer Feedback (IS8540 Protocol)
  // ============================================

  /**
   * Send buzzer + LED (authorization success)
   * Buzz twice + flash LED 3 times
   */
  sendGreenBuzzer(ipAddress, port) {
    const key = `${ipAddress}:${port}`;
    const socket = this.connections.get(key);
    const readerConfig = this.readers.get(key);
    const readerStationId = readerConfig?.reader_station_id || 0x00;

    if (!socket || socket.destroyed) {
      this.addLog('error', `No connection to reader ${key}`);
      return false;
    }

    // Buzz twice (100ms each)
    socket.write(this.buildBuzzCommand(readerStationId, 2, 5), (err) => {
      if (err) {
        this.addLog('error', `Failed to send buzz to ${key}: ${err.message}`);
      }
    });

    // Flash LED 3 times (100ms each)
    setTimeout(() => {
      if (socket && !socket.destroyed) {
        socket.write(this.buildLEDCommand(readerStationId, 3, 5, 0x00));
      }
    }, 100);

    this.addLog('info', `✅ Access GRANTED signal sent to ${key}`);
    return true;
  }

  /**
   * Send buzzer + LED (authorization denied)
   * Buzz 3 times rapidly
   */
  sendRedBuzzer(ipAddress, port) {
    const key = `${ipAddress}:${port}`;
    const socket = this.connections.get(key);
    const readerConfig = this.readers.get(key);
    const readerStationId = readerConfig?.reader_station_id || 0x00;

    if (!socket || socket.destroyed) {
      this.addLog('error', `No connection to reader ${key}`);
      return false;
    }

    // Buzz 3 times (60ms each — shorter, more urgent)
    socket.write(this.buildBuzzCommand(readerStationId, 3, 3), (err) => {
      if (err) {
        this.addLog('error', `Failed to send denied buzz to ${key}: ${err.message}`);
      }
    });

    this.addLog('info', `✗ Access DENIED signal sent to ${key}`);
    return true;
  }

  /**
   * Send feedback based on pump authorization result
   */
  sendAuthorizationFeedback(ipAddress, port, authorized) {
    if (authorized) {
      return this.sendGreenBuzzer(ipAddress, port);
    } else {
      return this.sendRedBuzzer(ipAddress, port);
    }
  }

  // ============================================
  // Configuration
  // ============================================

  /**
   * Set station context
   */
  setStationConfig(stationId, companyId) {
    this.stationId = stationId;
    this.companyId = companyId;
    this.addLog('info', `📍 Station config set: ${stationId}`);
  }

  // ============================================
  // Status & Info
  // ============================================

  /**
   * Get connected readers
   */
  getConnectedReaders() {
    return Array.from(this.readers.values()).map(config => ({
      ...config,
      connected: this.isReaderConnected(config.ip_address, config.port)
    }));
  }

  /**
   * Check if reader is connected
   */
  isReaderConnected(ipAddress, port) {
    const key = `${ipAddress}:${port}`;
    const socket = this.connections.get(key);
    return socket && !socket.destroyed;
  }

  /**
   * Get service status
   */
  getStatus() {
    return {
      enabled: this.enabled,
      isRunning: this.isRunning,
      connectedReaders: this.connections.size,
      configuredReaders: this.readers.size,
      stationId: this.stationId,
      stats: this.stats
    };
  }

  /**
   * Get statistics
   */
  getStats() {
    return {
      ...this.stats,
      connectedReaders: this.connections.size,
      successRate: this.stats.totalReads > 0
        ? ((this.stats.successfulLookups / this.stats.totalReads) * 100).toFixed(2) + '%'
        : '0%'
    };
  }

  /**
   * Test connection to a specific reader
   */
  async testConnection(ipAddress, port) {
    return new Promise((resolve) => {
      const testClient = new net.Socket();
      const timeout = setTimeout(() => {
        testClient.destroy();
        resolve({ success: false, error: 'Connection timeout' });
      }, 5000);

      testClient.on('connect', () => {
        clearTimeout(timeout);
        testClient.destroy();
        resolve({ success: true, host: ipAddress, port: port });
      });

      testClient.on('error', (err) => {
        clearTimeout(timeout);
        testClient.destroy();
        resolve({ success: false, error: err.message });
      });

      testClient.connect(port, ipAddress);
    });
  }
}

// Export singleton
module.exports = new RFIDReaderService();
