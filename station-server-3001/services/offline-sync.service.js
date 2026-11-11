const logger = require('../utils/logger')('OfflineSync');
const database = require('../utils/database');
const connectionStatus = require('./connection-status.service');

class OfflineSyncService {
  constructor() {
    this.isRunning = false;
    this.isSyncing = false;
    this.syncIntervalMs = parseInt(process.env.OFFLINE_SYNC_INTERVAL_MS || '30000');
    this.batchSize = parseInt(process.env.SYNC_BATCH_SIZE || '100');
    this.maxRetries = parseInt(process.env.SYNC_MAX_RETRIES || '3');
    this.retryDelayMs = parseInt(process.env.SYNC_RETRY_DELAY_MS || '5000');
    this.exponentialBackoffMultiplier = 1.5;
    this.syncInterval = null;
    this.lastSyncTime = null;
    this.lastSyncSuccess = null;
    this.failureCount = 0;
    this.listeners = [];
    
    // Midnight cache refresh
    this.lastCacheRefresh = new Date();
    this.cacheRefreshHour = parseInt(process.env.CACHE_REFRESH_HOUR || '0');
  }

  /**
   * Ensure all local tables exist and have synced/synced_at columns
   */
  async ensureSyncColumns() {
    // Create missing tables that the sync service needs
    const createStatements = [
      `CREATE TABLE IF NOT EXISTS attendant_tags (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        attendant_id UUID NOT NULL,
        tag_uid TEXT,
        is_active BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )`,
      `CREATE TABLE IF NOT EXISTS employees (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        company_id UUID NOT NULL,
        station_id UUID NOT NULL,
        user_id UUID,
        employee_no TEXT,
        full_name TEXT NOT NULL,
        first_name TEXT,
        last_name TEXT,
        job_title TEXT,
        is_active BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )`,
      `CREATE TABLE IF NOT EXISTS fuel_transactions_raw (
        id BIGSERIAL PRIMARY KEY,
        company_id UUID NOT NULL,
        station_id UUID NOT NULL,
        shift_id UUID,
        attendant_id UUID,
        tag_number TEXT,
        full_name TEXT,
        pump_id INTEGER NOT NULL,
        time TIMESTAMPTZ NOT NULL,
        amount NUMERIC NOT NULL,
        currency CHAR(3) DEFAULT 'ZMW',
        transaction_id INTEGER NOT NULL,
        is_verified BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        synced BOOLEAN DEFAULT FALSE,
        synced_at TIMESTAMP
      )`,
      `CREATE TABLE IF NOT EXISTS fuel_transactions_verified (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        raw_id BIGINT NOT NULL,
        company_id UUID NOT NULL,
        station_id UUID NOT NULL,
        shift_id UUID,
        attendant_id UUID,
        payment_type TEXT NOT NULL,
        verified_by_user_id UUID,
        verified_at TIMESTAMPTZ DEFAULT NOW(),
        amount NUMERIC NOT NULL,
        currency CHAR(3) DEFAULT 'ZMW',
        time TIMESTAMPTZ NOT NULL,
        tag_number TEXT,
        full_name TEXT,
        pump_id INTEGER NOT NULL,
        transaction_id INTEGER NOT NULL,
        synced BOOLEAN DEFAULT FALSE,
        synced_at TIMESTAMP,
        synced_from_remote BOOLEAN DEFAULT FALSE
      )`,
      `CREATE TABLE IF NOT EXISTS tanks (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        station_id UUID NOT NULL,
        pts2_tank_id INTEGER NOT NULL,
        name TEXT,
        fuel_grade TEXT,
        capacity_liters NUMERIC,
        is_active BOOLEAN DEFAULT TRUE
      )`,
      `CREATE TABLE IF NOT EXISTS tank_readings (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        tank_id UUID NOT NULL,
        reading_time TIMESTAMPTZ NOT NULL,
        level_liters NUMERIC,
        temperature NUMERIC,
        water_level NUMERIC,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )`,
      `CREATE TABLE IF NOT EXISTS debtor_transactions (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        debtor_id UUID NOT NULL,
        date DATE DEFAULT CURRENT_DATE,
        type TEXT NOT NULL,
        doc_no TEXT,
        reference TEXT,
        description TEXT,
        debit NUMERIC DEFAULT 0,
        credit NUMERIC DEFAULT 0,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )`,
      `CREATE TABLE IF NOT EXISTS rfid_readers (
        reader_id SERIAL PRIMARY KEY,
        reader_name VARCHAR(50) NOT NULL,
        ip_address VARCHAR(15) NOT NULL,
        port INTEGER DEFAULT 9761,
        location VARCHAR(100),
        is_active BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        company_id UUID,
        station_id UUID
      )`,
      `CREATE TABLE IF NOT EXISTS rfid_reader_pumps (
        id SERIAL PRIMARY KEY,
        reader_id INTEGER NOT NULL,
        pump_id INTEGER NOT NULL,
        is_active BOOLEAN DEFAULT TRUE,
        created_at TIMESTAMPTZ DEFAULT NOW()
      )`,
      `CREATE TABLE IF NOT EXISTS rfid_transactions (
        transaction_id SERIAL PRIMARY KEY,
        authorization_id INTEGER,
        pump_id INTEGER NOT NULL,
        attendant_id UUID,
        tag_number VARCHAR(32) NOT NULL,
        pts_transaction_number INTEGER,
        nozzle_number INTEGER,
        fuel_grade_id INTEGER,
        fuel_grade_name VARCHAR(50),
        volume NUMERIC,
        price NUMERIC,
        amount NUMERIC,
        start_datetime TIMESTAMPTZ,
        end_datetime TIMESTAMPTZ,
        status VARCHAR(20) DEFAULT 'pending',
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )`,
      `CREATE TABLE IF NOT EXISTS attendant_shifts (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        company_id UUID NOT NULL,
        station_id UUID NOT NULL,
        attendant_id UUID NOT NULL,
        tag_number TEXT,
        opened_at TIMESTAMPTZ,
        closed_at TIMESTAMPTZ,
        opened_by_user_id UUID,
        closed_by_user_id UUID,
        status TEXT DEFAULT 'open',
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        synced BOOLEAN DEFAULT FALSE,
        synced_at TIMESTAMP
      )`,
      `CREATE TABLE IF NOT EXISTS pump_transaction_reports (
        id BIGSERIAL PRIMARY KEY,
        station_id UUID,
        pump INTEGER NOT NULL,
        nozzle INTEGER,
        fuel_grade_id INTEGER,
        fuel_grade_name TEXT,
        transaction_number INTEGER NOT NULL,
        datetime_start TIMESTAMPTZ,
        datetime_end TIMESTAMPTZ NOT NULL,
        volume NUMERIC(12,3),
        tc_volume NUMERIC(12,3),
        price NUMERIC(12,3),
        amount NUMERIC(12,3),
        total_volume NUMERIC(12,3),
        total_amount NUMERIC(12,3),
        tag TEXT,
        flow_rate INTEGER,
        is_offline BOOLEAN,
        is_paid BOOLEAN,
        user_id INTEGER,
        polled_at TIMESTAMPTZ DEFAULT NOW(),
        created_at TIMESTAMPTZ DEFAULT NOW(),
        synced BOOLEAN DEFAULT FALSE,
        synced_at TIMESTAMP,
        UNIQUE(pump, transaction_number, datetime_end)
      )`,
    ];

    for (const sql of createStatements) {
      try {
        await database.queryLocal(sql);
      } catch (e) {
        logger.debug(`Create table skipped: ${e.message}`);
      }
    }

    // Ensure synced/synced_at columns on all syncable tables
    const tables = [
      'attendants', 'attendant_tags', 'attendant_shifts', 'companies', 'stations', 'pumps',
      'shifts', 'shift_attendants', 'shift_cashup', 'shift_close_declarations',
      'pts_sales', 'pts_sales_records',
      'debtors', 'debtor_vehicles', 'debtor_transactions', 'drivers',
      'price_change_log', 'audit_log',
      'fuel_transactions_raw', 'fuel_transactions_verified',
      'tanks', 'tank_readings', 'employees',
      'rfid_readers', 'rfid_reader_pumps', 'rfid_transactions',
      'pump_transaction_reports',
    ];

    for (const table of tables) {
      try {
        await database.queryLocal(`
          ALTER TABLE ${table}
          ADD COLUMN IF NOT EXISTS synced BOOLEAN DEFAULT FALSE,
          ADD COLUMN IF NOT EXISTS synced_at TIMESTAMP
        `);
      } catch (e) {
        logger.debug(`Skipped sync columns for ${table}: ${e.message}`);
      }
    }
    logger.info('✅ Local schema and sync columns ensured on all tables');
  }

