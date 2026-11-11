/**
 * Dashboard Routes
 * 
 * Provides summarised data for the admin dashboard.
 * All data comes from the local PostgreSQL database.
 * 
 * GET /api/dashboard/summary  — Aggregated counts, open-shift info, cashup totals, etc.
 */

const express = require('express');
const router = express.Router();
const db = require('../utils/db');
const logger = require('../utils/logger')('DashboardRoutes');

/**
 * GET /api/dashboard/summary
 * 
 * Returns a single JSON payload with:
 *  - open shift details (or null)
 *  - shift statistics (today, total, open/closed counts)
 *  - attendant statistics
 *  - debtor statistics
 *  - cashup overview (today's declared totals)
 *  - recent cashups
 *  - recent shifts
 */
router.get('/summary', async (req, res) => {
  try {
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    // ── 1. Open shift (if any) with its attendants ──────────
    const openShiftResult = await db.query(
      `SELECT s.*, 
              (SELECT COUNT(*) FROM shift_attendants sa WHERE sa.shift_id = s.id) AS attendant_count
       FROM shifts s
       WHERE s.status = 'open'
       ORDER BY s.start_datetime DESC
       LIMIT 1`
    );
    let openShift = null;
    let openShiftAttendants = [];

    if (openShiftResult.rows.length > 0) {
      openShift = openShiftResult.rows[0];
      const attResult = await db.query(
        `SELECT DISTINCT ON (sa.attendant_id) sa.pump_id, a.id AS attendant_id, a.full_name, a.phone
         FROM shift_attendants sa
         LEFT JOIN attendants a ON sa.attendant_id = a.id
         WHERE sa.shift_id = $1
         ORDER BY sa.attendant_id, sa.pump_id`,
        [openShift.id]
      );
      openShiftAttendants = attResult.rows;
    }

    // ── 2. Shift statistics ─────────────────────────────────
    const shiftStats = await db.query(`
      SELECT 
        COUNT(*) AS total_shifts,
        COUNT(*) FILTER (WHERE status = 'open') AS open_shifts,
        COUNT(*) FILTER (WHERE status = 'closed') AS closed_shifts,
        COUNT(*) FILTER (WHERE start_datetime >= $1) AS today_shifts
      FROM shifts
    `, [todayStart.toISOString()]);

    // ── 3. Attendant statistics ─────────────────────────────
    const attendantStats = await db.query(`
      SELECT 
        COUNT(*) AS total_attendants
      FROM attendants
    `);

    // How many attendants are currently on shift (assigned to open shifts)
    const onShiftResult = await db.query(`
      SELECT COUNT(DISTINCT sa.attendant_id) AS on_shift_count
      FROM shift_attendants sa
      JOIN shifts s ON sa.shift_id = s.id
      WHERE s.status = 'open'
    `);

    // ── 4. Debtor statistics ────────────────────────────────
    const debtorStats = await db.query(`
      SELECT 
        COUNT(*) AS total_debtors,
        COALESCE(SUM(CASE WHEN current_balance > 0 THEN current_balance ELSE 0 END), 0) AS total_outstanding
      FROM debtors
    `);

    // ── 5. Cashup overview (today) ──────────────────────────
    const cashupToday = await db.query(`
      SELECT 
        COUNT(*) AS cashup_count,
        COALESCE(SUM(CAST(declared_cash AS NUMERIC)), 0) AS total_cash,
        COALESCE(SUM(CAST(declared_card AS NUMERIC)), 0) AS total_card,
        COALESCE(SUM(CAST(declared_mobile AS NUMERIC)), 0) AS total_mobile,
        COALESCE(SUM(CAST(declared_debtor AS NUMERIC)), 0) AS total_debtor,
        COALESCE(SUM(CAST(declared_total AS NUMERIC)), 0) AS total_declared,
        COALESCE(SUM(CAST(variance AS NUMERIC)), 0) AS total_variance
      FROM shift_cashup
      WHERE created_at >= $1
    `, [todayStart.toISOString()]);

    // ── 6. Recent shifts (last 5) ───────────────────────────
    const recentShifts = await db.query(`
      SELECT s.id, s.status, s.start_datetime, s.end_datetime, s.created_at,
             (SELECT COUNT(*) FROM shift_attendants sa WHERE sa.shift_id = s.id) AS attendant_count
      FROM shifts s
      ORDER BY s.created_at DESC
      LIMIT 5
    `);

    // ── 7. Recent cashups (last 5) ──────────────────────────
    const recentCashups = await db.query(`
      SELECT sc.*, a.full_name AS attendant_name
      FROM shift_cashup sc
      LEFT JOIN attendants a ON sc.attendant_id = a.id
      ORDER BY sc.created_at DESC
      LIMIT 5
    `);

    // ── 8. Vehicle & driver counts ──────────────────────────
    let vehicleCount = 0;
    let driverCount = 0;
    try {
      const vr = await db.query('SELECT COUNT(*) FROM debtor_vehicles');
      vehicleCount = parseInt(vr.rows[0].count);
      const dr = await db.query('SELECT COUNT(*) FROM drivers');
      driverCount = parseInt(dr.rows[0].count);
    } catch (e) { /* tables may not exist */ }

    // ── 9. Price change log count (today) ───────────────────
    let priceChangesToday = 0;
    try {
      const pcr = await db.query('SELECT COUNT(*) FROM price_change_log WHERE created_at >= $1', [todayStart.toISOString()]);
      priceChangesToday = parseInt(pcr.rows[0].count);
    } catch (e) { /* table may not exist */ }

    // ── Assemble response ───────────────────────────────────
    const sStats = shiftStats.rows[0];
    const aStats = attendantStats.rows[0];
    const dStats = debtorStats.rows[0];
    const cToday = cashupToday.rows[0];

    res.json({
      success: true,
      timestamp: new Date().toISOString(),

      open_shift: openShift ? {
        id: openShift.id,
        status: openShift.status,
        start_datetime: openShift.start_datetime,
        attendant_count: parseInt(openShift.attendant_count),
        attendants: openShiftAttendants,
        duration_minutes: Math.round((Date.now() - new Date(openShift.start_datetime).getTime()) / 60000),
      } : null,

      shifts: {
        total: parseInt(sStats.total_shifts),
        open: parseInt(sStats.open_shifts),
        closed: parseInt(sStats.closed_shifts),
        today: parseInt(sStats.today_shifts),
      },

      attendants: {
        total: parseInt(aStats.total_attendants),
        active: parseInt(aStats.total_attendants),
        on_shift: parseInt(onShiftResult.rows[0].on_shift_count),
      },

      debtors: {
        total: parseInt(dStats.total_debtors),
        total_outstanding: parseFloat(dStats.total_outstanding),
      },

      vehicles: vehicleCount,
      drivers: driverCount,

      cashup_today: {
        count: parseInt(cToday.cashup_count),
        cash: parseFloat(cToday.total_cash),
        card: parseFloat(cToday.total_card),
        mobile: parseFloat(cToday.total_mobile),
        debtor: parseFloat(cToday.total_debtor),
        declared_total: parseFloat(cToday.total_declared),
        variance: parseFloat(cToday.total_variance),
      },

      price_changes_today: priceChangesToday,

      recent_shifts: recentShifts.rows,
      recent_cashups: recentCashups.rows,
    });
  } catch (error) {
    logger.error('Error building dashboard summary', error);
    res.status(500).json({ success: false, code: 'DASHBOARD_ERROR', message: error.message });
  }
});

module.exports = router;
