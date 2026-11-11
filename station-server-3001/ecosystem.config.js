/**
 * PM2 Configuration for MAESTRO-LITE
 * 
 * This ensures the server:
 * - Auto-restarts on crash
 * - Auto-starts on PC boot
 * - Logs errors to files
 * - Restarts if memory exceeds limit
 * 
 * Install PM2 globally: npm install -g pm2
 * Start: pm2 start ecosystem.config.js
 * Save for auto-start: pm2 save
 * Setup Windows startup: pm2-startup install
 */

module.exports = {
  apps: [{
    name: 'maestro-lite',
    script: 'index.js',
    
    // Auto-restart settings
    autorestart: true,
    watch: false,
    max_memory_restart: '500M',
    
    // Restart delays to prevent rapid crash loops
    restart_delay: 5000,        // Wait 5 seconds before restart
    max_restarts: 10,           // Max 10 restarts in min_uptime window
    min_uptime: 60000,          // Consider running if up for 60 seconds
    
    // Environment
    env: {
      NODE_ENV: 'production',
      PORT: 3000
    },
    
    // Logging
    error_file: './logs/pm2-error.log',
    out_file: './logs/pm2-out.log',
    log_date_format: 'YYYY-MM-DD HH:mm:ss Z',
    merge_logs: true,
    
    // Graceful shutdown
    kill_timeout: 5000,
    wait_ready: true,
    listen_timeout: 10000,
    
    // Cluster mode (optional - use 1 for simplicity)
    instances: 1,
    exec_mode: 'fork'
  }]
};
