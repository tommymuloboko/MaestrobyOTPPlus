/**
 * Debtor Vehicles & Drivers Routes
 * CRUD endpoints for vehicles linked to debtors and their drivers
 */
const express = require('express');
const logger = require('../utils/logger')('VehiclesDriversRoutes');
const db = require('../utils/db');
const { offlineAuthMiddleware, requireRole } = require('../middleware/offline-auth');

const router = express.Router();

// ═══════════════════════════════════════════════
//  DEBTOR VEHICLES
// ═══════════════════════════════════════════════

/**
 * @swagger
 * tags:
 *   - name: Vehicles
 *     description: Debtor vehicle management
 *   - name: Drivers
 *     description: Driver management (linked to vehicles)
 */

// ── LIST vehicles (optionally filter by debtor_id) ──
router.get('/vehicles', async (req, res) => {
  try {
    const { debtor_id, is_active } = req.query;
    let query = `
      SELECT v.*, d.customer_name as debtor_name, d.account_no as debtor_account
      FROM debtor_vehicles v
      LEFT JOIN debtors d ON v.debtor_id = d.id
      WHERE 1=1`;
    const params = [];
    let p = 0;

    if (debtor_id) { query += ` AND v.debtor_id = $${++p}`; params.push(debtor_id); }
    if (is_active !== undefined) { query += ` AND v.is_active = $${++p}`; params.push(is_active === 'true'); }

    query += ` ORDER BY v.created_at DESC`;
    const result = await db.query(query, params);

    res.json({ success: true, count: result.rows.length, vehicles: result.rows });
  } catch (error) {
    logger.error('Error fetching vehicles', error);
    res.status(500).json({ error: error.message });
  }
});

// ── GET single vehicle with its drivers ──
router.get('/vehicles/:id', async (req, res) => {
  try {
    const vehicle = await db.query(
      `SELECT v.*, d.customer_name as debtor_name, d.account_no as debtor_account
       FROM debtor_vehicles v
       LEFT JOIN debtors d ON v.debtor_id = d.id
       WHERE v.id = $1`, [req.params.id]
    );
    if (vehicle.rows.length === 0) return res.status(404).json({ error: 'Vehicle not found' });

    const drivers = await db.query(
      `SELECT * FROM drivers WHERE vehicle_id = $1 ORDER BY full_name`, [req.params.id]
    );

    res.json({ success: true, vehicle: vehicle.rows[0], drivers: drivers.rows });
  } catch (error) {
    logger.error('Error fetching vehicle', error);
    res.status(500).json({ error: error.message });
  }
});

