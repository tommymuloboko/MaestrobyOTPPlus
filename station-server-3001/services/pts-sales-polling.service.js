/**
 * PTS Sales Polling Service
 * Fetches transaction data from PTS-2 pump terminal system
 * and stores raw sales data in the database
 * 
 * This service polls PTS for all completed transactions at regular intervals
 * and stores them in the pts_sales table for later retrieval and verification
 */

const EventEmitter = require('events');
const logger = require('../utils/logger')('PTSSalesPolling');
const PTSClient = require('../lib/pts-client');
const db = require('../utils/db');

class PTSSalesPollingService extends EventEmitter {
  constructor() {
    super();
    this.isRunning = false;
    this.ptsClient = null;
    this.pollingInterval = parseInt(process.env.PTS_SALES_POLLING_INTERVAL) || 30000; // 30 seconds
    this.stationId = process.env.STATION_ID || process.env.OFFLINE_STATION_ID;
    this.companyId = process.env.COMPANY_ID || process.env.OFFLINE_COMPANY_ID;
    this.ptsConfig = {
      url: process.env.PTS_URL || 'https://192.168.1.90/jsonPTS',
      username: process.env.PTS_USERNAME || 'admin',
      password: process.env.PTS_PASSWORD || 'admin',
      timeout: parseInt(process.env.PTS_TIMEOUT) || 30000
    };

    // Track state
    this.lastProcessedTransactionId = 0;
    this.pollingTimer = null;
    this.unsupportedLogged = false;
  }

  /**
   * Start the PTS sales polling service
   */
  async start() {
    if (this.isRunning) {
      logger.warn('PTSSalesPollingService already running');
      return;
    }

    logger.info('🚀 Starting PTS Sales Polling Service');

    if (!this.stationId || !this.companyId) {
      logger.error('❌ Station ID or Company ID not configured');
      return;
    }

    try {
      // Initialize PTS client
      this.ptsClient = new PTSClient(this.ptsConfig);

      // Load last processed transaction ID
      await this.loadLastProcessedTransactionId();

      this.isRunning = true;
      logger.info(`✅ Service started (polling every ${this.pollingInterval}ms)`);
      logger.info(`📍 Station: ${this.stationId}, Company: ${this.companyId}`);
      logger.info(`📊 Last processed transaction ID: ${this.lastProcessedTransactionId}`);

      // Start polling
      this.startPolling();

    } catch (error) {
      logger.error('❌ Failed to start service:', error);
      this.isRunning = false;
    }
  }

  /**
   * Stop the polling service
   */
  stop() {
    if (!this.isRunning) return;

    logger.info('🛑 Stopping PTS Sales Polling Service');
    this.isRunning = false;

    if (this.pollingTimer) {
      clearInterval(this.pollingTimer);
      this.pollingTimer = null;
    }
  }

  /**
   * Start the polling loop
   */
  startPolling() {
    this.pollingTimer = setInterval(() => {
      this.pollTransactions()
        .catch(error => logger.error('Poll cycle failed:', error));
    }, this.pollingInterval);

    // Also run once immediately
    this.pollTransactions()
      .catch(error => logger.error('Initial poll failed:', error));
  }

  /**
   * Load the last processed transaction ID from database
   */
  async loadLastProcessedTransactionId() {
    try {
      const result = await db.query(
        `SELECT COALESCE(MAX(pts_transaction_id), 0) as last_id 
         FROM pts_sales 
         WHERE station_id = $1`,
        [this.stationId]
      );

      this.lastProcessedTransactionId = result.rows[0]?.last_id || 0;
      logger.info(`📥 Loaded last transaction ID: ${this.lastProcessedTransactionId}`);

    } catch (error) {
      logger.warn('Could not load last transaction ID:', error.message);
      this.lastProcessedTransactionId = 0;
    }
  }