  /**
   * Start offline sync service
   */
  async start() {
    try {
      logger.info('🔄 Starting Offline Sync Service');
      this.isRunning = true;

      // Ensure sync columns exist before anything else
      await this.ensureSyncColumns();

      // Start connection status monitor first (await so isOnline is set)
      await connectionStatus.start();
      logger.info(`🔌 Connection status: ${connectionStatus.isOnline ? '🟢 ONLINE' : '🔴 OFFLINE'}`);

      // Subscribe to connection status changes
      connectionStatus.onStatusChange((isOnline) => {
        if (isOnline) {
          logger.info('🟢 Connection restored - triggering sync');
          this.syncNow();
        } else {
          logger.info('🔴 Connection lost - sync paused');
        }
      });

      // Start periodic sync
      this.syncInterval = setInterval(
        () => this.syncIfOnline(),
        this.syncIntervalMs
      );

      // Schedule initial cache refresh for after startup (5 seconds)
      // This ensures users/attendants are cached for offline use
      if (connectionStatus.isOnline) {
        setTimeout(() => {
          logger.info('🔄 Running initial cache refresh...');
          this.refreshCache().catch(e => logger.error('Initial cache refresh failed', e));
        }, 5000);
      }

      logger.info('✅ Offline Sync Service started');
    } catch (error) {
      logger.error('Failed to start Offline Sync Service', error);
    }
  }

  /**
   * Stop offline sync service
   */
  stop() {
    logger.info('🛑 Stopping Offline Sync Service');
    this.isRunning = false;
    if (this.syncInterval) {
      clearInterval(this.syncInterval);
      this.syncInterval = null;
    }
    logger.info('✅ Offline Sync Service stopped');
  }

  /**
   * Check if should perform cache refresh
   */
  shouldRefreshCache() {
    const now = new Date();
    const lastRefresh = new Date(this.lastCacheRefresh);

    // Refresh cache every 30 minutes (configurable via CACHE_REFRESH_INTERVAL_MS)
    const refreshIntervalMs = parseInt(process.env.CACHE_REFRESH_INTERVAL_MS || '1800000'); // 30 min default
    const timePassed = now - lastRefresh;
    
    if (timePassed >= refreshIntervalMs) {
      return true;
    }

    return false;
  }

  /**
   * Sync if online (or force sync anyway since detection is unreliable)
   */
  async syncIfOnline() {
    // Always try to sync - the actual sync will fail gracefully if offline
    if (!this.isSyncing) {
      logger.debug(`Sync check: online=${connectionStatus.isOnline}, attempting sync...`);
      await this.syncNow();
    }
  }

  /**
   * Ensure remote Supabase connection is alive, reconnect if needed
   */
  async ensureRemoteConnection() {
    if (database.isRemoteAvailable()) return;

    try {
      logger.info('🔄 Attempting to reconnect to Supabase...');
      const connected = await database.reconnectRemote();
      if (connected) {
        logger.info('✅ Supabase reconnected!');
      } else {
        logger.debug('⏳ Supabase still unreachable');
      }
    } catch (error) {
      logger.debug(`⏳ Supabase reconnect failed: ${error.message}`);
    }
  }

  /**
   * Perform sync immediately
   */
  async syncNow() {
    if (this.isSyncing) {
      logger.debug('Sync already in progress, skipping');
      return;
    }

    try {
      this.isSyncing = true;
      const startTime = Date.now();

      // Ensure remote connection is available before syncing
      await this.ensureRemoteConnection();
      
      if (!database.isRemoteAvailable()) {
        logger.debug('⏳ Remote not available, skipping sync cycle');
        return;
      }

      logger.info('📤 Starting offline sync');

      // Push pending transactions
      await this.pushPendingTransactions();

      // Pull fresh cache data if needed
      if (this.shouldRefreshCache()) {
        await this.refreshCache();
        this.lastCacheRefresh = new Date();
      }

      const duration = Date.now() - startTime;
      this.lastSyncTime = new Date();
      this.lastSyncSuccess = new Date();
      this.failureCount = 0;

      logger.info(`✅ Sync completed in ${duration}ms`);
      await this.notifyListeners({ success: true, duration });
    } catch (error) {
      this.failureCount++;
      logger.error(`❌ Sync failed (attempt ${this.failureCount})`, error);
      
      if (this.failureCount >= this.maxRetries) {
        logger.error('❌ Max sync retries reached');
      }

      await this.notifyListeners({ success: false, error: error.message });
    } finally {
      this.isSyncing = false;
    }
  }

