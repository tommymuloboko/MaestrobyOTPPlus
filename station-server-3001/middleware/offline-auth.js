/**
 * Offline Auth Middleware - DEPRECATED
 * 
 * Now re-exports from auth.js for backward compatibility.
 * All authentication uses LOCAL PostgreSQL - no online/offline switching.
 * 
 * For new code, import from './auth' directly.
 */

const auth = require('./auth');

module.exports = {
  offlineAuthMiddleware: auth.authMiddleware,
  generateToken: auth.generateToken,
  requireRole: auth.requireRole,
  requireCompany: auth.requireCompany,
  verifyTokenRemote: auth.authMiddleware,
  verifyTokenLocal: auth.authMiddleware
};
