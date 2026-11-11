/**
 * Company Portal Routes — READ-ONLY
 *
 * Exposes transaction data scoped strictly to the authenticated company.
 * The company_id is always taken from the verified JWT — it can never be
 * overridden by a query parameter or request body.
 *
 * Mounted at: GET /api/company/...
 *
 * Auth flow:
 *   1. Company logs in via POST /api/auth/login (same endpoint, role = 'company')
 *   2. JWT is issued with companyId embedded
 *   3. Every request here forces WHERE company_id = <jwt.companyId>
 */

const express = require('express');
const router = express.Router();
const db = require('../utils/db');
const logger = require('../utils/logger')('CompanyPortal');
const { authMiddleware, requireRole } = require('../middleware/auth');

// All routes require a valid JWT with role 'company' (or admin/manager for testing)
router.use(authMiddleware);
router.use(requireRole('company', 'admin', 'manager'));

/**
 * Middleware: ensure every request has a companyId.
 *
 * Two accepted sources (in priority order):
 *  1. JWT companyId  — normal company user logging in directly
 *  2. ?company_id query param — trusted only when caller has the 'service' role
 *     (i.e. the central server calling on behalf of a company via its service token)
 *
 * Any other combination → 403.
 */
router.use((req, res, next) => {
  if (req.user?.companyId) {
    // Normal company JWT — already scoped
    return next();
  }

  if (req.user?.roles?.includes('service') && req.query.company_id) {
    // Central server fan-out — trust the passed company_id
    req.user.companyId = req.query.company_id;
    return next();
  }

  return res.status(403).json({
    error: 'Forbidden',
    message: 'This token is not associated with a company account.',
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/company/me
// Returns the company profile for the authenticated token.
// ─────────────────────────────────────────────────────────────────────────────
router.get('/me', async (req, res) => {
  try {
    const result = await db.query(
      `SELECT id, name, code, created_at FROM companies WHERE id = $1`,
      [req.user.companyId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Company not found' });
    }

    res.json({ success: true, company: result.rows[0] });
  } catch (error) {
    logger.error('Error fetching company profile', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/company/transactions
//
// Query params (all optional):
//   from        ISO datetime  e.g. 2026-05-01T00:00:00
//   to          ISO datetime  e.g. 2026-05-04T23:59:59
//   station_id  UUID
//   pump_id     UUID
//   is_verified boolean (true/false)
//   limit       int (default 100, max 500)
//   offset      int (default 0)
// ─────────────────────────────────────────────────────────────────────────────
router.get('/transactions', async (req, res) => {
  try {
    const {
      from,
      to,
      station_id,
      pump_id,
      is_verified,
      limit = 100,
      offset = 0,
    } = req.query;

    // Clamp limit to prevent abuse
    const safeLimit = Math.min(Math.max(1, parseInt(limit) || 100), 500);
    const safeOffset = Math.max(0, parseInt(offset) || 0);

    const params = [req.user.companyId]; // $1 — always locked to the JWT company
    let paramCount = 1;

    let query = `
      SELECT
        t.id,
        t.station_id,
        t.pump_id,
        t.time,
        t.amount,
        t.currency,
        t.transaction_id,
        t.tag_number,
        t.full_name,
        t.is_verified,
        t.created_at
      FROM fuel_transactions_raw t
      WHERE t.company_id = $1
    `;

    if (station_id) {
      query += ` AND t.station_id = $${++paramCount}`;
      params.push(station_id);
    }

    if (pump_id) {
      query += ` AND t.pump_id = $${++paramCount}`;
      params.push(pump_id);
    }

    if (is_verified !== undefined) {
      query += ` AND t.is_verified = $${++paramCount}`;
      params.push(is_verified === 'true');
    }

    if (from) {
      query += ` AND t.time >= $${++paramCount}`;
      params.push(new Date(from));
    }

    if (to) {
      query += ` AND t.time <= $${++paramCount}`;
      params.push(new Date(to));
    }

    query += ` ORDER BY t.time DESC LIMIT $${++paramCount} OFFSET $${++paramCount}`;
    params.push(safeLimit, safeOffset);

    const result = await db.query(query, params);

    res.json({
      success: true,
      company_id: req.user.companyId,
      count: result.rows.length,
      limit: safeLimit,
      offset: safeOffset,
      transactions: result.rows,
    });
  } catch (error) {
    logger.error('Error fetching company transactions', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/company/transactions/summary
//
// Aggregated totals for the authenticated company.
// Query params: from, to, station_id
// ─────────────────────────────────────────────────────────────────────────────
router.get('/transactions/summary', async (req, res) => {
  try {
    const { from, to, station_id } = req.query;

    const params = [req.user.companyId];
    let paramCount = 1;

    let query = `
      SELECT
        COUNT(*)                                                   AS total_count,
        COALESCE(SUM(amount), 0)                                   AS total_amount,
        COUNT(*) FILTER (WHERE is_verified = true)                 AS verified_count,
        COALESCE(SUM(amount) FILTER (WHERE is_verified = true), 0) AS verified_amount,
        COUNT(*) FILTER (WHERE is_verified = false)                AS unverified_count,
        COALESCE(SUM(amount) FILTER (WHERE is_verified = false), 0)AS unverified_amount,
        MIN(time)                                                  AS earliest,
        MAX(time)                                                  AS latest
      FROM fuel_transactions_raw
      WHERE company_id = $1
    `;

    if (station_id) {
      query += ` AND station_id = $${++paramCount}`;
      params.push(station_id);
    }

    if (from) {
      query += ` AND time >= $${++paramCount}`;
      params.push(new Date(from));
    }

    if (to) {
      query += ` AND time <= $${++paramCount}`;
      params.push(new Date(to));
    }

    const result = await db.query(query, params);
    const row = result.rows[0];

    res.json({
      success: true,
      company_id: req.user.companyId,
      summary: {
        total_count: parseInt(row.total_count),
        total_amount: parseFloat(row.total_amount),
        verified_count: parseInt(row.verified_count),
        verified_amount: parseFloat(row.verified_amount),
        unverified_count: parseInt(row.unverified_count),
        unverified_amount: parseFloat(row.unverified_amount),
        earliest: row.earliest,
        latest: row.latest,
      },
    });
  } catch (error) {
    logger.error('Error fetching company transaction summary', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/company/transactions/:id
//
// Returns a single transaction — only if it belongs to the company.
// ─────────────────────────────────────────────────────────────────────────────
router.get('/transactions/:id', async (req, res) => {
  try {
    const result = await db.query(
      `SELECT
         id, station_id, pump_id, time, amount, currency,
         transaction_id, tag_number, full_name, is_verified, created_at
       FROM fuel_transactions_raw
       WHERE id = $1 AND company_id = $2`,
      [req.params.id, req.user.companyId]
    );

    if (result.rows.length === 0) {
      // Return 404 whether the record doesn't exist OR belongs to another company
      // — this avoids leaking that the transaction ID exists at all
      return res.status(404).json({ error: 'Transaction not found' });
    }

    res.json({ success: true, transaction: result.rows[0] });
  } catch (error) {
    logger.error('Error fetching company transaction by id', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

module.exports = router;