  /**
   * Push unsynced fuel transactions directly from fuel_transactions_raw to Supabase
   */
  async pushPendingTransactions() {
    // Push fuel transactions (table may not exist on all installations)
    try {
      logger.debug('📤 Pushing unsynced fuel transactions');

      const result = await database.queryLocal(`
        SELECT id, company_id, station_id, shift_id, attendant_id, tag_number, full_name,
               pump_id, time, amount, currency, transaction_id, is_verified, created_at
        FROM fuel_transactions_raw 
        WHERE synced = FALSE OR synced IS NULL
        ORDER BY created_at ASC 
        LIMIT $1
      `, [this.batchSize]);

      const transactions = result.rows;

      if (transactions.length === 0) {
        logger.debug('✅ No unsynced transactions to push');
      } else {
        logger.info(`📤 Pushing ${transactions.length} unsynced fuel transactions to Supabase`);

        let successCount = 0;
        let errorCount = 0;

        for (const txn of transactions) {
          try {
            await this.pushFuelTransaction(txn);
            
            // Mark as synced in local DB
            await database.queryLocal(
              `UPDATE fuel_transactions_raw SET synced = TRUE, synced_at = NOW() WHERE id = $1`,
              [txn.id]
            );
            successCount++;
          } catch (pushError) {
            logger.error(`Failed to push transaction ${txn.id}`, pushError.message);
            errorCount++;
          }
        }

        if (successCount > 0) {
          logger.info(`✅ Synced ${successCount} transactions to Supabase${errorCount > 0 ? `, ${errorCount} failed` : ''}`);
        }
      }
    } catch (error) {
      logger.warn('⚠️ fuel_transactions_raw push skipped:', error.message);
    }

    // Push verified transactions
    try { await this.pushVerifiedTransactions(); } catch (e) { logger.warn('⚠️ verified transactions push skipped:', e.message); }

    // Push attendant tags
    try { await this.pushAttendantTags(); } catch (e) { logger.warn('⚠️ attendant tags push skipped:', e.message); }

    // Push attendant shifts
    try { await this.pushAttendantShifts(); } catch (e) { logger.warn('⚠️ attendant shifts push skipped:', e.message); }

    // Push all other operational tables
    await this.pushShifts();
    await this.pushShiftAttendants();
    await this.pushShiftPtsSales();
    await this.pushShiftCashup();
    await this.pushShiftCloseDeclarations();
    await this.pushPtsSales();
    await this.pushPtsSalesRecords();
    await this.pushDebtors();
    await this.pushDebtorVehicles();
    await this.pushDrivers();
    await this.pushPriceChangeLog();
    await this.pushAuditLog();

    // Push tables that were previously missing from sync
    await this.pushAttendants();
    await this.pushCompanies();
    await this.pushStations();
    await this.pushPumps();

    // Push continuously-collected PTS transaction reports
    await this.pushPumpTransactionReports();
  }

  /**
   * Push verified transactions from local to Supabase
   */
  async pushVerifiedTransactions() {
    try {
      logger.debug('📤 Pushing unsynced verified transactions');

      // Get unsynced verified transactions
      const result = await database.queryLocal(`
        SELECT id, raw_id, company_id, station_id, shift_id, attendant_id, 
               payment_type, verified_by_user_id, verified_at, amount, currency,
               time, tag_number, full_name, pump_id, transaction_id
        FROM fuel_transactions_verified 
        WHERE synced = FALSE OR synced IS NULL
        ORDER BY verified_at ASC 
        LIMIT $1
      `, [this.batchSize]);

      const verifications = result.rows;

      if (verifications.length === 0) {
        logger.debug('✅ No unsynced verified transactions to push');
        return;
      }

      logger.info(`📤 Pushing ${verifications.length} verified transactions to Supabase`);

      let successCount = 0;
      let errorCount = 0;

      for (const v of verifications) {
        try {
          // First, get the remote raw_id from Supabase by matching station_id + transaction_id
          const remoteRawResult = await database.queryRemote(
            `SELECT id FROM fuel_transactions_raw 
             WHERE station_id = $1 AND transaction_id = $2`,
            [v.station_id, v.transaction_id]
          );

          if (remoteRawResult.rows.length === 0) {
            logger.warn(`Raw transaction not found in Supabase for verification ${v.id}, skipping`);
            errorCount++;
            continue;
          }

          const remoteRawId = remoteRawResult.rows[0].id;

          // Insert into Supabase (use ON CONFLICT to handle duplicates)
          await database.queryRemote(
            `INSERT INTO fuel_transactions_verified 
             (raw_id, company_id, station_id, shift_id, attendant_id, 
              payment_type, verified_by_user_id, verified_at, amount, currency,
              time, tag_number, full_name, pump_id, transaction_id)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)
             ON CONFLICT (raw_id) DO UPDATE SET
               payment_type = EXCLUDED.payment_type,
               verified_by_user_id = EXCLUDED.verified_by_user_id,
               verified_at = EXCLUDED.verified_at`,
            [
              remoteRawId,
              v.company_id,
              v.station_id,
              v.shift_id,
              v.attendant_id,
              v.payment_type,
              v.verified_by_user_id,
              v.verified_at,
              v.amount,
              v.currency,
              v.time,
              v.tag_number,
              v.full_name,
              v.pump_id,
              v.transaction_id
            ]
          );

          // Mark as synced in local DB
          await database.queryLocal(
            `UPDATE fuel_transactions_verified SET synced = TRUE, synced_at = NOW() WHERE id = $1`,
            [v.id]
          );

          successCount++;
          logger.info(`📤 Synced verified transaction to Supabase: id=${v.id}, payment=${v.payment_type}, amount=K${v.amount}`);

        } catch (pushError) {
          logger.error(`Failed to push verified transaction ${v.id}`, pushError.message);
          errorCount++;
        }
      }

      if (successCount > 0) {
        logger.info(`✅ Synced ${successCount} verified transactions to Supabase${errorCount > 0 ? `, ${errorCount} failed` : ''}`);
      }

    } catch (error) {
      logger.error('Error pushing verified transactions', error);
      // Don't throw - let other syncs continue
    }
  }

