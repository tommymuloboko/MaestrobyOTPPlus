/**
 * Sync Routes
 * API endpoints for managing local↔Supabase synchronization
 */

const express = require('express');
const router = express.Router();
const syncService = require('../services/sync.service');
const dualDb = require('../utils/dual-db');
const logger = require('../utils/logger')('SyncRoutes');

/**
 * @swagger
 * /api/sync/station-config:
 *   get:
 *     summary: Get station configuration for this server instance
 *     tags: [Sync]
 *     responses:
 *       200:
 *         description: Station configuration
 */
router.get('/station-config', (req, res) => {
  try {
    const config = syncService.getStationConfig();
    res.json({
      success: true,
      data: {
        ...config,
        message: config.isConfigured 
          ? `Server configured for station ${config.stationId}` 
          : 'Station not configured. Set OFFLINE_COMPANY_ID and OFFLINE_STATION_ID in .env'
      },
    });
  } catch (error) {
    logger.error('Failed to get station config:', error);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * @swagger
 * /api/sync/status:
 *   get:
 *     summary: Get sync and database status
 *     tags: [Sync]
 *     responses:
 *       200:
 *         description: Sync status
 */
router.get('/status', async (req, res) => {
  try {
    const dbStatus = dualDb.getStatus();
    const queueStatus = await dualDb.getSyncQueueStatus();
    const syncStats = syncService.getStats();
    const stationConfig = syncService.getStationConfig();

    res.json({
      success: true,
      data: {
        station: stationConfig,
        database: dbStatus,
        queue: queueStatus,
        sync: syncStats,
      },
    });
  } catch (error) {
    logger.error('Failed to get sync status:', error);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * @swagger
 * /api/sync/force:
 *   post:
 *     summary: Force immediate sync to Supabase
 *     tags: [Sync]
 *     responses:
 *       200:
 *         description: Sync results
 */
router.post('/force', async (req, res) => {
  try {
    const result = await syncService.forceSync();
    res.json({
      success: true,
      data: result,
    });
  } catch (error) {
    logger.error('Force sync failed:', error);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * @swagger
 * /api/sync/pull-station:
 *   post:
 *     summary: Pull reference data for a station from Supabase (uses configured station if no body)
 *     tags: [Sync]
 *     requestBody:
 *       required: false
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               company_id:
 *                 type: string
 *                 format: uuid
 *                 description: Optional - uses OFFLINE_COMPANY_ID from config if not provided
 *               station_id:
 *                 type: string
 *                 format: uuid
 *                 description: Optional - uses OFFLINE_STATION_ID from config if not provided
 *     responses:
 *       200:
 *         description: Pull results
 */
router.post('/pull-station', async (req, res) => {
  try {
    const stationConfig = syncService.getStationConfig();
    
    // Use request body or fall back to configured values
    const company_id = req.body.company_id || stationConfig.companyId;
    const station_id = req.body.station_id || stationConfig.stationId;

    if (!company_id || !station_id) {
      return res.status(400).json({
        success: false,
        error: 'company_id and station_id are required',
      });
    }

    const result = await syncService.pullStationData(company_id, station_id);
    res.json({
      success: true,
      data: result,
    });
  } catch (error) {
    logger.error('Pull station data failed:', error);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * @swagger
 * /api/sync/pull-table:
 *   post:
 *     summary: Pull specific table data from Supabase
 *     tags: [Sync]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - table_name
 *             properties:
 *               table_name:
 *                 type: string
 *               filters:
 *                 type: object
 *     responses:
 *       200:
 *         description: Pull results
 */
router.post('/pull-table', async (req, res) => {
  try {
    const { table_name, filters = {} } = req.body;

    if (!table_name) {
      return res.status(400).json({
        success: false,
        error: 'table_name is required',
      });
    }

    // Validate table name (prevent SQL injection)
    const allowedTables = dualDb.REFERENCE_TABLES;
    if (!allowedTables.includes(table_name)) {
      return res.status(400).json({
        success: false,
        error: `Table '${table_name}' is not allowed for pull. Allowed: ${allowedTables.join(', ')}`,
      });
    }

    const count = await syncService.pullReferenceData(table_name, filters);
    res.json({
      success: true,
      data: {
        table: table_name,
        records_pulled: count,
      },
    });
  } catch (error) {
    logger.error('Pull table failed:', error);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * @swagger
 * /api/sync/queue:
 *   get:
 *     summary: Get sync queue details
 *     tags: [Sync]
 *     parameters:
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           default: 50
 *       - in: query
 *         name: status
 *         schema:
 *           type: string
 *           enum: [pending, synced, failed]
 *     responses:
 *       200:
 *         description: Queue items
 */
router.get('/queue', async (req, res) => {
  try {
    const { limit = 50, status = 'pending' } = req.query;

    let whereClause = '';
    switch (status) {
      case 'pending':
        whereClause = 'WHERE is_synced = FALSE AND sync_attempts < 5';
        break;
      case 'synced':
        whereClause = 'WHERE is_synced = TRUE';
        break;
      case 'failed':
        whereClause = 'WHERE is_synced = FALSE AND sync_attempts >= 5';
        break;
    }

    const result = await dualDb.local.query(`
      SELECT id, table_name, record_id, operation, created_at, 
             sync_attempts, last_error, is_synced, synced_at
      FROM sync_queue
      ${whereClause}
      ORDER BY created_at DESC
      LIMIT $1
    `, [parseInt(limit)]);

    res.json({
      success: true,
      data: {
        status,
        count: result.rows.length,
        items: result.rows,
      },
    });
  } catch (error) {
    logger.error('Failed to get queue:', error);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * @swagger
 * /api/sync/retry-failed:
 *   post:
 *     summary: Reset failed items for retry
 *     tags: [Sync]
 *     responses:
 *       200:
 *         description: Number of items reset
 */
router.post('/retry-failed', async (req, res) => {
  try {
    const count = await syncService.retryFailed();
    res.json({
      success: true,
      data: {
        items_reset: count,
      },
    });
  } catch (error) {
    logger.error('Retry failed:', error);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * @swagger
 * /api/sync/cleanup:
 *   post:
 *     summary: Clean up old synced items
 *     tags: [Sync]
 *     requestBody:
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               days:
 *                 type: integer
 *                 default: 7
 *     responses:
 *       200:
 *         description: Number of items cleaned up
 */
router.post('/cleanup', async (req, res) => {
  try {
    const { days = 7 } = req.body;
    const count = await syncService.cleanupSynced(days);
    res.json({
      success: true,
      data: {
        items_cleaned: count,
        older_than_days: days,
      },
    });
  } catch (error) {
    logger.error('Cleanup failed:', error);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * @swagger
 * /api/sync/table-status:
 *   get:
 *     summary: Get sync status for specific tables
 *     description: Check how many records are pending sync to Supabase for each table
 *     tags: [Sync]
 *     parameters:
 *       - in: query
 *         name: table
 *         schema:
 *           type: string
 *         description: Filter by table name (e.g., pts_sales, fuel_transactions_raw)
 *     responses:
 *       200:
 *         description: Table sync status
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 data:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       table_name:
 *                         type: string
 *                       total_records:
 *                         type: integer
 *                       synced_records:
 *                         type: integer
 *                       pending_records:
 *                         type: integer
 *                       sync_percentage:
 *                         type: number
 *                       last_synced:
 *                         type: string
 *                         format: date-time
 *                       failed_syncs:
 *                         type: integer
 */
router.get('/table-status', async (req, res) => {
  try {
    const { table } = req.query;
    const dbStatus = dualDb.getStatus();
    
    // If local DB is not available, return empty status
    if (!dbStatus.local) {
      return res.json({
        success: true,
        data: [],
        summary: {
          total_pending: 0,
          total_synced: 0,
          overall_sync_percentage: 0,
          message: 'Local database not available - check connection'
        }
      });
    }
    
    let query = `
      SELECT 
        table_name,
        COUNT(*) as total_records,
        SUM(CASE WHEN is_synced = true THEN 1 ELSE 0 END) as synced_records,
        SUM(CASE WHEN is_synced = false THEN 1 ELSE 0 END) as pending_records,
        ROUND(100.0 * SUM(CASE WHEN is_synced = true THEN 1 ELSE 0 END) / COUNT(*), 2) as sync_percentage,
        MAX(synced_at) as last_synced,
        SUM(CASE WHEN sync_attempts > 0 AND is_synced = false THEN 1 ELSE 0 END) as failed_syncs
      FROM sync_queue
    `;

    const params = [];
    
    if (table) {
      query += ' WHERE table_name = $1';
      params.push(table);
    }

    query += ' GROUP BY table_name ORDER BY table_name';

    const result = await dualDb.query(query, params, { forceLocal: true });

    res.json({
      success: true,
      data: result.rows,
      summary: {
        total_pending: result.rows.reduce((sum, row) => sum + (row.pending_records || 0), 0),
        total_synced: result.rows.reduce((sum, row) => sum + (row.synced_records || 0), 0),
        overall_sync_percentage: Math.round(
          100 * result.rows.reduce((sum, row) => sum + (row.synced_records || 0), 0) / 
          result.rows.reduce((sum, row) => sum + (row.total_records || 1), 0)
        ) || 0
      }
    });
  } catch (error) {
    logger.error('Failed to get table sync status:', error);
    
    // Return empty data if local DB not available
    if (error.message.includes('Local database')) {
      return res.json({
        success: true,
        data: [],
        summary: {
          total_pending: 0,
          total_synced: 0,
          overall_sync_percentage: 0,
          message: 'Local database not available'
        }
      });
    }
    
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * @swagger
 * /api/sync/pts-sales-status:
 *   get:
 *     summary: Get PTS Sales sync status
 *     description: Check how many PTS sales records are pending sync to Supabase
 *     tags: [Sync]
 *     responses:
 *       200:
 *         description: PTS Sales sync status
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 total_local_records:
 *                   type: integer
 *                   description: Total records in local pts_sales table
 *                 synced_to_supabase:
 *                   type: integer
 *                   description: Records marked as synced in sync_queue
 *                 pending_sync:
 *                   type: integer
 *                   description: Records pending sync to Supabase
 *                 sync_percentage:
 *                   type: number
 *                   description: Percentage of records synced
 *                 last_synced:
 *                   type: string
 *                   format: date-time
 *                   description: Timestamp of last successful sync
 *                 failed_attempts:
 *                   type: integer
 *                   description: Number of failed sync attempts
 */
router.get('/pts-sales-status', async (req, res) => {
  try {
    const dbStatus = dualDb.getStatus();
    
    // If local DB is not available, return offline status
    if (!dbStatus.local) {
      return res.json({
        success: true,
        data: {
          total_local_records: 0,
          synced_to_supabase: 0,
          pending_sync: 0,
          sync_percentage: 0,
          last_synced: null,
          failed_attempts: 0,
          status: 'offline',
          message: 'Local database not available - running in offline mode or cloud mode'
        }
      });
    }

    // Get PTS sales sync status from sync_queue
    const queueStatus = await dualDb.query(
      `SELECT 
        COUNT(*) as total_records,
        SUM(CASE WHEN is_synced = true THEN 1 ELSE 0 END) as synced_records,
        SUM(CASE WHEN is_synced = false THEN 1 ELSE 0 END) as pending_records,
        ROUND(100.0 * SUM(CASE WHEN is_synced = true THEN 1 ELSE 0 END) / COUNT(*), 2) as sync_percentage,
        MAX(synced_at) as last_synced,
        SUM(CASE WHEN sync_attempts > 0 AND is_synced = false THEN 1 ELSE 0 END) as failed_syncs
      FROM sync_queue
      WHERE table_name = 'pts_sales'`,
      [],
      { forceLocal: true }
    );

    const queueData = queueStatus.rows[0] || {
      total_records: 0,
      synced_records: 0,
      pending_records: 0,
      sync_percentage: 0,
      last_synced: null,
      failed_syncs: 0
    };

    // Get total records in pts_sales table
    const localCount = await dualDb.query(
      'SELECT COUNT(*) as total FROM pts_sales',
      [],
      { forceLocal: true }
    );

    const totalLocal = parseInt(localCount.rows[0]?.total || 0);

    res.json({
      success: true,
      data: {
        total_local_records: totalLocal,
        synced_to_supabase: parseInt(queueData.synced_records || 0),
        pending_sync: parseInt(queueData.pending_records || 0),
        sync_percentage: parseFloat(queueData.sync_percentage || 0),
        last_synced: queueData.last_synced,
        failed_attempts: parseInt(queueData.failed_syncs || 0)
      }
    });
  } catch (error) {
    logger.error('Failed to get PTS sales sync status:', error);
    
    // Return partial data if possible (Supabase only)
    if (error.message.includes('Local database')) {
      return res.json({
        success: true,
        data: {
          total_local_records: 0,
          synced_to_supabase: 0,
          pending_sync: 0,
          sync_percentage: 0,
          last_synced: null,
          failed_attempts: 0,
          status: 'offline',
          message: 'Local database not available - check database connection'
        }
      });
    }
    
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * @swagger
 *   post:
 *     summary: Start the sync service
 *     tags: [Sync]
 *     responses:
 *       200:
 *         description: Service started
 */
router.post('/start', (req, res) => {
  syncService.start();
  res.json({
    success: true,
    message: 'Sync service started',
  });
});

/**
 * @swagger
 * /api/sync/stop:
 *   post:
 *     summary: Stop the sync service
 *     tags: [Sync]
 *     responses:
 *       200:
 *         description: Service stopped
 */
router.post('/stop', (req, res) => {
  syncService.stop();
  res.json({
    success: true,
    message: 'Sync service stopped',
  });
});

module.exports = router;
