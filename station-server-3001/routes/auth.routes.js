const express = require('express');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const logger = require('../utils/logger')('AuthRoutes');
const database = require('../utils/database');
const db = database; // alias – both names used in this file

const router = express.Router();

const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-key-change-in-production';
const JWT_EXPIRY = process.env.JWT_EXPIRY || '24h';
const BCRYPT_ROUNDS = parseInt(process.env.BCRYPT_ROUNDS || '10');

/**
 * @swagger
 * /api/auth/login:
 *   post:
 *     summary: Authenticate user and get JWT token
 *     tags: [Auth]
 *     security: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - password
 *             properties:
 *               identifier:
 *                 type: string
 *                 description: Username or email address
 *                 example: admin
 *               username:
 *                 type: string
 *                 description: Deprecated - use `identifier`. Accepts username or email.
 *                 example: admin
 *               email:
 *                 type: string
 *                 description: Alternative to `identifier`.
 *                 example: admin@example.com
 *               password:
 *                 type: string
 *                 example: password123
 *     responses:
 *       200:
 *         description: Login successful
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 token:
 *                   type: string
 *                 user:
 *                   type: object
 *       401:
 *         description: Invalid credentials
 */
router.post('/login', async (req, res) => {
  try {
    const { identifier, username, email, password } = req.body;
    const loginId = (identifier || username || email || '').trim();
    const authSource = 'local';  // Authentication source (local PostgreSQL)

    if (!loginId || !password) {
      return res.status(400).json({
        error: 'Missing required fields: identifier (username or email), password'
      });
    }

    // Query user from LOCAL database — match on username OR email (case-insensitive email)
    const userResult = await database.query(`
      SELECT
        u.id,
        u.company_id,
        u.station_id,
        u.username,
        u.password_hash,
        u.full_name,
        u.email,
        u.is_active
      FROM users u
      WHERE u.username = $1 OR LOWER(u.email) = LOWER($1)
      LIMIT 1
    `, [loginId]);

    if (userResult.rows.length === 0) {
      logger.warn(`Login failed: user not found - ${loginId}`);
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const user = userResult.rows[0];

    if (!user.is_active) {
      logger.warn(`Login failed: user inactive - ${loginId}`);
      return res.status(401).json({ error: 'Account is inactive' });
    }

    // Verify password
    const passwordMatch = await bcrypt.compare(password, user.password_hash);
    if (!passwordMatch) {
      logger.warn(`Login failed: invalid password - ${loginId}`);
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // Get user roles
    let roles = [];
    try {
      const rolesResult = await database.query(`
        SELECT r.name
        FROM user_roles ur
        JOIN roles r ON ur.role_id = r.id
        WHERE ur.user_id = $1
      `, [user.id]);
      roles = rolesResult.rows.map(r => r.name);
    } catch (roleError) {
      logger.debug('Failed to fetch roles:', roleError.message);
    }

    // Generate JWT
    const token = jwt.sign({
      userId: user.id,
      companyId: user.company_id,
      stationId: user.station_id,
      username: user.username,
      email: user.email,
      fullName: user.full_name,
      roles: roles
    }, JWT_SECRET, { expiresIn: JWT_EXPIRY });

    logger.info(`✅ User logged in (${authSource}): ${user.username}`);

    res.json({
      success: true,
      token,
      expiresIn: JWT_EXPIRY,
      authSource: authSource,
      user: {
        id: user.id,
        company_id: user.company_id,
        station_id: user.station_id,
        username: user.username,
        full_name: user.full_name,
        email: user.email,
        roles: roles
      }
    });
  } catch (error) {
    logger.error('Login error', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * @swagger
 * /api/auth/register:
 *   post:
 *     summary: Create a new user account
 *     tags: [Auth]
 *     security: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - company_id
 *               - username
 *               - password
 *             properties:
 *               company_id:
 *                 type: string
 *                 format: uuid
 *               station_id:
 *                 type: string
 *                 format: uuid
 *               username:
 *                 type: string
 *               password:
 *                 type: string
 *               full_name:
 *                 type: string
 *               email:
 *                 type: string
 *               role_ids:
 *                 type: array
 *                 items:
 *                   type: string
 *                   format: uuid
 *     responses:
 *       201:
 *         description: User created successfully
 *       400:
 *         description: Missing required fields
 *       409:
 *         description: Username or email already exists
 */
router.post('/register', async (req, res) => {
  try {
    const { 
      company_id, 
      station_id, 
      username, 
      password, 
      full_name, 
      email,
      role_ids 
    } = req.body;

    // Validate required fields
    if (!company_id || !username || !password) {
      return res.status(400).json({
        error: 'Missing required fields: company_id, username, password'
      });
    }

    // Check if username already exists
    const existingUser = await db.query(
      'SELECT id FROM users WHERE username = $1',
      [username]
    );

    if (existingUser.rows.length > 0) {
      return res.status(409).json({ error: 'Username already exists' });
    }

    // Check if email already exists (if provided)
    if (email) {
      const existingEmail = await db.query(
        'SELECT id FROM users WHERE email = $1',
        [email]
      );

      if (existingEmail.rows.length > 0) {
        return res.status(409).json({ error: 'Email already registered' });
      }
    }

    // Verify company exists
    const companyCheck = await db.query(
      'SELECT id FROM companies WHERE id = $1',
      [company_id]
    );

    if (companyCheck.rows.length === 0) {
      return res.status(400).json({ error: 'Invalid company_id' });
    }

    // Verify station exists (if provided)
    if (station_id) {
      const stationCheck = await db.query(
        'SELECT id FROM stations WHERE id = $1 AND company_id = $2',
        [station_id, company_id]
      );

      if (stationCheck.rows.length === 0) {
        return res.status(400).json({ error: 'Invalid station_id or station does not belong to company' });
      }
    }

    // Hash password
    const password_hash = await bcrypt.hash(password, BCRYPT_ROUNDS);

    // Insert user into USERS table
    const userResult = await db.query(`
      INSERT INTO users (
        company_id,
        station_id,
        username,
        password_hash,
        full_name,
        email,
        is_active,
        created_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, true, now())
      RETURNING id, company_id, station_id, username, full_name, email, is_active, created_at
    `, [company_id, station_id || null, username, password_hash, full_name || null, email || null]);

    const newUser = userResult.rows[0];

    // Assign roles if provided
    let assignedRoles = [];
    if (role_ids && role_ids.length > 0) {
      for (const roleId of role_ids) {
        try {
          await db.query(`
            INSERT INTO user_roles (user_id, role_id)
            VALUES ($1, $2)
          `, [newUser.id, roleId]);

          // Get role name
          const roleResult = await db.query('SELECT name FROM roles WHERE id = $1', [roleId]);
          if (roleResult.rows.length > 0) {
            assignedRoles.push(roleResult.rows[0].name);
          }
        } catch (roleError) {
          logger.warn(`Failed to assign role ${roleId}: ${roleError.message}`);
        }
      }
    }

    logger.info(`✅ User registered: ${username} (${newUser.id})`);

    res.status(201).json({
      success: true,
      user: {
        id: newUser.id,
        company_id: newUser.company_id,
        station_id: newUser.station_id,
        username: newUser.username,
        full_name: newUser.full_name,
        email: newUser.email,
        is_active: newUser.is_active,
        created_at: newUser.created_at,
        roles: assignedRoles
      }
    });
  } catch (error) {
    logger.error('Registration error', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * POST /api/auth/refresh
 * Refresh JWT token (requires valid token)
 */
router.post('/refresh', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Missing authorization header' });
    }

    const token = authHeader.substring(7);

    // Verify existing token
    let decoded;
    try {
      decoded = jwt.verify(token, JWT_SECRET);
    } catch (err) {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }

    // Verify user still exists and is active
    const userResult = await db.query(`
      SELECT id, company_id, station_id, username, full_name, email, is_active
      FROM users
      WHERE id = $1
    `, [decoded.userId]);

    if (userResult.rows.length === 0 || !userResult.rows[0].is_active) {
      return res.status(401).json({ error: 'User not found or inactive' });
    }

    const user = userResult.rows[0];

    // Get current roles
    const rolesResult = await db.query(`
      SELECT r.name
      FROM user_roles ur
      JOIN roles r ON ur.role_id = r.id
      WHERE ur.user_id = $1
    `, [user.id]);

    const roles = rolesResult.rows.map(r => r.name);

    // Generate new token
    const newToken = jwt.sign({
      userId: user.id,
      companyId: user.company_id,
      stationId: user.station_id,
      username: user.username,
      email: user.email,
      fullName: user.full_name,
      roles: roles
    }, JWT_SECRET, { expiresIn: JWT_EXPIRY });

    logger.info(`✅ Token refreshed for: ${user.username}`);

    res.json({
      success: true,
      token: newToken,
      expiresIn: JWT_EXPIRY
    });
  } catch (error) {
    logger.error('Token refresh error', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/auth/me
 * Get current user info (requires valid token)
 */
router.get('/me', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Missing authorization header' });
    }

    const token = authHeader.substring(7);

    // Verify token
    let decoded;
    try {
      decoded = jwt.verify(token, JWT_SECRET);
    } catch (err) {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }

    // Get full user info
    const userResult = await db.query(`
      SELECT 
        u.id,
        u.company_id,
        u.station_id,
        u.username,
        u.full_name,
        u.email,
        u.is_active,
        u.created_at,
        c.name as company_name,
        s.name as station_name
      FROM users u
      LEFT JOIN companies c ON u.company_id = c.id
      LEFT JOIN stations s ON u.station_id = s.id
      WHERE u.id = $1
    `, [decoded.userId]);

    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const user = userResult.rows[0];

    // Get roles
    const rolesResult = await db.query(`
      SELECT r.id, r.name
      FROM user_roles ur
      JOIN roles r ON ur.role_id = r.id
      WHERE ur.user_id = $1
    `, [user.id]);

    res.json({
      success: true,
      user: {
        id: user.id,
        company_id: user.company_id,
        company_name: user.company_name,
        station_id: user.station_id,
        station_name: user.station_name,
        username: user.username,
        full_name: user.full_name,
        email: user.email,
        is_active: user.is_active,
        created_at: user.created_at,
        roles: rolesResult.rows
      }
    });
  } catch (error) {
    logger.error('Get user error', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * PUT /api/auth/password
 * Change password (requires valid token)
 */
router.put('/password', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Missing authorization header' });
    }

    const token = authHeader.substring(7);
    const { current_password, new_password } = req.body;

    if (!current_password || !new_password) {
      return res.status(400).json({
        error: 'Missing required fields: current_password, new_password'
      });
    }

    // Verify token
    let decoded;
    try {
      decoded = jwt.verify(token, JWT_SECRET);
    } catch (err) {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }

    // Get current password hash
    const userResult = await db.query(
      'SELECT id, password_hash FROM users WHERE id = $1',
      [decoded.userId]
    );

    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Verify current password
    const passwordMatch = await bcrypt.compare(current_password, userResult.rows[0].password_hash);
    if (!passwordMatch) {
      return res.status(401).json({ error: 'Current password is incorrect' });
    }

    // Hash new password
    const new_password_hash = await bcrypt.hash(new_password, BCRYPT_ROUNDS);

    // Update password in local DB
    await db.query(
      'UPDATE users SET password_hash = $1 WHERE id = $2',
      [new_password_hash, decoded.userId]
    );

    // Mirror to Supabase (best-effort)
    try {
      await database.queryRemote(
        'UPDATE users SET password_hash = $1 WHERE id = $2',
        [new_password_hash, decoded.userId]
      );
    } catch (syncErr) {
      logger.warn('Password sync to Supabase failed (non-fatal):', syncErr.message);
    }

    logger.info(`✅ Password changed for user: ${decoded.username}`);

    res.json({
      success: true,
      message: 'Password updated successfully'
    });
  } catch (error) {
    logger.error('Password change error', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * GET /api/auth/roles
 * Get available roles (for registration dropdowns)
 */
router.get('/roles', async (req, res) => {
  try {
    const result = await db.query('SELECT id, name FROM roles ORDER BY name');

    res.json({
      success: true,
      roles: result.rows
    });
  } catch (error) {
    logger.error('Get roles error', error);
    res.status(500).json({ error: error.message });
  }
});

/**
 * PUT /api/auth/username
 * Change username (requires valid token + current password to confirm identity)
 * Body: { current_password, new_username }
 */
router.put('/username', async (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Missing authorization header' });
    }

    const token = authHeader.substring(7);
    const { current_password, new_username } = req.body;

    if (!current_password || !new_username) {
      return res.status(400).json({
        error: 'Missing required fields: current_password, new_username'
      });
    }

    const trimmedUsername = new_username.trim();
    if (trimmedUsername.length < 3) {
      return res.status(400).json({ error: 'Username must be at least 3 characters' });
    }
    if (!/^[a-zA-Z0-9._@-]+$/.test(trimmedUsername)) {
      return res.status(400).json({ error: 'Username may only contain letters, numbers and . _ @ -' });
    }

    // Verify token
    let decoded;
    try {
      decoded = jwt.verify(token, JWT_SECRET);
    } catch (err) {
      return res.status(401).json({ error: 'Invalid or expired token' });
    }

    // Fetch current user
    const userResult = await database.query(
      'SELECT id, username, password_hash FROM users WHERE id = $1',
      [decoded.userId]
    );
    if (userResult.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Confirm identity with current password
    const passwordMatch = await bcrypt.compare(current_password, userResult.rows[0].password_hash);
    if (!passwordMatch) {
      return res.status(401).json({ error: 'Current password is incorrect' });
    }

    // Check new username is not already taken
    const conflict = await database.query(
      'SELECT id FROM users WHERE username = $1 AND id != $2',
      [trimmedUsername, decoded.userId]
    );
    if (conflict.rows.length > 0) {
      return res.status(409).json({ error: 'Username is already taken' });
    }

    // Update local DB
    await database.query(
      'UPDATE users SET username = $1 WHERE id = $2',
      [trimmedUsername, decoded.userId]
    );

    // Mirror to Supabase (best-effort)
    try {
      await database.queryRemote(
        'UPDATE users SET username = $1 WHERE id = $2',
        [trimmedUsername, decoded.userId]
      );
    } catch (syncErr) {
      logger.warn('Username sync to Supabase failed (non-fatal):', syncErr.message);
    }

    logger.info(`✅ Username changed: ${userResult.rows[0].username} → ${trimmedUsername}`);

    res.json({
      success: true,
      message: 'Username updated successfully',
      username: trimmedUsername
    });
  } catch (error) {
    logger.error('Username change error', error);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