  /**
   * Push a single fuel transaction to Supabase
   */
  async pushFuelTransaction(txn) {
    try {
      // Use ON CONFLICT to handle duplicates (station_id + transaction_id is unique in Supabase)
      const response = await database.queryRemote(
        `INSERT INTO fuel_transactions_raw 
         (company_id, station_id, shift_id, attendant_id, tag_number, full_name,
          pump_id, time, amount, currency, transaction_id, is_verified, created_at) 
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
         ON CONFLICT (station_id, transaction_id) DO UPDATE SET
           amount = EXCLUDED.amount,
           time = EXCLUDED.time,
           is_verified = EXCLUDED.is_verified
         RETURNING id`,
        [
          txn.company_id, 
          txn.station_id, 
          txn.shift_id,
          txn.attendant_id,
          txn.tag_number,
          txn.full_name,
          txn.pump_id,
          txn.time,
          txn.amount,
          txn.currency || 'ZMW',
          txn.transaction_id || 0,
          txn.is_verified || false,
          txn.created_at
        ]
      );
      
      logger.info(`📤 Synced fuel transaction to Supabase: id=${txn.id}, pump=${txn.pump_id}, amount=K${txn.amount}`);
      return response.rows[0];
    } catch (error) {
      // If foreign key error on attendant_id, retry without it
      if (error.message.includes('fuel_transactions_raw_attendant_id_fkey')) {
        logger.warn(`Attendant ${txn.attendant_id} not in Supabase, syncing without attendant_id`);
        const response = await database.queryRemote(
          `INSERT INTO fuel_transactions_raw 
           (company_id, station_id, shift_id, tag_number, full_name,
            pump_id, time, amount, currency, transaction_id, is_verified, created_at) 
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
           ON CONFLICT (station_id, transaction_id) DO UPDATE SET
             amount = EXCLUDED.amount,
             time = EXCLUDED.time,
             is_verified = EXCLUDED.is_verified
           RETURNING id`,
          [
            txn.company_id, 
            txn.station_id, 
            txn.shift_id,
            txn.tag_number,
            txn.full_name,
            txn.pump_id,
            txn.time,
            txn.amount,
            txn.currency || 'ZMW',
            txn.transaction_id || 0,
            txn.is_verified || false,
            txn.created_at
          ]
        );
        logger.info(`📤 Synced fuel transaction to Supabase (no attendant): id=${txn.id}, pump=${txn.pump_id}, amount=K${txn.amount}`);
        return response.rows[0];
      }
      
      if (error.message.includes('duplicate')) {
        logger.debug(`Transaction ${txn.id} already exists in Supabase`);
        return null;
      }
      throw error;
    }
  }

  /**
   * Get endpoint for transaction type
   */
  getEndpointForTransaction(txn) {
    const type = txn.type || 'unknown';
    return `/api/sync/${type}`;
  }

  /**
   * Get table for transaction type
   */
  getTableForTransaction(txn) {
    const type = txn.type || 'unknown';
    const tables = {
      'attendant_sign_in': 'attendant_shifts',
      'fuel_transaction': 'fuel_transactions_raw',
      'tank_reading': 'tank_readings',
      'shift_declaration': 'shift_close_declarations'
    };
    return tables[type] || 'audit_log';
  }

  // ============================================================
  // GENERIC PUSH HELPER
  // ============================================================

  /**
   * Generic push: query unsynced rows from local, upsert to Supabase, mark synced.
   * @param {string} tableName - Table to sync
   * @param {string[]} columns - Columns to select/insert (excluding synced/synced_at)
   * @param {string} pkColumn - Primary key column (for ON CONFLICT)
   * @param {string[]} updateColumns - Columns to update on conflict (optional, defaults to all non-pk)
   */
  async _pushTable(tableName, columns, pkColumn = 'id', updateColumns = null) {
    try {
      logger.debug(`📤 Pushing unsynced ${tableName}`);

      const result = await database.queryLocal(`
        SELECT ${columns.join(', ')}
        FROM ${tableName}
        WHERE synced = FALSE OR synced IS NULL
        ORDER BY created_at ASC
        LIMIT $1
      `, [this.batchSize]);

      const rows = result.rows;
      if (rows.length === 0) {
        logger.debug(`✅ No unsynced ${tableName} to push`);
        return;
      }

      logger.info(`📤 Pushing ${rows.length} ${tableName} to Supabase`);

      let successCount = 0;
      let errorCount = 0;

      const upsertCols = updateColumns || columns.filter(c => c !== pkColumn);

      for (const row of rows) {
        try {
          const values = columns.map(c => row[c]);
          const placeholders = columns.map((_, i) => `$${i + 1}`).join(', ');
          const updateSet = upsertCols.length > 0
            ? upsertCols.map(c => `${c} = EXCLUDED.${c}`).join(', ')
            : `${pkColumn} = EXCLUDED.${pkColumn}`; // no-op update

          await database.queryRemote(
            `INSERT INTO ${tableName} (${columns.join(', ')})
             VALUES (${placeholders})
             ON CONFLICT (${pkColumn}) DO UPDATE SET ${updateSet}`,
            values
          );

          await database.queryLocal(
            `UPDATE ${tableName} SET synced = TRUE, synced_at = NOW() WHERE ${pkColumn} = $1`,
            [row[pkColumn]]
          );
          successCount++;
        } catch (pushError) {
          logger.error(`Failed to push ${tableName} ${row[pkColumn]}`, pushError.message);
          errorCount++;
        }
      }

      if (successCount > 0) {
        logger.info(`✅ Pushed ${successCount} ${tableName} to Supabase${errorCount > 0 ? `, ${errorCount} failed` : ''}`);
      }
    } catch (error) {
      logger.error(`Error pushing ${tableName}`, error);
      // Don't throw - let other syncs continue
    }
  }

  // ============================================================
  // PUSH METHODS FOR ALL OPERATIONAL TABLES
  // ============================================================

  /**
   * Push shifts from local to Supabase
   */
  async pushShifts() {
    await this._pushTable('shifts', [
      'id', 'company_id', 'station_id', 'start_datetime', 'end_datetime',
      'status', 'created_by', 'created_at'
    ]);
  }

  /**
   * Push shift_attendants from local to Supabase
   */
  async pushShiftAttendants() {
    await this._pushTable('shift_attendants', [
      'id', 'shift_id', 'attendant_id', 'pump_id', 'created_at'
    ]);
  }

  /**
   * Push shift_pts_sales from local to Supabase
   */
  async pushShiftPtsSales() {
    await this._pushTable('shift_pts_sales', [
      'id', 'shift_id', 'company_id', 'station_id', 'pump', 'nozzle',
      'transaction_no', 'volume', 'tc_volume', 'price', 'amount',
      'total_volume', 'total_amount', 'flow_rate', 'tag', 'user_id_pts',
      'date_time_start', 'date_time', 'created_at'
    ]);
  }

  /**
   * Push shift_cashup from local to Supabase
   */
  async pushShiftCashup() {
    await this._pushTable('shift_cashup', [
      'id', 'shift_id', 'pump_id', 'attendant_id', 'pts_total',
      'declared_card', 'declared_mobile', 'declared_debtor', 'debtor_id',
      'declared_cash', 'declared_total', 'variance', 'created_at'
    ]);
  }

