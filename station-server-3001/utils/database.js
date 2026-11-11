/**
 * Database Module
 * 
 * Deployment modes:
 * - LOCAL: Uses local PostgreSQL as primary, syncs to Supabase
 * - CLOUD: Uses Supabase directly (no local DB needed)
 * 
 * Set DEPLOYMENT_MODE=cloud for Render deployment
 * Set DEPLOYMENT_MODE=local (default) for gas station deployment
 */

const { Pool } = require('pg');
const logger = require('./logger')('Database');

// Deployment mode detection
const DEPLOYMENT_MODE = process.env.DEPLOYMENT_MODE || 'local';
const isCloudMode = DEPLOYMENT_MODE === 'cloud';

logger.info(`🌐 Deployment mode: ${DEPLOYMENT_MODE.toUpperCase()}`);

// Local PostgreSQL configuration (PRIMARY - all endpoints use this)
const localConfig = {
  host: process.env.LOCAL_DB_HOST || 'localhost',
  port: parseInt(process.env.LOCAL_DB_PORT || '5432'),
  database: process.env.LOCAL_DB_NAME || 'MAESTRO-LITE',
  user: process.env.LOCAL_DB_USER || 'postgres',
  password: process.env.LOCAL_DB_PASSWORD,
  max: parseInt(process.env.LOCAL_DB_POOL_MAX || '10'),
  min: parseInt(process.env.LOCAL_DB_POOL_MIN || '2'),
  idleTimeoutMillis: parseInt(process.env.LOCAL_DB_IDLE_TIMEOUT || '30000'),
  connectionTimeoutMillis: parseInt(process.env.LOCAL_DB_CONNECTION_TIMEOUT || '5000'),
};

// Remote Supabase configuration (SYNC ONLY - for backup/reporting)
const remoteConfig = {
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
  max: parseInt(process.env.DB_POOL_MAX || '5'),
  min: parseInt(process.env.DB_POOL_MIN || '1'),
  idleTimeoutMillis: parseInt(process.env.DB_IDLE_TIMEOUT || '30000'),
  connectionTimeoutMillis: parseInt(process.env.DB_CONNECTION_TIMEOUT || '10000'),
};

// Create pools based on deployment mode
const localPool = isCloudMode ? null : new Pool(localConfig);
const remotePool = new Pool(remoteConfig);

// Track connection status
let localConnected = false;
let remoteConnected = false;

// Pool event handlers
if (localPool) {
  localPool.on('error', (err) => {
    logger.error('Local PostgreSQL pool error', err);
    localConnected = false;
  });

  localPool.on('connect', () => {
    localConnected = true;
  });
}

remotePool.on('error', (err) => {
  logger.error('Remote Supabase pool error', err);
  remoteConnected = false;
});

remotePool.on('connect', () => {
  remoteConnected = true;
});

/**
 * Initialize and test database connections
 */
async function initialize() {
  if (isCloudMode) {
    logger.info('🔧 Database: CLOUD MODE - Supabase only (no local DB)');
    
    // Test Supabase connection (REQUIRED in cloud mode)
    try {
      await remotePool.query('SELECT 1');
      remoteConnected = true;
      logger.info('✅ Supabase connected (primary in cloud mode)');
    } catch (error) {
      logger.error('❌ Supabase not available:', error.message);
      remoteConnected = false;
      throw new Error('Supabase is required in cloud mode but not available');
    }
    
    return {
      local: false,
      remote: remoteConnected,
      mode: 'cloud',
    };
  }
  
  // LOCAL MODE
  logger.info('🔧 Database: LOCAL MODE - Local PostgreSQL (primary) + Supabase (sync)');
  
  // Test local connection (REQUIRED in local mode)
  try {
    await localPool.query('SELECT 1');
    localConnected = true;
    logger.info('✅ Local PostgreSQL connected (primary)');
  } catch (error) {
    logger.error('❌ Local PostgreSQL not available:', error.message);
    localConnected = false;
    throw new Error('Local PostgreSQL is required but not available');
  }
  
  // Test remote connection (optional - for sync) with retries for weak networks
  const maxRetries = 3;
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      logger.info(`🔄 Testing Supabase connection (attempt ${attempt}/${maxRetries})...`);
      await remotePool.query('SELECT 1');
      remoteConnected = true;
      logger.info('✅ Remote Supabase connected (for sync)');
      break;
    } catch (error) {
      logger.warn(`⚠️ Supabase connection attempt ${attempt} failed:`, error.message);
      remoteConnected = false;
      if (attempt < maxRetries) {
        logger.info(`   Retrying in 3 seconds...`);
        await new Promise(r => setTimeout(r, 3000));
      }
    }
  }
  
  if (!remoteConnected) {
    logger.warn('⚠️ Remote Supabase not available after retries (sync disabled)');
  }
  
  return {
    local: localConnected,
    remote: remoteConnected,
    mode: 'local',
  };
}

