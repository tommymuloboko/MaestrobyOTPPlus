/**
 * Pump Report Polling Service
 *
 * Periodically calls ReportGetPumpTransactions (jsonPTS protocol #184) on
 * the PTS-2 controller for ALL pumps (Pump = 0) and stores the full
 * report-grade response into the pump_report_transactions table.
 *
 * This provides General Maestro Reports data including:
 *   - TC Volume, totals, RFID tag, flow rate, offline flag, paid status
 *
 * Environment variables:
 *   PUMP_REPORT_POLLING_INTERVAL  polling interval in ms (default: 60000)
 *   PUMP_REPORT_POLLING_WINDOW_MS time window per poll cycle in ms (default: 3600000 = 1h)
 *   PTS_URL / PTS_USERNAME / PTS_PASSWORD / PTS_TIMEOUT  (shared with other PTS services)
 *   STATION_ID / COMPANY_ID
 */

const EventEmitter = require('events');
const logger = require('../utils/logger')('PumpReportPolling');
const PTSClient = require('../lib/pts-client');
const db = require('../utils/db');

/**
 * Format a Date to PTS date-time string: YYYY-MM-DDThh:mm:ss
 *
 * The PTS-2 speaks the station's wall-clock (Africa/Lusaka) and emits no zone
 * suffix — a probe read at 19:42 CAT comes back as "...T19:42:55". Rendering our
 * side with toISOString() therefore handed it UTC, asking for a window two hours
 * in its own past. The report poller trailed real time permanently and returned
 * zero records forever. Format from local components so both ends agree.
 */
