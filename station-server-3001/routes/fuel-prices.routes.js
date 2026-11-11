/**
 * Fuel Prices & Scheduler Routes
 * 
 * Endpoints for managing fuel grade prices and the PTS-2 price scheduler.
 * Communicates directly with the PTS-2 forecourt controller via jsonPTS protocol.
 * 
 * Fuel Grades:
 *   GET  /api/fuel-grades              — Read fuel grades configuration from PTS-2
 *   GET  /api/fuel-grades/prices       — Read current fuel grade prices
 *   PUT  /api/fuel-grades/prices       — Set fuel grade prices immediately
 * 
 * Price Scheduler:
 *   GET  /api/fuel-grades/schedules    — Read price scheduler configuration
 *   PUT  /api/fuel-grades/schedules    — Set/update price schedules
 * 
 * Per-Pump Prices:
 *   GET  /api/fuel-grades/pump/:pump/prices  — Read prices for a specific pump
 *   PUT  /api/fuel-grades/pump/:pump/prices  — Set prices for a specific pump
 */

const express = require('express');
const router = express.Router();
const ptsPollingService = require('../services/pts-polling.service');
const db = require('../utils/db');
const logger = require('../utils/logger')('FuelPricesRoutes');
const { offlineAuthMiddleware, requireRole } = require('../middleware/offline-auth');

// ═══════════════════════════════════════════════
//  FUEL GRADES CONFIGURATION
// ═══════════════════════════════════════════════

/**
 * @swagger
 * /api/fuel-grades:
 *   get:
 *     tags: [Fuel Prices]
 *     summary: Get fuel grades configuration from PTS-2
 *     description: |
 *       Returns the full fuel grades configuration including Id, Name, Price,
 *       and ExpansionCoefficient for each configured fuel grade.
 *     responses:
 *       200:
 *         description: Fuel grades configuration
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean }
 *                 fuel_grades:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       Id: { type: integer }
 *                       Name: { type: string }
 *                       Price: { type: number }
 *                       ExpansionCoefficient: { type: number }
 */
