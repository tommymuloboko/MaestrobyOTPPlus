/**
 * Dual Database Manager
 * Routes queries to Local PostgreSQL (primary) or Supabase (remote)
 * Handles offline-first architecture with automatic sync
 */

const localDb = require('./local-db');
const database = require('./database');
const logger = require('./logger')('DualDB');

// Remote DB uses Supabase pool from database.js
const remoteDb = database.remote;

// Tables that should be synced to Supabase (PUSH: Local → Supabase)
const SYNC_TABLES = [
  'fuel_transactions_raw',
  'fuel_transactions_verified',
  'pts_sales',
  'attendant_shifts',
  'tank_readings',
  'audit_log',
  'rfid_transactions',
  // Operational data - now PUSH only
  'companies',
  'stations',
  'attendants',
  'pumps',
  'tanks',
  'attendant_tags',
  'rfid_readers',
  'rfid_reader_pumps',
  // Debtor management tables
  'debtors',
  'debtor_vehicles',
  'debtor_transactions',
  'shift_cashup',
];

// Tables that are reference data (PULL: Supabase → Local)
// Only user authentication data is pulled
const REFERENCE_TABLES = [
  'users',
  'user_roles',
];

let isLocalAvailable = false;
let isRemoteAvailable = false;

/**
 * Initialize dual database connections
 */
async function initialize() {
  logger.info('Initializing dual database connections...');
  
  // Test local PostgreSQL
  try {
    isLocalAvailable = await localDb.testConnection();
    if (isLocalAvailable) {
      logger.info('✅ Local PostgreSQL connected');
    }
  } catch (error) {
    logger.warn('⚠️ Local PostgreSQL not available:', error.message);
    isLocalAvailable = false;
  }
  
  // Test Supabase
  try {
    await remoteDb.query('SELECT 1');
    isRemoteAvailable = true;
    logger.info('✅ Supabase (remote) connected');
  } catch (error) {
    logger.warn('⚠️ Supabase not available:', error.message);
    isRemoteAvailable = false;
  }
  
  return {
    local: isLocalAvailable,
    remote: isRemoteAvailable,
  };
}

/**
 * Get connection status
 */
function getStatus() {
  // Get live status from database.js (which is initialized on startup)
  const dbStatus = database.getStatus();
  
  return {
    local: dbStatus.local,   // Use database.js status (set during initialize)
    remote: dbStatus.remote, // Use database.js status
    mode: dbStatus.local ? 'local-first' : (dbStatus.remote ? 'remote-only' : 'offline'),
  };
}

/**
 * Query the appropriate database based on operation type
 * For writes: Always write to local first, queue for sync
 * For reads: Read from local (most current data)
 */
async function query(text, params = [], options = {}) {
  const { forceRemote = false, forceLocal = false } = options;
  
  // Force remote (e.g., for sync operations)
  if (forceRemote) {
    if (!isRemoteAvailable) {
      throw new Error('Remote database not available');
    }
    return remoteDb.query(text, params);
  }
  
  // Force local
  if (forceLocal) {
    if (!isLocalAvailable) {
      throw new Error('Local database not available');
    }
    return localDb.query(text, params);
  }
  
  // Default: Local-first
  if (isLocalAvailable) {
    return localDb.query(text, params);
  }
  
  // Fallback to remote if local not available
  if (isRemoteAvailable) {
    logger.warn('Local DB unavailable, using remote');
    return remoteDb.query(text, params);
  }
  
  throw new Error('No database connection available');
}

/**
 * Execute a write operation with sync queuing
 * Writes to local and queues for sync to Supabase
 */
