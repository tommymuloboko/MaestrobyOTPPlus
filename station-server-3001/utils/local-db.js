/**
 * Local PostgreSQL Database Connection
 * Primary database for offline-first operations
 * All manager operations write here first, then sync to Supabase
 */

const { Pool } = require('pg');
const logger = require('./logger')('LocalDB');

// Create connection pool for local PostgreSQL
const localPool = new Pool({
  host: process.env.LOCAL_DB_HOST || 'localhost',
  port: parseInt(process.env.LOCAL_DB_PORT || '5432'),
  database: process.env.LOCAL_DB_NAME || 'MAESTRO-LITE',
  user: process.env.LOCAL_DB_USER || 'postgres',
  password: process.env.LOCAL_DB_PASSWORD || 'postgres',
  max: parseInt(process.env.LOCAL_DB_POOL_MAX || '10'),
  min: parseInt(process.env.LOCAL_DB_POOL_MIN || '2'),
  idleTimeoutMillis: parseInt(process.env.LOCAL_DB_IDLE_TIMEOUT || '30000'),
  connectionTimeoutMillis: parseInt(process.env.LOCAL_DB_CONNECTION_TIMEOUT || '5000'),
});

let isConnected = false;

localPool.on('error', (err) => {
  logger.error('Unexpected error on local DB idle client', err);
  isConnected = false;
});

localPool.on('connect', () => {
  logger.debug('New connection to local database pool');
  isConnected = true;
});

localPool.on('remove', () => {
  logger.debug('Client removed from local pool');
});

/**
 * Test connection to local PostgreSQL
 */
async function testConnection() {
  try {
    const client = await localPool.connect();
    await client.query('SELECT 1');
    client.release();
    isConnected = true;
    logger.info('Local PostgreSQL connection successful');
    return true;
  } catch (error) {
    isConnected = false;
    logger.error('Local PostgreSQL connection failed', error);
    return false;
  }
}

/**
 * Execute a query on local database
 */
async function query(text, params = []) {
  const start = Date.now();
  try {
    const result = await localPool.query(text, params);
    const duration = Date.now() - start;
    
    if (duration > 1000) {
      logger.warn(`Slow local query (${duration}ms)`, { text: text.substring(0, 50) });
    }
    
    return result;
  } catch (error) {
    logger.error('Local database query error', error);
    throw error;
  }
}

/**
 * Start a transaction on local database
 */
async function transaction(callback) {
  const client = await localPool.connect();
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    logger.error('Local transaction error', error);
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Get a client from the local pool
 */
async function getClient() {
  return await localPool.connect();
}

/**
 * Get pool statistics
 */
function getPoolStats() {
  return {
    totalCount: localPool.totalCount,
    idleCount: localPool.idleCount,
    waitingCount: localPool.waitingCount,
    isConnected,
  };
}

/**
 * Check if local database is connected
 */
function isLocalConnected() {
  return isConnected;
}

/**
 * Close the local pool
 */
async function close() {
  await localPool.end();
  isConnected = false;
  logger.info('Local database pool closed');
}

module.exports = {
  query,
  transaction,
  getClient,
  getPoolStats,
  isLocalConnected,
  testConnection,
  close,
  pool: localPool,
};