  /**
   * Poll transactions from PTS
   */
  async pollTransactions() {
    if (!this.ptsClient) return;

    try {
      // Get transactions from past hour (or configurable window)
      const now = new Date();
      const fromTime = new Date(now.getTime() - (60 * 60 * 1000)); // Last 1 hour

      // The PTS-2 works in station wall-clock (Africa/Lusaka) with no zone suffix,
      // so UTC here would ask it for a window two hours in its past.
      const pad = (n) => String(n).padStart(2, '0');
      const fmt = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
                       + `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
      const fromDateTime = fmt(fromTime);
      const toDateTime = fmt(now);

      logger.debug(`🔍 Polling transactions from ${fromDateTime} to ${toDateTime}`);

      // Build request
      const request = {
        Protocol: 'jsonPTS',
        Packets: [
          {
            Id: 1,
            Type: 'QueryTransactions',
            Data: {
              FromDateTime: fromDateTime,
              ToDateTime: toDateTime,
              Pump: null, // Get all pumps
              Limit: 100
            }
          }
        ]
      };

      const response = await this.ptsClient.sendRequest(JSON.stringify(request));

      if (!response || !response.Packets || response.Packets.length === 0) {
        logger.debug('📭 No transactions in response');
        return;
      }

      const packet = response.Packets[0];
      if (packet.Error) {
        // This controller does not implement QueryTransactions and answers
        // JSONPTS_ERROR_NOT_FOUND on every cycle. Say so once rather than every 30s,
        // so the log keeps its signal. ReportGetPumpTransactions is the working path
        // (see pump-report-polling.service.js) and is what actually feeds reports.
        if (packet.Message === 'JSONPTS_ERROR_NOT_FOUND') {
          if (!this.unsupportedLogged) {
            this.unsupportedLogged = true;
            logger.warn('⚠️ This PTS-2 does not support QueryTransactions — sales polling is inert. '
                      + 'Pump reports come from ReportGetPumpTransactions instead. Suppressing further notices.');
          }
          return;
        }
        logger.warn(`⚠️ PTS error: ${packet.Message}`);
        return;
      }

      const transactions = packet.Data?.Transactions || [];
      logger.info(`📊 Received ${transactions.length} transactions from PTS`);

      if (transactions.length === 0) {
        logger.debug('No new transactions');
        return;
      }

      // Store transactions
      let storedCount = 0;
      for (const txn of transactions) {
        if (await this.storeTransaction(txn)) {
          storedCount++;
        }
      }

      logger.info(`✅ Stored ${storedCount}/${transactions.length} transactions`);
      this.emit('transactionsPoll', { stored: storedCount, received: transactions.length });

    } catch (error) {
      logger.error('❌ Poll error:', error.message);
      this.emit('pollError', error);
    }
  }

  /**
   * Store a single transaction in the database
   * @param {Object} txn - Transaction from PTS
   * @returns {Promise<Boolean>} - True if stored, false if duplicate or error
   */
  async storeTransaction(txn) {
    try {
      // Skip if we've already processed this transaction
      if (txn.TransactionId <= this.lastProcessedTransactionId) {
        logger.debug(`⏭️ Skipping duplicate transaction ID: ${txn.TransactionId}`);
        return false;
      }

      // Check if already exists
      const existing = await db.query(
        `SELECT id FROM pts_sales 
         WHERE station_id = $1 AND pts_transaction_id = $2`,
        [this.stationId, txn.TransactionId]
      );

      if (existing.rows.length > 0) {
        logger.debug(`⏭️ Transaction already exists: ${txn.TransactionId}`);
        return false;
      }

      // Insert transaction
      await db.query(
        `INSERT INTO pts_sales (
          company_id,
          station_id,
          pump_id,
          nozzle,
          fuel_grade,
          fuel_grade_id,
          volume,
          amount,
          unit_price,
          currency,
          pts_transaction_id,
          transaction_state,
          start_time,
          end_time
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
        ON CONFLICT (station_id, pts_transaction_id) DO NOTHING`,
        [
          this.companyId,
          this.stationId,
          txn.Pump,
          txn.Nozzle,
          txn.FuelGrade,
          txn.FuelGradeId,
          txn.Volume,
          txn.Amount,
          txn.UnitPrice,
          txn.Currency || 'ZMW',
          txn.TransactionId,
          txn.State || 'Completed',
          txn.StartTime,
          txn.EndTime
        ]
      );

      // Update last processed transaction ID
      if (txn.TransactionId > this.lastProcessedTransactionId) {
        this.lastProcessedTransactionId = txn.TransactionId;
      }

      logger.debug(`✅ Stored transaction ${txn.TransactionId}: ${txn.Volume}L @ ${txn.Amount}`);
      return true;

    } catch (error) {
      if (error.message.includes('duplicate key')) {
        logger.debug(`⏭️ Duplicate transaction ID: ${txn.TransactionId}`);
        return false;
      }
      logger.error(`❌ Failed to store transaction ${txn.TransactionId}:`, error.message);
      return false;
    }
  }

  /**
   * Get current service status
   */
  getStatus() {
    return {
      isRunning: this.isRunning,
      pollingInterval: this.pollingInterval,
      stationId: this.stationId,
      companyId: this.companyId,
      lastProcessedTransactionId: this.lastProcessedTransactionId,
      ptsConnected: this.ptsClient ? true : false
    };
  }
}

// Singleton instance
const ptsSalesPollingService = new PTSSalesPollingService();

module.exports = ptsSalesPollingService;
