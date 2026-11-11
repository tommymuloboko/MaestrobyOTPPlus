/**
 * Connection Status Service
 * Monitors network connectivity to remote database (Supabase)
 */
const logger = require('../utils/logger')('ConnectionStatus');
const database = require('../utils/database');

class ConnectionStatusService {
  constructor() {
    this.isOnline = false;
    this.checkIntervalMs = parseInt(process.env.CONNECTION_CHECK_INTERVAL_MS || '10000');
    this.checkInterval = null;
    this.listeners = [];
    this.lastCheck = null;
    this.consecutiveFailures = 0;
    this.maxConsecutiveFailures = 3;
  }

  /**
   * Start monitoring connection status
   */
  async start() {
    logger.info('🔌 Starting connection status monitor');
    
    // Initial check - await it so isOnline is set before returning
    await this.checkConnection();
    
    // Periodic checks
    this.checkInterval = setInterval(
      () => this.checkConnection(),
      this.checkIntervalMs
    );
  }

  /**
   * Stop monitoring
   */
  stop() {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }
    logger.info('🔌 Connection status monitor stopped');
  }

  /**
   * Check if remote database is available
   */
  async checkConnection() {
    try {
      this.lastCheck = new Date();
      
      // Check if remote database is available
      const remoteAvailable = database.isRemoteAvailable();
      
      if (remoteAvailable) {
        // Try a simple query to verify actual connectivity
        const remote = database.getRemote();
        if (remote) {
          await remote.query('SELECT 1');
        }
      }
      
      const wasOnline = this.isOnline;
      this.isOnline = remoteAvailable;
      this.consecutiveFailures = 0;
      
      // Notify listeners if status changed
      if (wasOnline !== this.isOnline) {
        logger.info(`Connection status changed: ${this.isOnline ? '🟢 ONLINE' : '🔴 OFFLINE'}`);
        this.notifyListeners();
      }
    } catch (error) {
      this.consecutiveFailures++;
      
      if (this.consecutiveFailures >= this.maxConsecutiveFailures && this.isOnline) {
        this.isOnline = false;
        logger.warn(`Connection lost after ${this.consecutiveFailures} failures: ${error.message}`);
        this.notifyListeners();
      }
    }
  }

  /**
   * Get current connection status
   */
  getStatus() {
    return {
      isOnline: this.isOnline,
      lastCheck: this.lastCheck,
      consecutiveFailures: this.consecutiveFailures,
    };
  }

  /**
   * Register a listener for status changes
   * @param {Function} callback - Called with (isOnline) when status changes
   */
  onStatusChange(callback) {
    this.listeners.push(callback);
    
    // Return unsubscribe function
    return () => {
      const index = this.listeners.indexOf(callback);
      if (index > -1) {
        this.listeners.splice(index, 1);
      }
    };
  }

  /**
   * Notify all listeners of status change
   */
  notifyListeners() {
    for (const listener of this.listeners) {
      try {
        listener(this.isOnline);
      } catch (error) {
        logger.error('Error in connection status listener:', error);
      }
    }
  }

  /**
   * Force a connection check
   */
  async forceCheck() {
    await this.checkConnection();
    return this.isOnline;
  }
}

// Export singleton instance
module.exports = new ConnectionStatusService();
