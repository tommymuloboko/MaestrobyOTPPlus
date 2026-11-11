#!/usr/bin/env node

console.log('[STARTUP] Loading modules...');

require('dotenv').config();

// ============================================================
// GLOBAL ERROR HANDLERS - Prevent server crashes
// ============================================================

// Catch uncaught exceptions (synchronous errors that weren't caught)
process.on('uncaughtException', (error) => {
  console.error('[FATAL] Uncaught Exception:', error.message);
  console.error(error.stack);
  // Log but DON'T exit - keep server running
  // PM2 will restart if truly unrecoverable
});

// Catch unhandled promise rejections (async errors that weren't caught)
process.on('unhandledRejection', (reason, promise) => {
  console.error('[ERROR] Unhandled Promise Rejection:', reason);
  // Log but DON'T exit - keep server running
});

// Graceful shutdown signals
process.on('SIGTERM', () => {
  console.log('[SHUTDOWN] SIGTERM received, shutting down gracefully...');
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('[SHUTDOWN] SIGINT received, shutting down gracefully...');
  process.exit(0);
});

// PM2 ready signal
if (process.send) {
  process.send('ready');
}

console.log('[STARTUP] Global error handlers installed');

const express = require('express');
console.log('[STARTUP] Express loaded');
const swaggerJsdoc = require('swagger-jsdoc');
const swaggerUi = require('swagger-ui-express');
console.log('[STARTUP] Swagger loaded');
const logger = require('./utils/logger')('Server');
const database = require('./utils/database');
console.log('[STARTUP] Database loaded');
const syncService = require('./services/sync.service');
console.log('[STARTUP] SyncService loaded');

// Deployment mode - skip local-only services in cloud mode
const DEPLOYMENT_MODE = database.DEPLOYMENT_MODE;
const isCloudMode = database.isCloudMode;

let offlineSyncService = null;
let ptsPollingService = null;
let ptsSalesPollingService = null;
let pumpReportPollingService = null;
let rfidReaderService = null;

if (!isCloudMode) {
  offlineSyncService = require('./services/offline-sync.service');
  console.log('[STARTUP] OfflineSyncService loaded');
  ptsPollingService = require('./services/pts-polling.service');
  console.log('[STARTUP] PtsPollingService loaded');
  ptsSalesPollingService = require('./services/pts-sales-polling.service');
  console.log('[STARTUP] PtsSalesPollingService loaded');
  pumpReportPollingService = require('./services/pump-report-polling.service');
  console.log('[STARTUP] PumpReportPollingService loaded');
  rfidReaderService = require('./services/rfid-reader.service');
  console.log('[STARTUP] RfidReaderService loaded');
} else {
  console.log('[STARTUP] Cloud mode - skipping local services (offline-sync, PTS, RFID)');
}

const { authMiddleware } = require('./middleware/auth');
console.log('[STARTUP] Auth middleware loaded');

// Configuration
const PORT = process.env.PORT || 3000;
const PTS_POLLING_ENABLED = !isCloudMode && process.env.PTS_POLLING_ENABLED === 'true';
const RFID_ENABLED = !isCloudMode && process.env.RFID_ENABLED !== 'false';

// Swagger configuration
const RENDER_URL = process.env.RENDER_EXTERNAL_URL || process.env.REMOTE_SERVER_URL;
const swaggerServers = [
  { url: `http://localhost:${PORT}`, description: 'Local Development' }
];
if (RENDER_URL) {
  swaggerServers.unshift({ url: RENDER_URL, description: 'Remote Server (Render)' });
}

const swaggerOptions = {
  definition: {
    openapi: '3.0.0',
    info: {
      title: 'MAESTRO-LITE API',
      version: '1.0.0',
      description: 'Fuel Station Management API with offline-first architecture',
    },
    servers: swaggerServers,
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT'
        }
      }
    },
    security: [{ bearerAuth: [] }]
  },
  apis: ['./routes/*.js']
};

const swaggerSpec = swaggerJsdoc(swaggerOptions);

// Create Express app
const app = express();

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Request logging
app.use((req, res, next) => {
  logger.debug(`${req.method} ${req.path}`);
  next();
});