  /**
   * Push shift_close_declarations from local to Supabase
   */
  async pushShiftCloseDeclarations() {
    await this._pushTable('shift_close_declarations', [
      'id', 'shift_id', 'declared_cash', 'declared_card', 'declared_debtors',
      'declared_other', 'declared_total', 'currency', 'submitted_at'
    ]);
  }

  /**
   * Push pts_sales from local to Supabase
   * Note: pts_sales uses BIGSERIAL id, conflict on station_id + pts_transaction_id
   */
  async pushPtsSales() {
    try {
      logger.debug('📤 Pushing unsynced pts_sales');

      const result = await database.queryLocal(`
        SELECT id, company_id, station_id, pump_id, nozzle, fuel_grade, fuel_grade_id,
               volume, amount, unit_price, currency, pts_transaction_id,
               transaction_state, start_time, end_time, polled_at, created_at
        FROM pts_sales
        WHERE synced = FALSE OR synced IS NULL
        ORDER BY created_at ASC
        LIMIT $1
      `, [this.batchSize]);

      const rows = result.rows;
      if (rows.length === 0) {
        logger.debug('✅ No unsynced pts_sales to push');
        return;
      }

      logger.info(`📤 Pushing ${rows.length} pts_sales to Supabase`);

      let successCount = 0;
      let errorCount = 0;

      for (const row of rows) {
        try {
          // Use station_id + pts_transaction_id as conflict key since id is auto-increment
          await database.queryRemote(
            `INSERT INTO pts_sales (company_id, station_id, pump_id, nozzle, fuel_grade, fuel_grade_id,
               volume, amount, unit_price, currency, pts_transaction_id,
               transaction_state, start_time, end_time, polled_at, created_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
             ON CONFLICT (station_id, pts_transaction_id) DO UPDATE SET
               volume = EXCLUDED.volume,
               amount = EXCLUDED.amount,
               transaction_state = EXCLUDED.transaction_state,
               end_time = EXCLUDED.end_time`,
            [
              row.company_id, row.station_id, row.pump_id, row.nozzle,
              row.fuel_grade, row.fuel_grade_id, row.volume, row.amount,
              row.unit_price, row.currency, row.pts_transaction_id,
              row.transaction_state, row.start_time, row.end_time,
              row.polled_at, row.created_at
            ]
          );

          await database.queryLocal(
            `UPDATE pts_sales SET synced = TRUE, synced_at = NOW() WHERE id = $1`,
            [row.id]
          );
          successCount++;
        } catch (pushError) {
          logger.error(`Failed to push pts_sales ${row.id}`, pushError.message);
          errorCount++;
        }
      }

      if (successCount > 0) {
        logger.info(`✅ Pushed ${successCount} pts_sales to Supabase${errorCount > 0 ? `, ${errorCount} failed` : ''}`);
      }
    } catch (error) {
      logger.error('Error pushing pts_sales', error);
    }
  }

  /**
   * Push pts_sales_records from local to Supabase
   */
  async pushPtsSalesRecords() {
    await this._pushTable('pts_sales_records', [
      'id', 'shift_id', 'date_time', 'date_time_start', 'pump', 'nozzle',
      'fuel_grade_id', 'fuel_grade_name', 'transaction_no', 'user_id_pts',
      'volume', 'amount', 'price', 'total_volume', 'total_amount',
      'tc_volume', 'flow_rate', 'is_offline', 'is_paid', 'tag', 'created_at'
    ]);
  }

  /**
   * Push debtors from local to Supabase
   */
  async pushDebtors() {
    await this._pushTable('debtors', [
      'id', 'company_id', 'station_id', 'account_no', 'customer_name',
      'contact_name', 'phone', 'email', 'address', 'credit_limit',
      'current_balance', 'term_days', 'status', 'created_at'
    ]);
  }

  /**
   * Push debtor_vehicles from local to Supabase
   */
  async pushDebtorVehicles() {
    await this._pushTable('debtor_vehicles', [
      'id', 'debtor_id', 'account_id', 'number_plate', 'mileage',
      'tank_capacity', 'fuel_type', 'is_active', 'created_at', 'updated_at'
    ]);
  }

  /**
   * Push drivers from local to Supabase
   */
  async pushDrivers() {
    await this._pushTable('drivers', [
      'id', 'vehicle_id', 'full_name', 'nrc', 'nationality',
      'phone', 'email', 'is_active', 'created_at', 'updated_at'
    ]);
  }

  /**
   * Push price_change_log from local to Supabase
   */
  async pushPriceChangeLog() {
    await this._pushTable('price_change_log', [
      'id', 'fuel_grade_id', 'fuel_grade_name', 'new_price',
      'changed_by', 'change_type', 'scheduled_at', 'created_at'
    ]);
  }

  /**
   * Push audit_log from local to Supabase
   */
  async pushAuditLog() {
    await this._pushTable('audit_log', [
      'id', 'company_id', 'station_id', 'actor_user_id', 'action',
      'entity_table', 'entity_pk', 'before', 'after', 'created_at'
    ]);
  }

  /**
   * Push attendants from local to Supabase
   */
  async pushAttendants() {
    await this._pushTable('attendants', [
      'id', 'company_id', 'station_id', 'full_name', 'phone', 'email',
      'nrc', 'country', 'created_at'
    ]);
  }

  /**
   * Push companies from local to Supabase
   */
  async pushCompanies() {
    await this._pushTable('companies', [
      'id', 'name', 'code', 'created_at'
    ]);
  }

  /**
   * Push stations from local to Supabase
   */
  async pushStations() {
    await this._pushTable('stations', [
      'id', 'company_id', 'name', 'code', 'timezone', 'location',
      'station_url', 'is_active', 'created_at'
    ]);
  }

  /**
   * Push pumps from local to Supabase
   */
  async pushPumps() {
    await this._pushTable('pumps', [
      'id', 'station_id', 'pts2_pump_id', 'name', 'is_active'
    ]);
  }

  /**
   * Push PTS pump transaction reports from local to Supabase
   */
  async pushPumpTransactionReports() {
    await this._pushTable(
      'pump_transaction_reports',
      [
        'id', 'station_id', 'pump', 'nozzle', 'fuel_grade_id', 'fuel_grade_name',
        'transaction_number', 'datetime_start', 'datetime_end',
        'volume', 'tc_volume', 'price', 'amount', 'total_volume', 'total_amount',
        'tag', 'flow_rate', 'is_offline', 'is_paid', 'user_id', 'polled_at', 'created_at'
      ],
      'id'
    );
  }

