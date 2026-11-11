const fs = require('fs');
const path = require('path');

// Create logs directory if it doesn't exist
const logsDir = path.join(__dirname, '../logs');
if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir, { recursive: true });
}

const LOG_LEVEL = {
  DEBUG: 0,
  INFO: 1,
  WARN: 2,
  ERROR: 3,
};

const logLevelStr = (process.env.LOG_LEVEL || 'INFO').toUpperCase();
const currentLogLevel = LOG_LEVEL[logLevelStr] !== undefined ? LOG_LEVEL[logLevelStr] : LOG_LEVEL.INFO;
const logFilePath = path.join(logsDir, 'server.log');

class Logger {
  constructor(module) {
    this.module = module;
  }

  getTimestamp() {
    return new Date().toISOString();
  }

  formatMessage(level, message, data = null) {
    const timestamp = this.getTimestamp();
    const module = `[${this.module}]`;
    const dataStr = data ? ` ${JSON.stringify(data)}` : '';
    return `${timestamp} ${level} ${module} ${message}${dataStr}`;
  }

  writeLog(level, message, data) {
    const logMessage = this.formatMessage(level, message, data);
    
    // Write to file
    try {
      fs.appendFileSync(logFilePath, logMessage + '\n');
    } catch (error) {
      console.error('Failed to write log:', error.message);
    }

    // Console output
    console.log(logMessage);
  }

  debug(message, data) {
    if (currentLogLevel <= LOG_LEVEL.DEBUG) {
      this.writeLog('DEBUG', message, data);
    }
  }

  info(message, data) {
    if (currentLogLevel <= LOG_LEVEL.INFO) {
      this.writeLog('INFO', message, data);
    }
  }

  warn(message, data) {
    if (currentLogLevel <= LOG_LEVEL.WARN) {
      this.writeLog('WARN', message, data);
    }
  }

  error(message, error) {
    if (currentLogLevel <= LOG_LEVEL.ERROR) {
      const errorData = error instanceof Error ? error.message : error;
      this.writeLog('ERROR', message, errorData);
    }
  }
}

module.exports = (moduleName) => new Logger(moduleName);
