/**
 * Database Sync Service
 * Pushes local PostgreSQL changes to Supabase
 * Pulls reference data from Supabase to local (station-scoped)
 * Runs in background, handles retries and conflict resolution
 */

const EventEmitter = require('events');
const dualDb = require('../utils/dual-db');
const logger = require('../utils/logger')('SyncService');

class SyncService extends EventEmitter {
  constructor() {
    super();
    this.isRunning = false;
    this.syncInterval = null;
    this.batchSize = parseInt(process.env.SYNC_BATCH_SIZE || '50');
    this.intervalMs = parseInt(process.env.SYNC_INTERVAL_MS || '30000');
    this.maxRetries = parseInt(process.env.SYNC_MAX_RETRIES || '5');
    
    // Station-specific configuration
    this.scopeMode = process.env.OFFLINE_SCOPE_MODE || 'none';
    this.companyId = process.env.OFFLINE_COMPANY_ID || null;
    this.stationId = process.env.OFFLINE_STATION_ID || null;
    this.autoPullOnStartup = process.env.AUTO_PULL_ON_STARTUP === 'true';
    
    // Validate station config
    this._validateConfig();
    
    this.stats = {
      totalSynced: 0,
      totalFailed: 0,
      lastSyncTime: null,
      lastSyncDuration: 0,
      lastSyncCount: 0,
      lastPullTime: null,
    };
  }

  /**
   * Validate station configuration
   */
  _validateConfig() {
    if (this.scopeMode !== 'none') {
      const invalidUUID = '00000000-0000-0000-0000-000000000000';
      
      if (!this.companyId || this.companyId === invalidUUID) {
        logger.warn('⚠️  OFFLINE_COMPANY_ID not configured - station scoping disabled');
        this.scopeMode = 'none';
        return;
      }
      
      if ((this.scopeMode === 'station' || this.scopeMode === 'both') && 
          (!this.stationId || this.stationId === invalidUUID)) {
        logger.warn('⚠️  OFFLINE_STATION_ID not configured - station scoping disabled');
        this.scopeMode = 'none';
        return;
      }
      
      logger.info(`📍 Station scope configured: ${this.scopeMode}`);
      logger.info(`   Company: ${this.companyId}`);
      if (this.stationId) {
        logger.info(`   Station: ${this.stationId}`);
      }
    }
  }

  /**
   * Get station configuration
   */
  getStationConfig() {
    return {
      scopeMode: this.scopeMode,
      companyId: this.companyId,
      stationId: this.stationId,
      autoPullOnStartup: this.autoPullOnStartup,
      isConfigured: this.scopeMode !== 'none',
    };
  }

  /**
   * Start the sync service
   */
  start() {
    if (this.isRunning) {
      logger.warn('Sync service already running');
      return;
    }

    this.isRunning = true;
    logger.info(`Sync service started (interval: ${this.intervalMs}ms, batch: ${this.batchSize})`);

    // Run initial sync
    this.sync();

    // Schedule periodic sync
    this.syncInterval = setInterval(() => {
      this.sync();
    }, this.intervalMs);

    this.emit('started');
  }

  /**
   * Stop the sync service
   */
  stop() {
    if (!this.isRunning) return;

    this.isRunning = false;
    if (this.syncInterval) {
      clearInterval(this.syncInterval);
      this.syncInterval = null;
    }

    logger.info('Sync service stopped');
    this.emit('stopped');
  }

