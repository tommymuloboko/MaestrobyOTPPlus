/**
 * Database Module - Wrapper for database.js
 * 
 * This file now re-exports from database.js for backward compatibility.
 * All queries go to LOCAL PostgreSQL.
 * 
 * For new code, prefer importing from './database' directly.
 */

const database = require('./database');
const logger = require('./logger')('Database');

// Re-export all functions from database.js
module.exports = {
  query: database.query,
  transaction: database.transaction,
  getClient: database.getClient,
  getPoolStats: database.getStatus,
  close: database.close,
  pool: database.localPool,
  
  // Also expose the full database module
  database,
};