// CORS
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS, PATCH');

  if (req.method === 'OPTIONS') {
    return res.send(200);
  }

  next();
});

// Serve static files from public folder (for pump simulator)
const path = require('path');
app.use('/public', express.static(path.join(__dirname, 'public')));

// Serve dashboard files directly from public/strict/dominant
app.use('/strict/dominant', express.static(path.join(__dirname, 'public', 'strict', 'dominant')));

// Serve all other public files directly
app.use('/', express.static(path.join(__dirname, 'public')));

// Decoy root route - looks like nothing exists here
app.get('/', (req, res) => {
  res.status(404).send(`<!DOCTYPE html>
<html>
<head>
    <title>404 Not Found</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Arial, sans-serif;
            background: #f5f5f5;
            min-height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
            text-align: center;
            color: #333;
        }
        .container {
            padding: 40px;
        }
        h1 {
            font-size: 120px;
            font-weight: 700;
            color: #ccc;
            line-height: 1;
            margin-bottom: 20px;
        }
        h2 {
            font-size: 32px;
            font-weight: 400;
            margin-bottom: 15px;
        }
        p {
            font-size: 18px;
            color: #666;
        }
    </style>
</head>
<body>
    <div class="container">
        <h1>404</h1>
        <h2>Page Not Found</h2>
        <p>The page you are looking for doesn't exist or has been moved.</p>
    </div>
</body>
</html>`);
});

// Swagger UI
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec));

// Health check (no auth required)
app.get('/api/health', (req, res) => {
  const stationConfig = syncService.getStationConfig();
  const dbStatus = database.getStatus();
  res.json({
    status: 'ok',
    timestamp: new Date(),
    uptime: process.uptime(),
    deployment: {
      mode: DEPLOYMENT_MODE,
      isCloud: isCloudMode,
    },
    environment: {
      pts_polling: PTS_POLLING_ENABLED,
      rfid_enabled: RFID_ENABLED,
    },
    database: {
      mode: dbStatus.mode,
      local: dbStatus.local,
      remote: dbStatus.remote,
    },
    station: {
      configured: stationConfig.isConfigured,
      company_id: stationConfig.companyId,
      station_id: stationConfig.stationId,
    }
  });
});

// Status endpoint (no auth required)
app.get('/api/status', async (req, res) => {
  const dbStatus = database.getStatus();
  const pgSyncStats = syncService.getStats();

  const status = {
    timestamp: new Date(),
    deployment: {
      mode: DEPLOYMENT_MODE,
      isCloud: isCloudMode,
    },
    database: dbStatus,
    postgresSync: pgSyncStats,
  };

  // Only include offline sync status in local mode
  if (!isCloudMode && offlineSyncService) {
    status.sync = await offlineSyncService.getStatus();
  }

  res.json(status);
});

// Import route modules
const authRoutes = require('./routes/auth.routes');
const companiesRoutes = require('./routes/companies.routes');
const stationsRoutes = require('./routes/stations.routes');
const attendantsRoutes = require('./routes/attendants.routes');
const attendantShiftsRoutes = require('./routes/attendant-shifts.routes');
const shiftsRoutes = require('./routes/shifts.routes');
const debtorsRoutes = require('./routes/debtors.routes');
const debtorTransactionsRoutes = require('./routes/debtor-transactions.routes');
const pumpsRoutes = require('./routes/pumps.routes');
const tanksRoutes = require('./routes/tanks.routes');
const transactionsRoutes = require('./routes/transactions.routes');
const ptsRoutes = require('./routes/pts.routes');
const ptsSalesRoutes = require('./routes/pts-sales.routes');
const pumpReportsRoutes = require('./routes/pump-reports.routes');
const syncRoutes = require('./routes/sync.routes');
const vehiclesDriversRoutes = require('./routes/vehicles-drivers.routes');
const fuelPricesRoutes = require('./routes/fuel-prices.routes');
const dashboardRoutes = require('./routes/dashboard.routes');
const rfidRoutes = require('./routes/rfid.routes');
const reportsRoutes = require('./routes/reports.routes');
const rfidShiftsRoutes = require('./routes/rfid-shifts.routes');
const enrollmentRoutes = require('./routes/enrollment.routes');
const rolesRoutes = require('./routes/roles.routes');
const companyPortalRoutes = require('./routes/company-portal.routes');
const bankingRoutes = require('./routes/banking.routes');

