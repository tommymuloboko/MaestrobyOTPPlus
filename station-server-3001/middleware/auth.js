/**
 * Simple Auth Middleware
 * 
 * All authentication uses LOCAL PostgreSQL only.
 * No online/offline logic - always use local DB.
 */

const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const logger = require('../utils/logger')('Auth');
const database = require('../utils/database');

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-key-change-in-production';
const JWT_EXPIRY = process.env.JWT_EXPIRY || '24h';
const SERVICE_TOKEN = process.env.SERVICE_TOKEN || '';

// Constant-time comparison so token-match timing can't be used to guess the token.
function tokensMatch(provided, expected) {
  if (!expected || !provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/**
 * Authentication middleware - verifies JWT and loads user from LOCAL DB
 */
async function authMiddleware(req, res, next) {
  try {
    // Skip auth for public routes
    if (isPublicRoute(req.path)) {
      return next();
    }

    // Get token from header
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({
        error: 'Unauthorized',
        message: 'Missing or invalid authorization header'
      });
    }

    const token = authHeader.substring(7);

    // --- Service token path (central server, machine-to-machine) ---
    // Checked BEFORE JWT verify. If the token matches SERVICE_TOKEN in .env,
    // grant a machine-level identity and skip the normal user lookup.
    if (SERVICE_TOKEN && tokensMatch(token, SERVICE_TOKEN)) {
      req.user = {
        userId: 'service:central',
        username: 'central-service',
        email: null,
        fullName: 'Central Server',
        companyId: process.env.OFFLINE_COMPANY_ID || process.env.COMPANY_ID || null,
        stationId: process.env.OFFLINE_STATION_ID || process.env.STATION_ID || null,
        roles: ['service', 'admin'],
        isService: true,
      };
      logger.debug(`Service-token auth → ${req.method} ${req.path}`);
      return next();
    }

    // Verify JWT
    let decoded;
    try {
      decoded = jwt.verify(token, JWT_SECRET);
    } catch (jwtError) {
      return res.status(401).json({
        error: 'Unauthorized',
        message: 'Invalid or expired token'
      });
    }

    // Load user from LOCAL database
    try {
      const result = await database.queryLocal(`
        SELECT id, company_id, station_id, username, email, full_name, is_active
        FROM users
        WHERE id = $1 AND is_active = true
      `, [decoded.userId]);

      if (result.rows.length === 0) {
        return res.status(401).json({
          error: 'Unauthorized',
          message: 'User not found or inactive'
        });
      }

      const user = result.rows[0];

      // Get user roles
      let roles = decoded.roles || [];
      try {
        const rolesResult = await database.queryLocal(`
          SELECT r.name
          FROM user_roles ur
          JOIN roles r ON ur.role_id = r.id
          WHERE ur.user_id = $1
        `, [user.id]);
        if (rolesResult.rows.length > 0) {
          roles = rolesResult.rows.map(r => r.name);
        }
      } catch (roleError) {
        logger.debug('Failed to fetch roles, using token roles');
      }

      // Set user on request
      req.user = {
        userId: user.id,
        username: user.username,
        email: user.email,
        fullName: user.full_name,
        companyId: user.company_id,
        stationId: user.station_id,
        roles: roles
      };

      return next();
    } catch (dbError) {
      logger.error('Database error during auth', dbError);
      // If local DB fails, fall back to token data
      req.user = {
        userId: decoded.userId,
        username: decoded.username,
        email: decoded.email,
        fullName: decoded.fullName,
        companyId: decoded.companyId,
        stationId: decoded.stationId,
        roles: decoded.roles || []
      };
      return next();
    }
  } catch (error) {
    logger.error('Authentication middleware error', error);
    return res.status(500).json({
      error: 'Authentication error',
      message: error.message
    });
  }
}

/**
 * Check if route is public (no auth required)
 */
function isPublicRoute(path) {
  const publicRoutes = [
    '/api/auth/login',
    '/api/auth/register',
    '/api/health',
    '/api/status',
    '/api/sync/station-config',
    '/api/sync/pull-station'
  ];
  return publicRoutes.some(route => path.startsWith(route));
}

/**
 * Generate JWT token
 */
function generateToken(user, roles = []) {
  return jwt.sign(
    {
      userId: user.id,
      username: user.username,
      email: user.email,
      fullName: user.full_name,
      companyId: user.company_id,
      stationId: user.station_id,
      roles: roles
    },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRY }
  );
}

/**
 * Require specific role(s)
 */
function requireRole(...requiredRoles) {
  return (req, res, next) => {
    if (!req.user) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const userRoles = req.user.roles || [];
    const hasRole = requiredRoles.some(role => userRoles.includes(role));
    
    if (!hasRole) {
      return res.status(403).json({
        error: 'Forbidden',
        message: `This operation requires one of: ${requiredRoles.join(', ')}`
      });
    }

    next();
  };
}

/**
 * Require same company access
 */
function requireCompany(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const requestedCompanyId = req.params.company_id || req.body.company_id || req.query.company_id;
  
  if (requestedCompanyId && req.user.companyId !== requestedCompanyId) {
    return res.status(403).json({
      error: 'Forbidden',
      message: 'You do not have access to this company'
    });
  }

  next();
}

module.exports = {
  authMiddleware,
  generateToken,
  requireRole,
  requireCompany,
  // Aliases for backward compatibility
  offlineAuthMiddleware: authMiddleware
};