// ── CREATE vehicle ──
router.post('/vehicles', offlineAuthMiddleware, async (req, res) => {
  try {
    const { debtor_id, account_id, number_plate, mileage, tank_capacity, fuel_type, is_active } = req.body;

    if (!debtor_id || !number_plate) {
      return res.status(400).json({ error: 'debtor_id and number_plate are required' });
    }

    const result = await db.query(
      `INSERT INTO debtor_vehicles (debtor_id, account_id, number_plate, mileage, tank_capacity, fuel_type, is_active)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [debtor_id, account_id || null, number_plate, mileage || 0, tank_capacity || null, fuel_type || 'Diesel', is_active !== false]
    );

    logger.info(`✅ Vehicle created: ${result.rows[0].id} (${number_plate})`);
    res.status(201).json({ success: true, vehicle: result.rows[0] });
  } catch (error) {
    logger.error('Error creating vehicle', error);
    res.status(500).json({ error: error.message });
  }
});

// ── UPDATE vehicle ──
router.put('/vehicles/:id', offlineAuthMiddleware, async (req, res) => {
  try {
    const { debtor_id, account_id, number_plate, mileage, tank_capacity, fuel_type, is_active } = req.body;

    const result = await db.query(
      `UPDATE debtor_vehicles
       SET debtor_id = COALESCE($1, debtor_id),
           account_id = COALESCE($2, account_id),
           number_plate = COALESCE($3, number_plate),
           mileage = COALESCE($4, mileage),
           tank_capacity = COALESCE($5, tank_capacity),
           fuel_type = COALESCE($6, fuel_type),
           is_active = COALESCE($7, is_active),
           updated_at = now()
       WHERE id = $8
       RETURNING *`,
      [debtor_id, account_id, number_plate, mileage, tank_capacity, fuel_type, is_active, req.params.id]
    );

    if (result.rows.length === 0) return res.status(404).json({ error: 'Vehicle not found' });

    logger.info(`✅ Vehicle updated: ${req.params.id}`);
    res.json({ success: true, vehicle: result.rows[0] });
  } catch (error) {
    logger.error('Error updating vehicle', error);
    res.status(500).json({ error: error.message });
  }
});

// ── DELETE vehicle ──
router.delete('/vehicles/:id', offlineAuthMiddleware, requireRole('admin', 'manager'), async (req, res) => {
  try {
    const result = await db.query('DELETE FROM debtor_vehicles WHERE id = $1 RETURNING id', [req.params.id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Vehicle not found' });

    logger.info(`✅ Vehicle deleted: ${req.params.id}`);
    res.json({ success: true, message: 'Vehicle deleted' });
  } catch (error) {
    logger.error('Error deleting vehicle', error);
    res.status(500).json({ error: error.message });
  }
});

// ═══════════════════════════════════════════════
//  DRIVERS
// ═══════════════════════════════════════════════

// ── LIST drivers (optionally filter by vehicle_id) ──
router.get('/drivers', async (req, res) => {
  try {
    const { vehicle_id, is_active } = req.query;
    let query = `
      SELECT dr.*, v.number_plate, v.fuel_type,
             d.customer_name as debtor_name
      FROM drivers dr
      LEFT JOIN debtor_vehicles v ON dr.vehicle_id = v.id
      LEFT JOIN debtors d ON v.debtor_id = d.id
      WHERE 1=1`;
    const params = [];
    let p = 0;

    if (vehicle_id) { query += ` AND dr.vehicle_id = $${++p}`; params.push(vehicle_id); }
    if (is_active !== undefined) { query += ` AND dr.is_active = $${++p}`; params.push(is_active === 'true'); }

    query += ` ORDER BY dr.full_name`;
    const result = await db.query(query, params);

    res.json({ success: true, count: result.rows.length, drivers: result.rows });
  } catch (error) {
    logger.error('Error fetching drivers', error);
    res.status(500).json({ error: error.message });
  }
});

// ── GET single driver ──
router.get('/drivers/:id', async (req, res) => {
  try {
    const result = await db.query(
      `SELECT dr.*, v.number_plate, v.fuel_type, v.debtor_id,
              d.customer_name as debtor_name
       FROM drivers dr
       LEFT JOIN debtor_vehicles v ON dr.vehicle_id = v.id
       LEFT JOIN debtors d ON v.debtor_id = d.id
       WHERE dr.id = $1`, [req.params.id]
    );
    if (result.rows.length === 0) return res.status(404).json({ error: 'Driver not found' });

    res.json({ success: true, driver: result.rows[0] });
  } catch (error) {
    logger.error('Error fetching driver', error);
    res.status(500).json({ error: error.message });
  }
});

// ── CREATE driver ──
router.post('/drivers', offlineAuthMiddleware, async (req, res) => {
  try {
    const { vehicle_id, full_name, nrc, nationality, phone, email, is_active } = req.body;

    if (!full_name) {
      return res.status(400).json({ error: 'full_name is required' });
    }

    const result = await db.query(
      `INSERT INTO drivers (vehicle_id, full_name, nrc, nationality, phone, email, is_active)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [vehicle_id || null, full_name, nrc || null, nationality || 'Zambian', phone || null, email || null, is_active !== false]
    );

    logger.info(`✅ Driver created: ${result.rows[0].id} (${full_name})`);
    res.status(201).json({ success: true, driver: result.rows[0] });
  } catch (error) {
    logger.error('Error creating driver', error);
    res.status(500).json({ error: error.message });
  }
});

// ── UPDATE driver ──
router.put('/drivers/:id', offlineAuthMiddleware, async (req, res) => {
  try {
    const { vehicle_id, full_name, nrc, nationality, phone, email, is_active } = req.body;

    const result = await db.query(
      `UPDATE drivers
       SET vehicle_id = COALESCE($1, vehicle_id),
           full_name = COALESCE($2, full_name),
           nrc = COALESCE($3, nrc),
           nationality = COALESCE($4, nationality),
           phone = COALESCE($5, phone),
           email = COALESCE($6, email),
           is_active = COALESCE($7, is_active),
           updated_at = now()
       WHERE id = $8
       RETURNING *`,
      [vehicle_id, full_name, nrc, nationality, phone, email, is_active, req.params.id]
    );

    if (result.rows.length === 0) return res.status(404).json({ error: 'Driver not found' });

    logger.info(`✅ Driver updated: ${req.params.id}`);
    res.json({ success: true, driver: result.rows[0] });
  } catch (error) {
    logger.error('Error updating driver', error);
    res.status(500).json({ error: error.message });
  }
});

// ── DELETE driver ──
router.delete('/drivers/:id', offlineAuthMiddleware, requireRole('admin', 'manager'), async (req, res) => {
  try {
    const result = await db.query('DELETE FROM drivers WHERE id = $1 RETURNING id', [req.params.id]);
    if (result.rows.length === 0) return res.status(404).json({ error: 'Driver not found' });

    logger.info(`✅ Driver deleted: ${req.params.id}`);
    res.json({ success: true, message: 'Driver deleted' });
  } catch (error) {
    logger.error('Error deleting driver', error);
    res.status(500).json({ error: error.message });
  }
});

module.exports = router;