router.get('/', async (req, res) => {
  try {
    const data = await ptsPollingService.getFuelGradesConfiguration();

    res.json({
      success: true,
      timestamp: new Date().toISOString(),
      fuel_grades: data.FuelGrades || data,
    });
  } catch (error) {
    logger.error('Error getting fuel grades configuration', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ═══════════════════════════════════════════════
//  FUEL GRADE PRICES
// ═══════════════════════════════════════════════

/**
 * @swagger
 * /api/fuel-grades/prices:
 *   get:
 *     tags: [Fuel Prices]
 *     summary: Get current fuel grade prices from PTS-2
 *     responses:
 *       200:
 *         description: Current fuel grade prices
 */
router.get('/prices', async (req, res) => {
  try {
    const data = await ptsPollingService.getFuelGradesPrices();

    res.json({
      success: true,
      timestamp: new Date().toISOString(),
      fuel_grades: data.FuelGrades || data,
    });
  } catch (error) {
    logger.error('Error getting fuel grades prices', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * @swagger
 * /api/fuel-grades/prices:
 *   put:
 *     tags: [Fuel Prices]
 *     summary: Set fuel grade prices immediately on PTS-2
 *     description: |
 *       Changes fuel prices immediately across the forecourt controller.
 *       Only the fuel grades included in the request will be updated.
 *       Requires admin or manager role.
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [fuel_grades]
 *             properties:
 *               fuel_grades:
 *                 type: array
 *                 items:
 *                   type: object
 *                   required: [Id, Price]
 *                   properties:
 *                     Id: { type: integer, description: "Fuel grade ID (1-10)" }
 *                     Name: { type: string, description: "Fuel grade name" }
 *                     Price: { type: number, description: "New price" }
 *           example:
 *             fuel_grades:
 *               - Id: 1
 *                 Name: "Petrol"
 *                 Price: 27.50
 *               - Id: 2
 *                 Name: "Diesel"
 *                 Price: 23.99
 *     responses:
 *       200:
 *         description: Prices updated successfully
 */
router.put('/prices', offlineAuthMiddleware, async (req, res) => {
  try {
    const protocolPrices = req.body?.FuelGradesPrices;
    const fuel_grades = req.body?.fuel_grades || protocolPrices;

    if (!fuel_grades || !Array.isArray(fuel_grades) || fuel_grades.length === 0) {
      return res.status(400).json({ error: 'fuel_grades array is required' });
    }

    // Validate each fuel grade entry (supports both {Id, Price} and {FuelGradeId, Price})
    for (const fg of fuel_grades) {
      const fuelGradeId = Number(fg.Id ?? fg.FuelGradeId);
      if (!Number.isInteger(fuelGradeId) || fuelGradeId < 1 || fuelGradeId > 10) {
        return res.status(400).json({ error: `Invalid fuel grade Id: ${fg.Id ?? fg.FuelGradeId}. Must be 1-10.` });
      }
      if (fg.Price === undefined || Number(fg.Price) < 0) {
        return res.status(400).json({ error: `Invalid price for fuel grade ${fuelGradeId}` });
      }
    }

    const result = await ptsPollingService.setFuelGradesPrices(fuel_grades);

    // Log the price change to DB for audit trail
    try {
      for (const fg of fuel_grades) {
        const fuelGradeId = Number(fg.Id ?? fg.FuelGradeId);
        await db.query(
          `INSERT INTO price_change_log (fuel_grade_id, fuel_grade_name, new_price, changed_by, change_type, created_at)
           VALUES ($1, $2, $3, $4, 'immediate', now())`,
          [fuelGradeId, fg.Name || null, fg.Price, req.user?.name || 'system']
        );
      }
    } catch (logErr) {
      // Don't fail the request if logging fails (table may not exist yet)
      logger.warn('Could not log price change:', logErr.message);
    }

    res.json({
      success: true,
      message: `${fuel_grades.length} fuel grade price(s) updated immediately`,
      data: result,
    });
  } catch (error) {
    logger.error('Error setting fuel grades prices', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ═══════════════════════════════════════════════
//  PRICE SCHEDULER
// ═══════════════════════════════════════════════

/**
 * @swagger
 * /api/fuel-grades/schedules:
 *   get:
 *     tags: [Fuel Prices]
 *     summary: Get price scheduler configuration from PTS-2
 *     description: |
 *       Returns the current price scheduler configuration.
 *       PTS-2 supports up to 10 schedule slots.
 *       Each schedule can be one-time or recurring (day-of-week flags).
 *     responses:
 *       200:
 *         description: Price scheduler configuration
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean }
 *                 schedules:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       Id: { type: integer, description: "Schedule slot (1-10)" }
 *                       Enabled: { type: boolean }
 *                       FuelGradeId: { type: integer }
 *                       Price: { type: number }
 *                       DateTime: { type: string, format: date-time }
 *                       EveryMonday: { type: boolean }
 *                       EveryTuesday: { type: boolean }
 *                       EveryWednesday: { type: boolean }
 *                       EveryThursday: { type: boolean }
 *                       EveryFriday: { type: boolean }
 *                       EverySaturday: { type: boolean }
 *                       EverySunday: { type: boolean }
 */
router.get('/schedules', async (req, res) => {
  try {
    const data = await ptsPollingService.getPricesSchedulerConfiguration();

    const schedules = data.PriceSchedules || data;

    res.json({
      success: true,
      timestamp: new Date().toISOString(),
      max_slots: 10,
      used_slots: Array.isArray(schedules) ? schedules.filter(s => s.Enabled).length : 0,
      schedules,
    });
  } catch (error) {
    // PTS offline → return empty schedule so the screen still loads
    if (error.message === 'PTS service not running' || error.message === 'PTS not connected') {
      logger.warn('PTS offline – returning empty price schedules');
      return res.json({
        success: true,
        timestamp: new Date().toISOString(),
        max_slots: 10,
        used_slots: 0,
        schedules: [],
        pts_offline: true,
      });
    }
    logger.error('Error getting price scheduler', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * @swagger
 * /api/fuel-grades/schedules:
 *   put:
 *     tags: [Fuel Prices]
 *     summary: Set price scheduler configuration on PTS-2
 *     description: |
 *       Pushes price schedule entries to the PTS-2 controller.
 *       The controller will automatically apply prices at the scheduled times,
 *       even if the server is offline.
 * 
 *       - **One-time**: Set DateTime, no day flags → price changes once
 *       - **Recurring**: Set day flags (EveryMonday, etc.) → repeats weekly at the time in DateTime
 *       - **Max 10 slots** total across all fuel grades
 *       - Slots not included in the request are cleared (zeroed)
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [schedules]
 *             properties:
 *               schedules:
 *                 type: array
 *                 maxItems: 10
 *                 items:
 *                   type: object
 *                   required: [Id, Enabled, FuelGradeId, Price, DateTime]
 *                   properties:
 *                     Id: { type: integer, minimum: 1, maximum: 10 }
 *                     Enabled: { type: boolean }
 *                     FuelGradeId: { type: integer, minimum: 1, maximum: 10 }
 *                     Price: { type: number }
 *                     DateTime: { type: string, description: "YYYY-MM-DDThh:mm:ss" }
 *                     EveryMonday: { type: boolean, default: false }
 *                     EveryTuesday: { type: boolean, default: false }
 *                     EveryWednesday: { type: boolean, default: false }
 *                     EveryThursday: { type: boolean, default: false }
 *                     EveryFriday: { type: boolean, default: false }
 *                     EverySaturday: { type: boolean, default: false }
 *                     EverySunday: { type: boolean, default: false }
 *           example:
 *             schedules:
 *               - Id: 1
 *                 Enabled: true
 *                 FuelGradeId: 1
 *                 Price: 28.00
 *                 DateTime: "2026-03-06T06:00:00"
 *               - Id: 2
 *                 Enabled: true
 *                 FuelGradeId: 2
 *                 Price: 24.50
 *                 DateTime: "2026-03-06T06:00:00"
 *                 EveryMonday: true
 *                 EveryTuesday: true
 *                 EveryWednesday: true
 *                 EveryThursday: true
 *                 EveryFriday: true
 *                 EverySaturday: false
 *                 EverySunday: false
 *     responses:
 *       200:
 *         description: Schedules pushed to PTS-2
 */
router.put('/schedules', offlineAuthMiddleware, requireRole('admin', 'manager'), async (req, res) => {
  try {
    const { schedules } = req.body;

    if (!schedules || !Array.isArray(schedules)) {
      return res.status(400).json({ error: 'schedules array is required' });
    }

    if (schedules.length > 10) {
      return res.status(400).json({ error: 'Maximum 10 schedule slots allowed' });
    }

    // Validate each schedule entry
    for (const s of schedules) {
      if (!s.Id || s.Id < 1 || s.Id > 10) {
        return res.status(400).json({ error: `Invalid schedule Id: ${s.Id}. Must be 1-10.` });
      }
      if (s.Enabled === undefined) {
        return res.status(400).json({ error: `Enabled flag required for schedule ${s.Id}` });
      }
      if (s.Enabled) {
        if (!s.FuelGradeId || s.FuelGradeId < 1 || s.FuelGradeId > 20) {
          return res.status(400).json({ error: `Invalid FuelGradeId for schedule ${s.Id}` });
        }
        if (s.Price === undefined || s.Price < 0) {
          return res.status(400).json({ error: `Invalid Price for schedule ${s.Id}` });
        }
        if (!s.DateTime || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(s.DateTime)) {
          return res.status(400).json({
            error: `Invalid DateTime for schedule ${s.Id}. Format: YYYY-MM-DDThh:mm:ss`
          });
        }
      }
    }

    // Ensure boolean defaults for day-of-week fields
    const sanitized = schedules.map(s => ({
      Id: s.Id,
      Enabled: s.Enabled,
      FuelGradeId: s.FuelGradeId || 0,
      Price: s.Price || 0,
      DateTime: s.DateTime || '2000-01-01T00:00:00',
      EveryMonday: s.EveryMonday || false,
      EveryTuesday: s.EveryTuesday || false,
      EveryWednesday: s.EveryWednesday || false,
      EveryThursday: s.EveryThursday || false,
      EveryFriday: s.EveryFriday || false,
      EverySaturday: s.EverySaturday || false,
      EverySunday: s.EverySunday || false,
    }));

    const result = await ptsPollingService.setPricesSchedulerConfiguration(sanitized);

    // Log to DB for audit
    try {
      for (const s of sanitized.filter(s => s.Enabled)) {
        const isRecurring = s.EveryMonday || s.EveryTuesday || s.EveryWednesday ||
          s.EveryThursday || s.EveryFriday || s.EverySaturday || s.EverySunday;
        await db.query(
          `INSERT INTO price_change_log (fuel_grade_id, new_price, changed_by, change_type, scheduled_at, created_at)
           VALUES ($1, $2, $3, $4, $5, now())`,
          [s.FuelGradeId, s.Price, req.user?.name || 'system', isRecurring ? 'recurring' : 'scheduled', s.DateTime]
        );
      }
    } catch (logErr) {
      logger.warn('Could not log schedule change:', logErr.message);
    }

    res.json({
      success: true,
      message: `${sanitized.length} schedule(s) pushed to PTS-2`,
      enabled_count: sanitized.filter(s => s.Enabled).length,
      data: result,
    });
  } catch (error) {
    logger.error('Error setting price scheduler', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ═══════════════════════════════════════════════
//  PER-PUMP PRICES
// ═══════════════════════════════════════════════

/**
 * @swagger
 * /api/fuel-grades/pump/{pumpNumber}/prices:
 *   get:
 *     tags: [Fuel Prices]
 *     summary: Get prices for a specific pump
 *     parameters:
 *       - in: path
 *         name: pumpNumber
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200:
 *         description: Pump prices
 */
router.get('/pump/:pumpNumber/prices', async (req, res) => {
  try {
    const pumpNumber = parseInt(req.params.pumpNumber);
    const data = await ptsPollingService.getPumpPrices(pumpNumber);

    res.json({
      success: true,
      pump: pumpNumber,
      timestamp: new Date().toISOString(),
      prices: data.Prices || data,
    });
  } catch (error) {
    logger.error(`Error getting pump ${req.params.pumpNumber} prices`, error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * @swagger
 * /api/fuel-grades/pump/{pumpNumber}/prices:
 *   put:
 *     tags: [Fuel Prices]
 *     summary: Set prices for a specific pump
 *     description: Override prices for a single pump (does not affect other pumps).
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: pumpNumber
 *         required: true
 *         schema: { type: integer }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [prices]
 *             properties:
 *               prices:
 *                 type: array
 *                 items:
 *                   type: object
 *                   properties:
 *                     Id: { type: integer }
 *                     Price: { type: number }
 *           example:
 *             prices:
 *               - Id: 1
 *                 Price: 27.50
 *               - Id: 2
 *                 Price: 23.99
 *     responses:
 *       200:
 *         description: Pump prices updated
 */
router.put('/pump/:pumpNumber/prices', offlineAuthMiddleware, requireRole('admin', 'manager'), async (req, res) => {
  try {
    const pumpNumber = parseInt(req.params.pumpNumber);
    const { prices } = req.body;

    if (!prices || !Array.isArray(prices) || prices.length === 0) {
      return res.status(400).json({ error: 'prices array is required' });
    }

    const result = await ptsPollingService.setPumpPrices(pumpNumber, prices);

    res.json({
      success: true,
      pump: pumpNumber,
      message: `Prices updated for pump ${pumpNumber}`,
      data: result,
    });
  } catch (error) {
    logger.error(`Error setting pump ${req.params.pumpNumber} prices`, error);
    res.status(500).json({ success: false, error: error.message });
  }
});

// ═══════════════════════════════════════════════
//  PRICE CHANGE LOG (audit history)
// ═══════════════════════════════════════════════

/**
 * @swagger
 * /api/fuel-grades/price-log:
 *   get:
 *     tags: [Fuel Prices]
 *     summary: Get price change history
 *     description: Returns audit log of all price changes (immediate + scheduled)
 *     parameters:
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 50 }
 *       - in: query
 *         name: fuel_grade_id
 *         schema: { type: integer }
 *     responses:
 *       200:
 *         description: Price change log
 */
router.get('/price-log', async (req, res) => {
  try {
    const { limit = 50, fuel_grade_id } = req.query;

    let query = `SELECT * FROM price_change_log WHERE 1=1`;
    const params = [];
    let p = 0;

    if (fuel_grade_id) {
      query += ` AND fuel_grade_id = $${++p}`;
      params.push(parseInt(fuel_grade_id));
    }

    query += ` ORDER BY created_at DESC LIMIT $${++p}`;
    params.push(parseInt(limit));

    const result = await db.query(query, params);

    res.json({
      success: true,
      count: result.rows.length,
      log: result.rows,
    });
  } catch (error) {
    // If table doesn't exist yet, return empty
    if (error.message.includes('does not exist')) {
      return res.json({ success: true, count: 0, log: [], note: 'Price log table not yet created' });
    }
    logger.error('Error getting price log', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