  /**
   * Refresh cache data from remote to local PostgreSQL
   */
  async refreshCache() {
    try {
      logger.info('🔄 Syncing data from remote Supabase to local PostgreSQL');

      // Sync attendants
      await this.syncAttendantsToLocal();

      // Sync employees
      await this.syncEmployeesToLocal();

      // Sync stations
      await this.syncStationsToLocal();

      // Sync users (for offline authentication)
      await this.syncUsersToLocal();

      // Sync attendant tags
      await this.syncAttendantTagsToLocal();

      // Pull attendant shifts from Supabase to local
      await this.pullAttendantShifts();

      // Pull verified transactions from Supabase to local
      await this.pullVerifiedTransactions();

      logger.info('✅ Data sync to local completed');
    } catch (error) {
      logger.error('Error syncing data to local', error);
      throw error;
    }
  }

  /**
   * Pull verified transactions from Supabase to local (for managers verifying via web dashboard)
   */
  async pullVerifiedTransactions() {
    try {
      logger.debug('📥 Pulling verified transactions from Supabase');

      // Get the station_id from environment
      const stationId = process.env.STATION_ID;
      if (!stationId) {
        logger.debug('No STATION_ID configured, skipping verified transaction pull');
        return;
      }

      // Get the last synced verified transaction time
      let lastSyncTime = null;
      try {
        const lastSync = await database.queryLocal(
          `SELECT MAX(verified_at) as last_sync FROM fuel_transactions_verified WHERE synced_from_remote = TRUE`
        );
        lastSyncTime = lastSync.rows[0]?.last_sync;
      } catch (e) {
        // Column might not exist yet
      }

      // Pull verified transactions from Supabase that are newer
      let query = `
        SELECT v.id as remote_id, v.raw_id as remote_raw_id, v.company_id, v.station_id, 
               v.shift_id, v.attendant_id, v.payment_type, v.verified_by_user_id, 
               v.verified_at, v.amount, v.currency, v.time, v.tag_number, 
               v.full_name, v.pump_id, v.transaction_id
        FROM fuel_transactions_verified v
        WHERE v.station_id = $1
      `;
      const params = [stationId];

      if (lastSyncTime) {
        query += ` AND v.verified_at > $2`;
        params.push(lastSyncTime);
      }

      query += ` ORDER BY v.verified_at ASC LIMIT 500`;

      const result = await database.queryRemote(query, params);

      if (result.rows.length === 0) {
        logger.debug('✅ No new verified transactions to pull');
        return;
      }

      logger.info(`📥 Pulling ${result.rows.length} verified transactions from Supabase`);

      let successCount = 0;
      let errorCount = 0;

      for (const v of result.rows) {
        try {
          // Find the local raw_id by matching station_id + transaction_id
          const localRawResult = await database.queryLocal(
            `SELECT id FROM fuel_transactions_raw WHERE station_id = $1 AND transaction_id = $2`,
            [v.station_id, v.transaction_id]
          );

          if (localRawResult.rows.length === 0) {
            logger.warn(`Local raw transaction not found for remote verification, transaction_id=${v.transaction_id}`);
            errorCount++;
            continue;
          }

          const localRawId = localRawResult.rows[0].id;

          // Insert or update in local
          await database.queryLocal(
            `INSERT INTO fuel_transactions_verified 
             (raw_id, company_id, station_id, shift_id, attendant_id, 
              payment_type, verified_by_user_id, verified_at, amount, currency,
              time, tag_number, full_name, pump_id, transaction_id, 
              synced, synced_at, synced_from_remote)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, TRUE, NOW(), TRUE)
             ON CONFLICT (raw_id) DO UPDATE SET
               payment_type = EXCLUDED.payment_type,
               verified_by_user_id = EXCLUDED.verified_by_user_id,
               verified_at = EXCLUDED.verified_at,
               synced = TRUE,
               synced_at = NOW(),
               synced_from_remote = TRUE`,
            [
              localRawId,
              v.company_id,
              v.station_id,
              v.shift_id,
              v.attendant_id,
              v.payment_type,
              v.verified_by_user_id,
              v.verified_at,
              v.amount,
              v.currency,
              v.time,
              v.tag_number,
              v.full_name,
              v.pump_id,
              v.transaction_id
            ]
          );

          // Also update the raw transaction to mark as verified
          await database.queryLocal(
            `UPDATE fuel_transactions_raw SET is_verified = TRUE WHERE id = $1`,
            [localRawId]
          );

          successCount++;

        } catch (pullError) {
          logger.error(`Failed to pull verified transaction ${v.remote_id}`, pullError.message);
          errorCount++;
        }
      }

      if (successCount > 0) {
        logger.info(`✅ Pulled ${successCount} verified transactions from Supabase${errorCount > 0 ? `, ${errorCount} failed` : ''}`);
      }

    } catch (error) {
      logger.error('Error pulling verified transactions', error);
      // Don't throw - let other syncs continue
    }
  }

  /**
   * Sync users from remote to local for offline authentication
   */
  async syncUsersToLocal() {
    try {
      logger.debug('Syncing users from remote to local');

      const result = await database.queryRemote(`
        SELECT 
          id, company_id, station_id, username, password_hash,
          full_name, email, is_active, created_at, updated_at
        FROM users
        WHERE is_active = true
        LIMIT 10000
      `);

      if (result.rows.length > 0) {
        for (const user of result.rows) {
          await database.queryLocal(`
            INSERT INTO users (id, company_id, station_id, username, password_hash, full_name, email, is_active, created_at, updated_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
            ON CONFLICT (id) DO UPDATE SET
              company_id = EXCLUDED.company_id,
              station_id = EXCLUDED.station_id,
              username = EXCLUDED.username,
              password_hash = EXCLUDED.password_hash,
              full_name = EXCLUDED.full_name,
              email = EXCLUDED.email,
              is_active = EXCLUDED.is_active,
              updated_at = EXCLUDED.updated_at
          `, [user.id, user.company_id, user.station_id, user.username, user.password_hash, user.full_name, user.email, user.is_active, user.created_at, user.updated_at]);
        }
        logger.info(`✅ Synced ${result.rows.length} users to local`);
      }
    } catch (error) {
      logger.error('Error syncing users to local', error);
      throw error;
    }
  }

