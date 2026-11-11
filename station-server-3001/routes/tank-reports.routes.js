/**
 * Tank Reports Routes - Tank measurement history (trend) + future tank reports.
 *
 * Standalone, additive module. Does NOT modify existing PTS or tanks routes.
 * Serves the contract the Maestro-lite-V4 frontend already expects:
 *
 *   GET /api/pts/reports/tank-measurements?tank=N&start=&end=
 *       tank=0 (or omitted) → all tanks; otherwise filter to that pts2 tank id.
 *       Returns { success, data: [ PtsTankMeasurement, ... ] } with PascalCase
 *       PTS keys (DateTime, Tank, ProductVolume, Temperature, …) so the UI parses
 *       it unchanged. Empty history → { data: [] } (never an error).
 *
 * Rows are written by the poller (pts-polling.service storeTankMeasurement),
 * throttled to one row / tank / TANK_MEASUREMENT_INTERVAL_MS. History only
 * accrues going forward — there is no historical backfill.
 *
 * Mount (one line in index.js, alongside the other public PTS routes):
 *   app.use('/api/pts', require('./routes/tank-reports.routes')); // BEFORE authMiddleware
 */

const express = require('express');
const router = express.Router();
const db = require('../utils/db');
const logger = require('../utils/logger')('TankReports');

/** Coerce a pg NUMERIC (returned as string) to a JS number, or null. */
function num(v) {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Map a tank_measurements DB row to the frontend's PtsTankMeasurement shape. */
function toPtsMeasurement(row) {
  return {
    DateTime: row.date_time instanceof Date ? row.date_time.toISOString() : row.date_time,
    Tank: row.pts2_tank_id,
    FuelGradeId: row.fuel_grade_id != null ? row.fuel_grade_id : null,
    FuelGradeName: row.fuel_grade_name || null,
    Status: row.status || null,
    Alarms: Array.isArray(row.alarms) ? row.alarms : [],
    ProductHeight: num(row.product_height),
    WaterHeight: num(row.water_height),
    Temperature: num(row.temperature),
    ProductVolume: num(row.product_volume),
    WaterVolume: num(row.water_volume),
    ProductUllage: num(row.product_ullage),
    TankFillingPercentage: num(row.tank_filling_percentage)
  };
}

/**
 * @swagger
 * /api/pts/reports/tank-measurements:
 *   get:
 *     tags: [PTS]
 *     summary: Tank measurement history (trend) from stored PTS-2 probe readings
 *     description: |
 *       Time-series of tank measurements persisted by the poller. tank=0 (or
 *       omitted) returns every tank; otherwise filters to that PTS-2 tank id.
 *       History accrues going forward only — no backfill.
 *     parameters:
 *       - in: query
 *         name: tank
 *         schema: { type: integer, default: 0 }
 *         description: PTS-2 tank id; 0 or omitted = all tanks
 *       - in: query
 *         name: start
 *         schema: { type: string }
 *         description: ISO datetime lower bound (inclusive)
 *       - in: query
 *         name: end
 *         schema: { type: string }
 *         description: ISO datetime upper bound (inclusive)
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 5000 }
 *     responses:
 *       200: { description: Array of tank measurements }
 */
router.get('/reports/tank-measurements', async (req, res) => {
  try {
    const tank = parseInt(req.query.tank, 10);
    const allTanks = !Number.isInteger(tank) || tank === 0;

    const { start, end } = req.query;
    const limit = Math.min(parseInt(req.query.limit, 10) || 5000, 50000);

    const where = [];
    const params = [];
    let p = 0;

    if (!allTanks) {
      where.push(`pts2_tank_id = $${++p}`);
      params.push(tank);
    }
    if (start) {
      where.push(`date_time >= $${++p}`);
      params.push(start);
    }
    if (end) {
      where.push(`date_time <= $${++p}`);
      params.push(end);
    }

    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
    params.push(limit);

    const result = await db.query(
      `SELECT pts2_tank_id, date_time, fuel_grade_id, fuel_grade_name, status, alarms,
              product_height, water_height, temperature, product_volume,
              water_volume, product_ullage, tank_filling_percentage
       FROM tank_measurements
       ${whereSql}
       ORDER BY date_time ASC
       LIMIT $${++p}`,
      params
    );

    res.json({
      success: true,
      count: result.rows.length,
      data: result.rows.map(toPtsMeasurement)
    });
  } catch (error) {
    logger.error('Error fetching tank measurements', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