// Auth routes (public - no middleware)
app.use('/api/auth', authRoutes);

// Pump simulator routes (public - for testing)
app.use('/api/pump-simulator', ptsRoutes);

// PTS real-time routes (public - for live dashboard)
app.use('/api/pts', ptsRoutes);
app.use('/api/pts', require('./routes/nozzle-totals.routes'));  // single-nozzle totaliser (additive, public)
app.use('/api/pts', require('./routes/tank-reports.routes'));   // tank measurement history / trend (additive, public)

// Authentication middleware (applies to all routes below)
app.use(authMiddleware);

// API routes (protected)
app.use('/api/companies', companiesRoutes);
app.use('/api/stations', stationsRoutes);
app.use('/api/attendants', attendantsRoutes);
app.use('/api/attendant-shifts', attendantShiftsRoutes);
app.use('/api/shifts', shiftsRoutes);
app.use('/api/debtors', debtorsRoutes);
app.use('/api/debtor-transactions', debtorTransactionsRoutes);
app.use('/api/pumps', pumpsRoutes);
app.use('/api/tanks', tanksRoutes);
app.use('/api/transactions', transactionsRoutes);
app.use('/api/pts-sales', ptsSalesRoutes);
app.use('/api/pump-reports', pumpReportsRoutes);
app.use('/api/fuel-grades', fuelPricesRoutes);
app.use('/api', vehiclesDriversRoutes);
app.use('/api/sync', syncRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/rfid', rfidRoutes);
app.use('/api/reports', reportsRoutes);
app.use('/api/rfid-shifts', rfidShiftsRoutes);
app.use('/api/enrollment', enrollmentRoutes);
app.use('/api/roles', rolesRoutes);
app.use('/api/company', companyPortalRoutes);
app.use('/api/banking', bankingRoutes);

// 404 handler
app.use((req, res) => {
  res.status(404).json({
    error: 'Not Found',
    path: req.path,
    method: req.method
  });
});

// Error handler
app.use((err, req, res, next) => {
  logger.error('Unhandled error', err);
  res.status(500).json({
    error: 'Internal Server Error',
    message: process.env.NODE_ENV === 'development' ? err.message : 'An error occurred'
  });
});

/**
 * Initialize all services
 */
async function initializeServices() {
  try {
    console.log('[INIT] Starting initializeServices...');
    logger.info('='.repeat(60));
    logger.info('🚀 Initializing MAESTRO-LITE Server');
    logger.info('='.repeat(60));
    logger.info(`🌐 Deployment Mode: ${DEPLOYMENT_MODE.toUpperCase()}`);

    if (isCloudMode) {
      logger.info(`📍 Architecture: CLOUD - Supabase only (no local hardware)`);
    } else {
      logger.info(`📍 Architecture: LOCAL - PostgreSQL (primary) + Supabase (sync)`);
      logger.info(`📍 PTS Polling: ${PTS_POLLING_ENABLED ? 'ENABLED' : 'DISABLED'}`);
      logger.info(`📍 RFID Reader: ${RFID_ENABLED ? 'ENABLED' : 'DISABLED'}`);
    }

    // 1. Initialize database connections
    console.log('[INIT] Step 1: Initializing database connections...');
    logger.info('🔌 Initializing database connections...');
    try {
      const dbStatus = await database.initialize();
      console.log('[INIT] Step 1: Done', dbStatus);

      if (isCloudMode) {
        logger.info(`   Supabase: ${dbStatus.remote ? '✅ Connected (PRIMARY)' : '❌ Not available'}`);
      } else {
        logger.info(`   Local PostgreSQL: ${dbStatus.local ? '✅ Connected (PRIMARY)' : '❌ Not available'}`);
        logger.info(`   Remote Supabase: ${dbStatus.remote ? '✅ Connected (for sync)' : '⚠️ Not available (sync disabled)'}`);
      }
    } catch (error) {
      console.log('[INIT] Step 1: Failed -', error.message);
      logger.error('❌ Database initialization failed', error);
      throw error;
    }

    // 2. Start sync service (only in local mode with remote available)
    console.log('[INIT] Step 2: Starting sync service...');
    logger.info('🔄 Starting sync service...');
    try {
      if (isCloudMode) {
        // Cloud mode: no sync needed (using Supabase directly)
        console.log('[INIT] Step 2: Skipped (cloud mode)');
        logger.info('ℹ️ Sync service not needed in cloud mode');
      } else {
        // Always start sync services - they will retry remote connection automatically
        await offlineSyncService.start();
        syncService.start();
        console.log('[INIT] Step 2: Done');
        
        if (database.isRemoteAvailable()) {
          logger.info('✅ Sync service started (local → remote) - remote connected');

          // Auto-pull station data if configured
          const stationConfig = syncService.getStationConfig();
          if (stationConfig.isConfigured && stationConfig.autoPullOnStartup) {
            logger.info(`📥 Auto-pulling reference data for station ${stationConfig.stationId}...`);
            try {
              await syncService.pullStationData(stationConfig.companyId, stationConfig.stationId);
              logger.info('✅ Station reference data synced');
            } catch (pullError) {
              logger.warn('⚠️ Failed to pull station data:', pullError.message);
            }
          }
        } else {
          logger.warn('⚠️ Sync service started but remote not yet available - will retry automatically');
        }
      }
    } catch (error) {
      logger.warn('⚠️ Sync service failed to start:', error.message);
    }

    // 3. Start PTS polling service (local mode only)
    console.log('[INIT] Step 3: Checking PTS polling...', 'MODE:', DEPLOYMENT_MODE, 'ENABLED:', PTS_POLLING_ENABLED);
    if (isCloudMode) {
      console.log('[INIT] Step 3: Skipped (cloud mode)');
      logger.info('⛽ PTS polling disabled (cloud mode)');
    } else if (PTS_POLLING_ENABLED) {
      console.log('[INIT] Step 3a: Starting PTS...');
      logger.info('⛽ Starting PTS polling service...');
      try {
        await ptsPollingService.start();
        logger.info('✅ PTS polling service started');
      } catch (error) {
        logger.error('❌ Failed to start PTS polling service', error);
      }
    } else {
      console.log('[INIT] Step 3b: PTS skipped');
      logger.info('⛽ PTS polling disabled');
    }
    console.log('[INIT] Step 3: Done');

    // 3b. Start PTS Sales polling service (local mode only)
    console.log('[INIT] Step 3b: Checking PTS Sales polling...');
    if (isCloudMode) {
      console.log('[INIT] Step 3b: Skipped (cloud mode)');
      logger.info('📊 PTS Sales polling disabled (cloud mode)');
    } else {
      console.log('[INIT] Step 3b: Starting PTS Sales polling...');
      logger.info('📊 Starting PTS Sales polling service...');
      try {
        await ptsSalesPollingService.start();
        logger.info('✅ PTS Sales polling service started');
      } catch (error) {
        logger.error('❌ Failed to start PTS Sales polling service', error);
      }
    }
    console.log('[INIT] Step 3b: Done');

    // 3c. Start Pump Report polling service (ReportGetPumpTransactions - General Maestro Reports)
    console.log('[INIT] Step 3c: Checking Pump Report polling...');
    if (isCloudMode) {
      console.log('[INIT] Step 3c: Skipped (cloud mode)');
      logger.info('📋 Pump Report polling disabled (cloud mode)');
    } else {
      console.log('[INIT] Step 3c: Starting Pump Report polling...');
      logger.info('📋 Starting Pump Report Polling Service (General Maestro Reports)...');
      try {
        await pumpReportPollingService.start();
        logger.info('✅ Pump Report Polling Service started');
      } catch (error) {
        logger.error('❌ Failed to start Pump Report Polling Service', error);
      }
    }
    console.log('[INIT] Step 3c: Done');

    // 4. Start RFID reader service (local mode only)
    console.log('[INIT] Step 4: Checking RFID reader...', 'MODE:', DEPLOYMENT_MODE, 'ENABLED:', RFID_ENABLED);
    if (isCloudMode) {
      console.log('[INIT] Step 4: Skipped (cloud mode)');
      logger.info('🏷️ RFID reader disabled (cloud mode)');
    } else if (RFID_ENABLED) {
      console.log('[INIT] Step 4a: Starting RFID reader...');
      logger.info('🏷️ Starting RFID reader service...');
      try {
        await rfidReaderService.start();
        logger.info('✅ RFID reader service started');
      } catch (error) {
        logger.error('❌ Failed to start RFID reader service', error);
      }
    } else {
      console.log('[INIT] Step 4b: RFID skipped');
      logger.info('🏷️ RFID reader disabled');
    }
    console.log('[INIT] Step 4: Done');

    console.log('[INIT] Initialization complete');
    logger.info('='.repeat(60));
    logger.info('✅ All services initialized');
    logger.info('='.repeat(60));
  } catch (error) {
    logger.error('❌ Failed to initialize services', error);
    process.exit(1);
  }
}

/**
 * Start HTTP server
 */
async function startServer() {
  try {
    // Initialize services first
    await initializeServices();

    // Start HTTP server
    const server = app.listen(PORT, () => {
      logger.info(`🌐 Server listening on port ${PORT}`);
      logger.info(`📡 http://localhost:${PORT}/api/health`);
      logger.info(`📊 http://localhost:${PORT}/api/status`);
      logger.info(`⛽ http://localhost:${PORT}/api/pts/pumps`);
      logger.info(`🛢️  http://localhost:${PORT}/api/pts/tanks`);
    });

    // WebSocket server for real-time PTS updates
    if (PTS_POLLING_ENABLED) {
      try {
        const WebSocket = require('ws');
        const wss = new WebSocket.Server({ server });

        wss.on('connection', (ws) => {
          logger.info('🔌 WebSocket client connected');
          ptsPollingService.wsClients.add(ws);

          // Send current status on connect
          ws.send(JSON.stringify({
            type: 'connected',
            timestamp: new Date().toISOString(),
            data: {
              pumps: ptsPollingService.getCachedPumpsStatus(),
              tanks: ptsPollingService.getCachedTanksStatus()
            }
          }));

          ws.on('close', () => {
            logger.info('🔌 WebSocket client disconnected');
            ptsPollingService.wsClients.delete(ws);
          });

          ws.on('error', (err) => {
            logger.error('WebSocket error', err);
            ptsPollingService.wsClients.delete(ws);
          });
        });

        logger.info(`🔌 WebSocket server running on ws://localhost:${PORT}`);
      } catch (wsError) {
        logger.warn('⚠️ WebSocket not available (ws package not installed)');
      }
    }

    // Graceful shutdown
    process.on('SIGTERM', () => {
      logger.info('SIGTERM received - shutting down gracefully');

      server.close(() => {
        logger.info('HTTP server closed');

        if (!isCloudMode && offlineSyncService) {
          offlineSyncService.stop();
        }

        if (!isCloudMode && PTS_POLLING_ENABLED && ptsPollingService) {
          ptsPollingService.stop();
        }

        logger.info('✅ Server shutdown complete');
        process.exit(0);
      });
    });

    process.on('SIGINT', () => {
      logger.info('SIGINT received - shutting down gracefully');

      server.close(() => {
        logger.info('HTTP server closed');

        if (!isCloudMode && offlineSyncService) {
          offlineSyncService.stop();
        }

        if (!isCloudMode && PTS_POLLING_ENABLED && ptsPollingService) {
          ptsPollingService.stop();
        }

        logger.info('✅ Server shutdown complete');
        process.exit(0);
      });
    });

    return server;
  } catch (error) {
    logger.error('Failed to start server', error);
    process.exit(1);
  }
}

/**
 * Main entry point
 */
if (require.main === module) {
  startServer().catch(error => {
    logger.error('Fatal error', error);
    process.exit(1);
  });
}

module.exports = { app, startServer };