  /**
   * Sync attendants from remote to local
   */
  async syncAttendantsToLocal() {
    try {
      logger.debug('Syncing attendants from remote to local');

      const result = await database.queryRemote(`
        SELECT 
          id, company_id, station_id, phone, created_at, 
          full_name, nrc, country, email
        FROM attendants
        LIMIT 10000
      `);

      if (result.rows.length > 0) {
        for (const attendant of result.rows) {
          await database.queryLocal(`
            INSERT INTO attendants (id, company_id, station_id, phone, created_at, full_name, nrc, country, email)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
            ON CONFLICT (id) DO UPDATE SET
              company_id = EXCLUDED.company_id,
              station_id = EXCLUDED.station_id,
              phone = EXCLUDED.phone,
              full_name = EXCLUDED.full_name,
              nrc = EXCLUDED.nrc,
              country = EXCLUDED.country,
              email = EXCLUDED.email
          `, [attendant.id, attendant.company_id, attendant.station_id, attendant.phone, attendant.created_at, attendant.full_name, attendant.nrc, attendant.country, attendant.email]);
        }
        logger.info(`✅ Synced ${result.rows.length} attendants to local`);
      }
    } catch (error) {
      logger.error('Error syncing attendants to local', error);
      throw error;
    }
  }

  /**
   * Sync attendant tags from remote to local
   */
  async syncAttendantTagsToLocal() {
    try {
      logger.debug('Syncing attendant tags from remote to local');

      const result = await database.queryRemote(`
        SELECT 
          id, attendant_id, tag_uid, is_active, created_at, updated_at
        FROM attendant_tags
        WHERE is_active = true
        LIMIT 10000
      `);

      if (result.rows.length > 0) {
        for (const tag of result.rows) {
          await database.queryLocal(`
            INSERT INTO attendant_tags (id, attendant_id, tag_uid, is_active, created_at, updated_at)
            VALUES ($1, $2, $3, $4, $5, $6)
            ON CONFLICT (id) DO UPDATE SET
              attendant_id = EXCLUDED.attendant_id,
              tag_uid = EXCLUDED.tag_uid,
              is_active = EXCLUDED.is_active,
              updated_at = EXCLUDED.updated_at
          `, [tag.id, tag.attendant_id, tag.tag_uid, tag.is_active, tag.created_at, tag.updated_at]);
        }
        logger.info(`✅ Synced ${result.rows.length} attendant tags to local`);
      }
    } catch (error) {
      logger.error('Error syncing attendant tags to local', error);
      throw error;
    }
  }

  /**
   * Sync employees from remote to local
   */
  async syncEmployeesToLocal() {
    try {
      logger.debug('Syncing employees from remote to local');

      const result = await database.queryRemote(`
        SELECT 
          id, company_id, station_id, user_id, employee_no,
          full_name, first_name, last_name, job_title, is_active, created_at, updated_at
        FROM employees
        WHERE is_active = true
        LIMIT 10000
      `);

      if (result.rows.length > 0) {
        for (const emp of result.rows) {
          await database.queryLocal(`
            INSERT INTO employees (id, company_id, station_id, user_id, employee_no, full_name, first_name, last_name, job_title, is_active, created_at, updated_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
            ON CONFLICT (id) DO UPDATE SET
              company_id = EXCLUDED.company_id,
              station_id = EXCLUDED.station_id,
              user_id = EXCLUDED.user_id,
              employee_no = EXCLUDED.employee_no,
              full_name = EXCLUDED.full_name,
              first_name = EXCLUDED.first_name,
              last_name = EXCLUDED.last_name,
              job_title = EXCLUDED.job_title,
              is_active = EXCLUDED.is_active,
              updated_at = EXCLUDED.updated_at
          `, [emp.id, emp.company_id, emp.station_id, emp.user_id, emp.employee_no, emp.full_name, emp.first_name, emp.last_name, emp.job_title, emp.is_active, emp.created_at, emp.updated_at]);
        }
        logger.info(`✅ Synced ${result.rows.length} employees to local`);
      }
    } catch (error) {
      logger.error('Error syncing employees to local', error);
      throw error;
    }
  }

  /**
   * Sync stations from remote to local
   */
  async syncStationsToLocal() {
    try {
      logger.debug('Syncing stations from remote to local');

      const result = await database.queryRemote(`
        SELECT id, company_id, name, code, timezone, location, station_url, is_active, created_at, updated_at
        FROM stations
        WHERE is_active = true
        LIMIT 1000
      `);

      if (result.rows.length > 0) {
        for (const station of result.rows) {
          await database.queryLocal(`
            INSERT INTO stations (id, company_id, name, code, timezone, location, station_url, is_active, created_at, updated_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
            ON CONFLICT (id) DO UPDATE SET
              company_id = EXCLUDED.company_id,
              name = EXCLUDED.name,
              code = EXCLUDED.code,
              timezone = EXCLUDED.timezone,
              location = EXCLUDED.location,
              station_url = EXCLUDED.station_url,
              is_active = EXCLUDED.is_active,
              updated_at = EXCLUDED.updated_at
          `, [station.id, station.company_id, station.name, station.code, station.timezone, station.location, station.station_url, station.is_active, station.created_at, station.updated_at]);
        }
        logger.info(`✅ Synced ${result.rows.length} stations to local`);
      }
    } catch (error) {
      logger.error('Error syncing stations to local', error);
      throw error;
    }
  }

  /**
   * Subscribe to sync events
   */
  onSyncEvent(callback) {
    this.listeners.push(callback);
    return () => {
      this.listeners = this.listeners.filter(l => l !== callback);
    };
  }

  /**
   * Notify sync listeners
   */
  async notifyListeners(event) {
    for (const listener of this.listeners) {
      try {
        await Promise.resolve(listener(event));
      } catch (error) {
        logger.error('Error notifying sync listener', error);
      }
    }
  }

  /**
   * Get sync status - query local PostgreSQL for stats
   */
  async getStatus() {
    let pendingCount = 0;
    try {
      const result = await database.queryLocal(
        `SELECT COUNT(*) as count FROM fuel_transactions_raw WHERE synced = FALSE OR synced IS NULL`
      );
      pendingCount = parseInt(result.rows[0]?.count || '0');
    } catch (error) {
      // Table may not exist yet
      logger.debug('Could not get pending count:', error.message);
    }
    
    return {
      isRunning: this.isRunning,
      isSyncing: this.isSyncing,
      lastSyncTime: this.lastSyncTime,
      lastSyncSuccess: this.lastSyncSuccess,
      failureCount: this.failureCount,
      pendingTransactions: pendingCount,
      shouldRefreshCache: this.shouldRefreshCache(),
      connectionOnline: connectionStatus.isOnline
    };
  }