  /**
   * Perform a sync cycle
   */
  async sync() {
    const status = dualDb.getStatus();
    
    if (!status.local) {
      logger.debug('Skipping sync - local database not available');
      return { synced: 0, failed: 0, reason: 'local_unavailable' };
    }

    if (!status.remote) {
      logger.debug('Skipping sync - remote database not available');
      return { synced: 0, failed: 0, reason: 'remote_unavailable' };
    }

    const startTime = Date.now();
    let synced = 0;
    let failed = 0;

    try {
      // Get pending items from sync queue
      const pendingResult = await dualDb.local.query(`
        SELECT id, table_name, record_id, operation, payload, sync_attempts
        FROM sync_queue
        WHERE is_synced = FALSE AND sync_attempts < $1
        ORDER BY created_at ASC
        LIMIT $2
      `, [this.maxRetries, this.batchSize]);

      const pending = pendingResult.rows;

      if (pending.length === 0) {
        logger.debug('No pending items to sync');
        return { synced: 0, failed: 0, reason: 'no_pending' };
      }

      logger.info(`Syncing ${pending.length} items to Supabase...`);

      // Process each item
      for (const item of pending) {
        try {
          await this.syncItem(item);
          synced++;
          
          // Mark as synced
          await dualDb.local.query(`
            UPDATE sync_queue
            SET is_synced = TRUE, synced_at = NOW()
            WHERE id = $1
          `, [item.id]);

        } catch (error) {
          failed++;
          logger.error(`Failed to sync ${item.table_name}.${item.record_id}:`, error.message);
          
          // Update retry count and error
          await dualDb.local.query(`
            UPDATE sync_queue
            SET sync_attempts = sync_attempts + 1, last_error = $1
            WHERE id = $2
          `, [error.message, item.id]);
        }
      }

      const duration = Date.now() - startTime;
      
      // Update stats
      this.stats.totalSynced += synced;
      this.stats.totalFailed += failed;
      this.stats.lastSyncTime = new Date();
      this.stats.lastSyncDuration = duration;
      this.stats.lastSyncCount = synced;

      logger.info(`Sync complete: ${synced} synced, ${failed} failed (${duration}ms)`);
      
      this.emit('syncComplete', { synced, failed, duration });
      
      return { synced, failed, duration };

    } catch (error) {
      logger.error('Sync cycle failed:', error);
      this.emit('syncError', error);
      throw error;
    }
  }

  /**
   * Sync a single item to Supabase
   */
  async syncItem(item) {
    const { table_name, record_id, operation, payload } = item;
    const data = typeof payload === 'string' ? JSON.parse(payload) : payload;

    switch (operation) {
      case 'INSERT':
        await this.syncInsert(table_name, data);
        break;

      case 'UPDATE':
        await this.syncUpdate(table_name, record_id, data);
        break;

      case 'DELETE':
        await this.syncDelete(table_name, record_id);
        break;

      default:
        throw new Error(`Unknown operation: ${operation}`);
    }

    logger.debug(`Synced ${table_name}.${operation} - ${record_id}`);
  }

  /**
   * Sync INSERT to Supabase
   */
  async syncInsert(tableName, data) {
    const columns = Object.keys(data);
    const values = Object.values(data);
    const placeholders = columns.map((_, i) => `$${i + 1}`);

    // Use UPSERT to handle conflicts (record might already exist)
    const sql = `
      INSERT INTO ${tableName} (${columns.join(', ')})
      VALUES (${placeholders.join(', ')})
      ON CONFLICT (id) DO UPDATE SET
        ${columns.map((col, i) => `${col} = $${i + 1}`).join(', ')}
    `;

    await dualDb.remote.query(sql, values);
  }

  /**
   * Sync UPDATE to Supabase
   */
  async syncUpdate(tableName, recordId, data) {
    const columns = Object.keys(data);
    const values = Object.values(data);
    const setClause = columns.map((col, i) => `${col} = $${i + 1}`).join(', ');

    const sql = `
      UPDATE ${tableName}
      SET ${setClause}
      WHERE id = $${columns.length + 1}
    `;

    await dualDb.remote.query(sql, [...values, recordId]);
  }

  /**
   * Sync DELETE to Supabase
   */
  async syncDelete(tableName, recordId) {
    const sql = `DELETE FROM ${tableName} WHERE id = $1`;
    await dualDb.remote.query(sql, [recordId]);
  }

  /**
   * Force immediate sync
   */
  async forceSync() {
    logger.info('Force sync requested');
    return this.sync();
  }

  /**
   * Get sync statistics
   */
  getStats() {
    return { ...this.stats };
  }

  /**
   * Get detailed sync queue status
   */
  async getQueueStatus() {
    return dualDb.getSyncQueueStatus();
  }

  /**
   * Retry failed items
   */
  async retryFailed() {
    const result = await dualDb.local.query(`
      UPDATE sync_queue
      SET sync_attempts = 0, last_error = NULL
      WHERE is_synced = FALSE AND sync_attempts >= $1
      RETURNING id
    `, [this.maxRetries]);

    const count = result.rowCount;
    logger.info(`Reset ${count} failed items for retry`);
    
    return count;
  }