async function write(tableName, operation, data, recordId = null) {
  if (!isLocalAvailable) {
    throw new Error('Local database not available for writes');
  }
  
  const client = await localDb.getClient();
  
  try {
    await client.query('BEGIN');
    
    let result;
    let finalRecordId = recordId;
    
    switch (operation) {
      case 'INSERT':
        result = await performInsert(client, tableName, data);
        finalRecordId = result.rows[0]?.id || result.rows[0]?.id;
        break;
        
      case 'UPDATE':
        if (!recordId) throw new Error('Record ID required for UPDATE');
        result = await performUpdate(client, tableName, data, recordId);
        finalRecordId = recordId;
        break;
        
      case 'DELETE':
        if (!recordId) throw new Error('Record ID required for DELETE');
        result = await performDelete(client, tableName, recordId);
        finalRecordId = recordId;
        break;
        
      default:
        throw new Error(`Unknown operation: ${operation}`);
    }
    
    // Queue for sync if this table should be synced
    if (SYNC_TABLES.includes(tableName)) {
      await queueForSync(client, tableName, finalRecordId, operation, data);
    }
    
    await client.query('COMMIT');
    return result;
    
  } catch (error) {
    await client.query('ROLLBACK');
    logger.error(`Write operation failed: ${tableName}.${operation}`, error);
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Perform INSERT operation
 */
async function performInsert(client, tableName, data) {
  const columns = Object.keys(data);
  const values = Object.values(data);
  const placeholders = columns.map((_, i) => `$${i + 1}`);
  
  const sql = `
    INSERT INTO ${tableName} (${columns.join(', ')})
    VALUES (${placeholders.join(', ')})
    RETURNING *
  `;
  
  return client.query(sql, values);
}

/**
 * Perform UPDATE operation
 */
async function performUpdate(client, tableName, data, recordId) {
  const columns = Object.keys(data);
  const values = Object.values(data);
  const setClause = columns.map((col, i) => `${col} = $${i + 1}`).join(', ');
  
  const sql = `
    UPDATE ${tableName}
    SET ${setClause}
    WHERE id = $${columns.length + 1}
    RETURNING *
  `;
  
  return client.query(sql, [...values, recordId]);
}

/**
 * Perform DELETE operation
 */
async function performDelete(client, tableName, recordId) {
  const sql = `DELETE FROM ${tableName} WHERE id = $1 RETURNING *`;
  return client.query(sql, [recordId]);
}

/**
 * Queue a record for sync to Supabase
 */
async function queueForSync(client, tableName, recordId, operation, payload) {
  const sql = `
    INSERT INTO sync_queue (table_name, record_id, operation, payload)
    VALUES ($1, $2, $3, $4)
  `;
  
  await client.query(sql, [
    tableName,
    String(recordId),
    operation,
    JSON.stringify(payload),
  ]);
  
  logger.debug(`Queued for sync: ${tableName}.${operation} - ${recordId}`);
}

/**
 * Transaction wrapper that uses local database
 */
async function transaction(callback) {
  if (!isLocalAvailable) {
    throw new Error('Local database not available for transactions');
  }
  return localDb.transaction(callback);
}

/**
 * Get pending sync count
 */
async function getPendingSyncCount() {
  if (!isLocalAvailable) return 0;
  
  const result = await localDb.query(
    'SELECT COUNT(*) FROM sync_queue WHERE is_synced = FALSE'
  );
  return parseInt(result.rows[0].count);
}

/**
 * Get sync queue status
 */
async function getSyncQueueStatus() {
  if (!isLocalAvailable) {
    return { pending: 0, failed: 0, byTable: {} };
  }
  
  const pending = await localDb.query(`
    SELECT table_name, COUNT(*) as count
    FROM sync_queue
    WHERE is_synced = FALSE
    GROUP BY table_name
  `);
  
  const failed = await localDb.query(`
    SELECT COUNT(*) FROM sync_queue
    WHERE is_synced = FALSE AND sync_attempts >= 3
  `);
  
  const byTable = {};
  pending.rows.forEach(row => {
    byTable[row.table_name] = parseInt(row.count);
  });
  
  return {
    pending: pending.rows.reduce((sum, row) => sum + parseInt(row.count), 0),
    failed: parseInt(failed.rows[0].count),
    byTable,
  };
}

/**
 * Check and update connection status
 */
async function checkConnections() {
  // Check local
  try {
    await localDb.query('SELECT 1');
    isLocalAvailable = true;
  } catch {
    isLocalAvailable = false;
  }
  
  // Check remote
  try {
    await remoteDb.query('SELECT 1');
    isRemoteAvailable = true;
  } catch {
    isRemoteAvailable = false;
  }
  
  return getStatus();
}

/**
 * Manually queue a record for sync (for inserts done outside dualDb.write)
 * Call this after INSERT statements that bypass dualDb.write()
 */
async function addToSyncQueue(tableName, recordId, operation = 'INSERT', payload = {}) {
  if (!SYNC_TABLES.includes(tableName)) {
    logger.debug(`Table ${tableName} not in SYNC_TABLES, skipping queue`);
    return false;
  }
  
  if (!isLocalAvailable) {
    logger.warn('Cannot queue for sync - local DB not available');
    return false;
  }
  
  const sql = `
    INSERT INTO sync_queue (table_name, record_id, operation, payload)
    VALUES ($1, $2, $3, $4)
    ON CONFLICT DO NOTHING
  `;
  
  await localDb.query(sql, [
    tableName,
    String(recordId),
    operation,
    JSON.stringify(payload),
  ]);
  
  logger.debug(`Queued for sync: ${tableName}.${operation} - ${recordId}`);
  return true;
}

/**
 * Close all connections
 */
async function close() {
  await localDb.close();
  await remoteDb.close();
  logger.info('All database connections closed');
}

module.exports = {
  initialize,
  getStatus,
  query,
  write,
  addToSyncQueue,  // Export the manual queue function
  transaction,
  getPendingSyncCount,
  getSyncQueueStatus,
  checkConnections,
  close,
  
  // Direct access to each database
  local: localDb,
  remote: remoteDb,
  
  // Constants
  SYNC_TABLES,
  REFERENCE_TABLES,
};