/**
 * Execute query on PRIMARY database
 * - Cloud mode: Supabase
 * - Local mode: Local PostgreSQL
 */
async function query(text, params = []) {
  const start = Date.now();
  const pool = isCloudMode ? remotePool : localPool;
  
  try {
    const result = await pool.query(text, params);
    const duration = Date.now() - start;
    
    if (duration > 1000) {
      logger.warn(`Slow query (${duration}ms)`, { text: text.substring(0, 100) });
    }
    
    return result;
  } catch (error) {
    logger.error('Query error', { error: error.message, query: text.substring(0, 100) });
    throw error;
  }
}

/**
 * Execute query on LOCAL database (explicit)
 * In cloud mode, this throws an error (no local DB)
 */
async function queryLocal(text, params = []) {
  if (isCloudMode) {
    throw new Error('Local database not available in cloud mode');
  }
  return localPool.query(text, params);
}

/**
 * Execute query on REMOTE database
 * ONLY used by sync service to push data to Supabase
 */
async function queryRemote(text, params = []) {
  if (!remoteConnected) {
    throw new Error('Remote database not available for sync');
  }
  return remotePool.query(text, params);
}

/**
 * Get a client from PRIMARY pool for transactions
 * - Cloud mode: Supabase
 * - Local mode: Local PostgreSQL
 */
async function getClient() {
  const pool = isCloudMode ? remotePool : localPool;
  return pool.connect();
}

/**
 * Get a client from LOCAL pool (explicit)
 * In cloud mode, this throws an error
 */
async function getLocalClient() {
  if (isCloudMode) {
    throw new Error('Local database not available in cloud mode');
  }
  return localPool.connect();
}

/**
 * Get a client from REMOTE pool (for sync only)
 */
async function getRemoteClient() {
  if (!remoteConnected) {
    throw new Error('Remote database not available for sync');
  }
  return remotePool.connect();
}

/**
 * Run a transaction on LOCAL database
 */
async function transaction(callback) {
  const client = await getClient();
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Get connection status
 */
function getStatus() {
  return {
    mode: DEPLOYMENT_MODE,
    local: localConnected,
    remote: remoteConnected,
    localPool: localPool ? {
      total: localPool.totalCount,
      idle: localPool.idleCount,
      waiting: localPool.waitingCount,
    } : null,
    remotePool: {
      total: remotePool.totalCount,
      idle: remotePool.idleCount,
      waiting: remotePool.waitingCount,
    },
  };
}

/**
 * Test connection to a specific database
 */
async function testConnection(target = 'local') {
  try {
    const pool = target === 'remote' ? remotePool : localPool;
    const result = await pool.query('SELECT NOW() as time');
    return { connected: true, time: result.rows[0].time };
  } catch (error) {
    return { connected: false, error: error.message };
  }
}

/**
 * Close all pools
 */
async function close() {
  const pools = [remotePool.end()];
  if (localPool) {
    pools.push(localPool.end());
  }
  await Promise.all(pools);
  logger.info('All database pools closed');
}

/**
 * Check if remote is available for sync
 */
function isRemoteAvailable() {
  return remoteConnected;
}

/**
 * Try to reconnect to remote Supabase (called by sync service)
 */
async function reconnectRemote() {
  try {
    await remotePool.query('SELECT 1');
    remoteConnected = true;
    return true;
  } catch (error) {
    remoteConnected = false;
    return false;
  }
}

module.exports = {
  // Deployment mode
  DEPLOYMENT_MODE,
  isCloudMode,
  isLocalMode: !isCloudMode,
  
  // Initialization
  initialize,
  
  // Primary query interface (uses appropriate DB based on mode)
  query,
  getClient,
  transaction,
  
  // Explicit local/remote queries (for sync service)
  queryLocal,
  queryRemote,
  getLocalClient,
  getRemoteClient,
  
  // Aliases for explicit access
  local: {
    query: queryLocal,
    getClient: getLocalClient,
  },
  remote: {
    query: queryRemote,
    getClient: getRemoteClient,
  },
  
  // Status & utilities
  getStatus,
  isRemoteAvailable,
  reconnectRemote,
  testConnection,
  close,
  
  // Pool access (for advanced use)
  localPool,
  remotePool,
};