  /**
   * Clear synced items older than N days
   */
  async cleanupSynced(days = 7) {
    const result = await dualDb.local.query(`
      DELETE FROM sync_queue
      WHERE is_synced = TRUE 
        AND synced_at < NOW() - INTERVAL '${days} days'
      RETURNING id
    `);

    const count = result.rowCount;
    logger.info(`Cleaned up ${count} synced items older than ${days} days`);
    
    return count;
  }

  /**
   * Pull reference data from Supabase to local
   * (Companies, Stations, Employees, Attendants, etc.)
   */
  async pullReferenceData(tableName, filters = {}) {
    const status = dualDb.getStatus();
    
    if (!status.remote) {
      throw new Error('Remote database not available');
    }
    if (!status.local) {
      throw new Error('Local database not available');
    }

    logger.info(`Pulling reference data: ${tableName}`);

    // Build query with optional filters
    let sql = `SELECT * FROM ${tableName}`;
    const values = [];
    const conditions = [];

    Object.entries(filters).forEach(([key, value], i) => {
      conditions.push(`${key} = $${i + 1}`);
      values.push(value);
    });

    if (conditions.length > 0) {
      sql += ` WHERE ${conditions.join(' AND ')}`;
    }

    // Fetch from Supabase
    const result = await dualDb.remote.query(sql, values);
    const rows = result.rows;

    if (rows.length === 0) {
      logger.info(`No data to pull for ${tableName}`);
      return 0;
    }

    // Upsert into local
    let upserted = 0;
    for (const row of rows) {
      const columns = Object.keys(row);
      const rowValues = Object.values(row);
      const placeholders = columns.map((_, i) => `$${i + 1}`);
      
      // Determine primary key column based on table
      let pkColumn = 'id';
      if (tableName === 'rfid_readers') {
        pkColumn = 'reader_id';
      }
      
      const upsertSql = `
        INSERT INTO ${tableName} (${columns.join(', ')})
        VALUES (${placeholders.join(', ')})
        ON CONFLICT (${pkColumn}) DO UPDATE SET
          ${columns.filter(c => c !== pkColumn).map((col, i) => `${col} = EXCLUDED.${col}`).join(', ')}
      `;

      await dualDb.local.query(upsertSql, rowValues);
      upserted++;
    }

    logger.info(`Pulled ${upserted} records for ${tableName}`);
    return upserted;
  }

  /**
   * Pull authentication data for a station (users and user_roles only)
   */
  async pullStationData(companyId, stationId) {
    logger.info(`Pulling user authentication data for station ${stationId}`);

    const results = {};

    // Pull users for this company/station
    try {
      results['users'] = await this.pullReferenceData('users', { 
        company_id: companyId, 
        station_id: stationId 
      });
    } catch (error) {
      logger.error(`Failed to pull users:`, error.message);
      results['users'] = { error: error.message };
    }

    // Pull user_roles for the users we just synced
    try {
      // Get user IDs from local database (after users sync)
      const usersResult = await dualDb.local.query(
        'SELECT id FROM users WHERE company_id = $1 AND station_id = $2',
        [companyId, stationId]
      );
      const userIds = usersResult.rows.map(r => r.id);
      
      if (userIds.length > 0) {
        const rolesResult = await dualDb.remote.query(
          `SELECT * FROM user_roles WHERE user_id = ANY($1)`,
          [userIds]
        );
        
        for (const row of rolesResult.rows) {
          await dualDb.local.query(`
            INSERT INTO user_roles (user_id, role_id)
            VALUES ($1, $2)
            ON CONFLICT (user_id, role_id) DO NOTHING
          `, [row.user_id, row.role_id]);
        }
        results['user_roles'] = rolesResult.rows.length;
      } else {
        results['user_roles'] = 0;
      }
    } catch (error) {
      logger.error('Failed to pull user_roles:', error.message);
      results['user_roles'] = { error: error.message };
    }

    logger.info('Authentication data pull complete:', results);
    this.emit('pullComplete', results);
    
    return results;
  }
}

// Export singleton instance
module.exports = new SyncService();