  /**
   * Push attendant tags from local to Supabase
   */
  async pushAttendantTags() {
    try {
      logger.debug('📤 Pushing unsynced attendant tags');

      const result = await database.queryLocal(`
        SELECT id, attendant_id, tag_uid, station_id, is_active, created_at, updated_at
        FROM attendant_tags 
        WHERE synced = FALSE OR synced IS NULL
        ORDER BY created_at ASC 
        LIMIT 100
      `);

      const tags = result.rows;
      if (tags.length === 0) {
        logger.debug('✅ No unsynced attendant tags to push');
        return;
      }

      logger.info(`📤 Pushing ${tags.length} attendant tags to Supabase`);

      let successCount = 0;
      let errorCount = 0;

      for (const tag of tags) {
        try {
          await database.queryRemote(
            `INSERT INTO attendant_tags (id, attendant_id, tag_uid, station_id, is_active, created_at, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7)
             ON CONFLICT (id) DO UPDATE SET
               attendant_id = EXCLUDED.attendant_id,
               tag_uid = EXCLUDED.tag_uid,
               is_active = EXCLUDED.is_active,
               updated_at = EXCLUDED.updated_at`,
            [tag.id, tag.attendant_id, tag.tag_uid, tag.station_id, tag.is_active, tag.created_at, tag.updated_at]
          );

          await database.queryLocal(
            `UPDATE attendant_tags SET synced = TRUE, synced_at = NOW() WHERE id = $1`,
            [tag.id]
          );
          successCount++;
        } catch (pushError) {
          logger.error(`Failed to push attendant tag ${tag.id}`, pushError.message);
          errorCount++;
        }
      }

      if (successCount > 0) {
        logger.info(`✅ Pushed ${successCount} attendant tags to Supabase${errorCount > 0 ? `, ${errorCount} failed` : ''}`);
      }
    } catch (error) {
      logger.error('Error pushing attendant tags', error);
    }
  }

  /**
   * Push attendant shifts from local to Supabase
   */
  async pushAttendantShifts() {
    try {
      logger.debug('📤 Pushing unsynced attendant shifts');

      const result = await database.queryLocal(`
        SELECT id, company_id, station_id, attendant_id, tag_number, opened_at, 
               closed_at, opened_by_user_id, closed_by_user_id, status, created_at, updated_at
        FROM attendant_shifts 
        WHERE synced = FALSE OR synced IS NULL
        ORDER BY created_at ASC 
        LIMIT 100
      `);

      const shifts = result.rows;
      if (shifts.length === 0) {
        logger.debug('✅ No unsynced attendant shifts to push');
        return;
      }

      logger.info(`📤 Pushing ${shifts.length} attendant shifts to Supabase`);

      let successCount = 0;
      let errorCount = 0;

      for (const shift of shifts) {
        try {
          await database.queryRemote(
            `INSERT INTO attendant_shifts (id, company_id, station_id, attendant_id, tag_number, 
               opened_at, closed_at, opened_by_user_id, closed_by_user_id, status, created_at, updated_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
             ON CONFLICT (id) DO UPDATE SET
               closed_at = EXCLUDED.closed_at,
               closed_by_user_id = EXCLUDED.closed_by_user_id,
               status = EXCLUDED.status,
               updated_at = EXCLUDED.updated_at`,
            [shift.id, shift.company_id, shift.station_id, shift.attendant_id, shift.tag_number,
             shift.opened_at, shift.closed_at, shift.opened_by_user_id, shift.closed_by_user_id, 
             shift.status, shift.created_at, shift.updated_at]
          );

          await database.queryLocal(
            `UPDATE attendant_shifts SET synced = TRUE, synced_at = NOW() WHERE id = $1`,
            [shift.id]
          );
          successCount++;
        } catch (pushError) {
          logger.error(`Failed to push attendant shift ${shift.id}`, pushError.message);
          errorCount++;
        }
      }

      if (successCount > 0) {
        logger.info(`✅ Pushed ${successCount} attendant shifts to Supabase${errorCount > 0 ? `, ${errorCount} failed` : ''}`);
      }
    } catch (error) {
      logger.error('Error pushing attendant shifts', error);
    }
  }

  /**
   * Pull attendant shifts from Supabase to local
   */
  async pullAttendantShifts() {
    try {
      logger.debug('📥 Pulling attendant shifts from Supabase');

      const stationId = process.env.STATION_ID;
      if (!stationId) {
        logger.debug('No STATION_ID configured, skipping attendant shift pull');
        return;
      }

      // Get last synced shift time
      let lastSyncTime = '1970-01-01';
      try {
        const lastSync = await database.queryLocal(
          `SELECT MAX(updated_at) as last_update FROM attendant_shifts WHERE synced = TRUE`
        );
        if (lastSync.rows[0]?.last_update) {
          lastSyncTime = lastSync.rows[0].last_update;
        }
      } catch (e) {
        // Table might not have data yet
      }

      // Pull shifts from Supabase that are newer
      const result = await database.queryRemote(`
        SELECT id, company_id, station_id, attendant_id, tag_number, opened_at, 
               closed_at, opened_by_user_id, closed_by_user_id, status, created_at, updated_at
        FROM attendant_shifts 
        WHERE station_id = $1 AND updated_at > $2
        ORDER BY updated_at ASC
        LIMIT 100
      `, [stationId, lastSyncTime]);

      if (result.rows.length === 0) {
        logger.debug('✅ No new attendant shifts to pull');
        return;
      }

      logger.info(`📥 Pulling ${result.rows.length} attendant shifts from Supabase`);

      let successCount = 0;
      let errorCount = 0;

      for (const shift of result.rows) {
        try {
          await database.queryLocal(
            `INSERT INTO attendant_shifts (id, company_id, station_id, attendant_id, tag_number,
               opened_at, closed_at, opened_by_user_id, closed_by_user_id, status, created_at, updated_at, synced, synced_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, TRUE, NOW())
             ON CONFLICT (id) DO UPDATE SET
               closed_at = EXCLUDED.closed_at,
               closed_by_user_id = EXCLUDED.closed_by_user_id,
               status = EXCLUDED.status,
               updated_at = EXCLUDED.updated_at,
               synced = TRUE,
               synced_at = NOW()`,
            [shift.id, shift.company_id, shift.station_id, shift.attendant_id, shift.tag_number,
             shift.opened_at, shift.closed_at, shift.opened_by_user_id, shift.closed_by_user_id,
             shift.status, shift.created_at, shift.updated_at]
          );
          successCount++;
        } catch (pullError) {
          logger.error(`Failed to pull attendant shift ${shift.id}`, pullError.message);
          errorCount++;
        }
      }

      if (successCount > 0) {
        logger.info(`✅ Pulled ${successCount} attendant shifts from Supabase${errorCount > 0 ? `, ${errorCount} failed` : ''}`);
      }
    } catch (error) {
      logger.error('Error pulling attendant shifts', error);
    }
  }

  /**
   * Force full resync
   */
  async forceFullSync() {
    logger.info('🔄 Forcing full resync');
    this.lastCacheRefresh = new Date(0);
    return await this.syncNow();
  }
}

module.exports = new OfflineSyncService();