function toPtsDateTime(date) {
  const p = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`
       + `T${p(date.getHours())}:${p(date.getMinutes())}:${p(date.getSeconds())}`;
}

class PumpReportPollingService extends EventEmitter {
  constructor() {
    super();
    this.isRunning = false;
    this.ptsClient = null;
    this.pollingTimer = null;

    this.pollingInterval = parseInt(process.env.PUMP_REPORT_POLLING_INTERVAL) || 60000; // 1 min
    this.windowMs = parseInt(process.env.PUMP_REPORT_POLLING_WINDOW_MS) || 86400000;    // 24h default fallback (used only on very first run)

    this.stationId = process.env.STATION_ID || process.env.OFFLINE_STATION_ID;
    this.companyId = process.env.COMPANY_ID || process.env.OFFLINE_COMPANY_ID;

    this.ptsConfig = {
      url:      process.env.PTS_URL      || 'https://192.168.1.90/jsonPTS',
      username: process.env.PTS_USERNAME || 'admin',
      password: process.env.PTS_PASSWORD || 'admin',
      timeout:  parseInt(process.env.PTS_TIMEOUT) || 30000,
    };

    // Tracks the upper boundary of the last completed poll window
    this.lastPolledEndTime = null;
  }

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  async start() {
    if (this.isRunning) {
      logger.warn('PumpReportPollingService already running');
      return;
    }

    if (!this.stationId || !this.companyId) {
      logger.error('❌ STATION_ID / COMPANY_ID not configured — pump report polling disabled');
      return;
    }

    logger.info('🚀 Starting Pump Report Polling Service');
    logger.info(`   Interval : ${this.pollingInterval}ms`);
    logger.info(`   Window   : ${this.windowMs}ms`);
    logger.info(`   Station  : ${this.stationId}`);
    logger.info(`   Company  : ${this.companyId}`);

    try {
      this.ptsClient = new PTSClient(this.ptsConfig);
      await this._loadLastPolledTime();

      this.isRunning = true;
      this._startPollingLoop();
    } catch (error) {
      logger.error('❌ Failed to start service:', error.message);
      this.isRunning = false;
    }
  }

  stop() {
    if (!this.isRunning) return;
    logger.info('🛑 Stopping Pump Report Polling Service');
    this.isRunning = false;
    if (this.pollingTimer) {
      clearInterval(this.pollingTimer);
      this.pollingTimer = null;
    }
  }

  getStatus() {
    return {
      isRunning:       this.isRunning,
      pollingInterval: this.pollingInterval,
      windowMs:        this.windowMs,
      stationId:       this.stationId,
      companyId:       this.companyId,
      lastPolledEndTime: this.lastPolledEndTime,
      ptsConnected:    !!this.ptsClient,
    };
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  _startPollingLoop() {
    // Run once immediately, then on interval
    this._pollCycle().catch(err => logger.error('Initial poll failed:', err.message));

    this.pollingTimer = setInterval(() => {
      this._pollCycle().catch(err => logger.error('Poll cycle failed:', err.message));
    }, this.pollingInterval);
  }

  /**
   * Load the end_time of the most recent stored record for this station
   * so that we resume from where we left off after a restart.
   */
  async _loadLastPolledTime() {
    try {
      const result = await db.query(
        `SELECT MAX(end_time) AS last_end FROM pump_report_transactions WHERE station_id = $1`,
        [this.stationId]
      );
      const lastEnd = result.rows[0]?.last_end;
      if (lastEnd) {
        this.lastPolledEndTime = new Date(lastEnd);
        logger.info(`📥 Resuming from last end_time: ${this.lastPolledEndTime.toISOString()}`);
      } else {
        // First run — start from beginning of today so we catch all of today's transactions
        const startOfDay = new Date();
        startOfDay.setHours(0, 0, 0, 0);
        this.lastPolledEndTime = startOfDay;
        logger.info(`📥 No prior records — starting from beginning of today: ${this.lastPolledEndTime.toISOString()}`);
      }
    } catch (error) {
      logger.warn('Could not load last polled time, defaulting to start of today:', error.message);
      const startOfDay = new Date();
      startOfDay.setHours(0, 0, 0, 0);
      this.lastPolledEndTime = startOfDay;
    }
  }

  /**
   * One poll cycle: request the time window [lastPolledEndTime, now] from PTS.
   */
  async _pollCycle() {
    if (!this.ptsClient || !this.isRunning) return;

    const dateTimeStart = toPtsDateTime(this.lastPolledEndTime);
    const now = new Date();
    const dateTimeEnd = toPtsDateTime(now);

    logger.debug(`🔍 ReportGetPumpTransactions  ${dateTimeStart} → ${dateTimeEnd}`);

    // Use the existing PTSClient method — Pump=0 means all pumps
    const request = {
      Protocol: 'jsonPTS',
      Packets: [{
        Id: 1,
        Type: 'ReportGetPumpTransactions',
        Data: this.ptsClient.ReportGetPumpTransactions(0, dateTimeStart, dateTimeEnd)
      }]
    };

    let response;
    try {
      response = await this.ptsClient.sendRequest(JSON.stringify(request));
    } catch (error) {
      logger.error('❌ PTS request failed:', error.message);
      this.emit('pollError', error);
      return;
    }

    if (!response?.Packets?.length) {
      logger.debug('📭 Empty response from PTS');
      this.lastPolledEndTime = now;
      return;
    }

    const packet = response.Packets[0];
    if (packet.Error) {
      logger.warn(`⚠️  PTS packet error: ${packet.Message}`);
      return;
    }

    const records = Array.isArray(packet.Data) ? packet.Data : [];
    logger.info(`📊 Received ${records.length} report records from PTS`);

    if (records.length === 0) {
      this.lastPolledEndTime = now;
      return;
    }

    let stored = 0;
    for (const rec of records) {
      if (await this._storeRecord(rec)) stored++;
    }

    logger.info(`✅ Stored ${stored}/${records.length} report records`);
    this.lastPolledEndTime = now;
    this.emit('reportsPoll', { stored, received: records.length });
  }

  /**
   * Persist one ReportPumpTransactions record to pump_report_transactions.
   * Returns true if inserted, false if duplicate or error.
   */
  async _storeRecord(rec) {
    try {
      // Map jsonPTS field names to our columns
      const transactionNumber = rec.Transaction;
      if (!transactionNumber) {
        logger.debug('Skipping record with no Transaction number');
        return false;
      }

      const startTime = rec.DateTimeStart ? new Date(rec.DateTimeStart) : null;
      const endTime   = rec.DateTime      ? new Date(rec.DateTime)      : null; // "DateTime" = end

      await db.query(
        `INSERT INTO pump_report_transactions (
          company_id,
          station_id,
          pump_id,
          nozzle,
          fuel_grade_id,
          fuel_grade_name,
          transaction_number,
          volume,
          tc_volume,
          price,
          amount,
          total_volume,
          total_amount,
          tag,
          flow_rate,
          is_offline,
          is_paid,
          pts_user_id,
          start_time,
          end_time
        ) VALUES (
          $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,
          $11,$12,$13,$14,$15,$16,$17,$18,$19,$20
        )
        ON CONFLICT (station_id, transaction_number) DO NOTHING`,
        [
          this.companyId,
          this.stationId,
          rec.Pump,
          rec.Nozzle          || null,
          rec.FuelGradeId     || null,
          rec.FuelGradeName   || null,
          transactionNumber,
          rec.Volume,
          rec.TCVolume        || null,
          rec.Price           || null,
          rec.Amount,
          rec.TotalVolume     || null,
          rec.TotalAmount     || null,
          rec.Tag             || null,
          rec.FlowRate        ?? null,
          rec.IsOffline       ?? false,
          rec.IsPaid          ?? false,
          rec.UserId          || null,
          startTime,
          endTime,
        ]
      );

      logger.debug(`✅ Stored report txn #${transactionNumber} pump ${rec.Pump}`);
      return true;

    } catch (error) {
      if (error.message.includes('duplicate key') || error.message.includes('unique')) {
        logger.debug(`⏭️  Duplicate report txn #${rec.Transaction}`);
        return false;
      }
      logger.error(`❌ Failed to store report txn #${rec.Transaction}:`, error.message);
      return false;
    }
  }
}

// Singleton
const pumpReportPollingService = new PumpReportPollingService();
module.exports = pumpReportPollingService;
