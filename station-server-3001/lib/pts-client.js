/**
 * PTS Client - Node.js implementation of jsonPTS protocol
 * Converts browser-based pts.js to Node.js compatible module
 */

const axios = require('axios');
const https = require('https');
const http = require('http');
const crypto = require('crypto');
const EventEmitter = require('events');
const logger = require('../utils/logger')('PTSClient');

// Constants
const TOTAL_PUMP_PORTS = 4;
const TOTAL_PUMPS = 50;
const TOTAL_PROBE_PORTS = 3;
const TOTAL_PROBES = 50;
const TOTAL_PRICE_BOARDS = 5;
const TOTAL_READERS = TOTAL_PUMPS;
const TOTAL_FUEL_GRADES = 10;

class PTSClient extends EventEmitter {
    constructor(config) {
        super();
        this.config = config;
        this.baseURL = config.url;
        this.username = config.username;
        this.password = config.password;
        this.timeout = config.timeout || 30000;

        // Create axios instance (Digest auth will be handled manually)
        const isHttps = this.baseURL.startsWith('https://');
        const axiosConfig = {
            baseURL: this.baseURL,
            timeout: this.timeout,
            headers: {
                'Content-Type': 'application/json',
                'User-Agent': 'PostmanRuntime/7.29.0',
                'Accept': '*/*'
            }
            // Note: Digest authentication is handled manually in sendRequest
        };

        // Only add HTTPS agent if using HTTPS (for self-signed certificates)
        if (isHttps) {
            axiosConfig.httpsAgent = new https.Agent({
                rejectUnauthorized: false
            });
        }

        this.client = axios.create(axiosConfig);

        // Store for Digest authentication
        this.digestAuth = {
            realm: null,
            nonce: null,
            qop: null,
            algorithm: null,
            opaque: null
        };
    }

    /**
     * Create a complex request with multiple packets
     * @param {Array} commands - Array of {function: Function, arguments: Array}
     * @returns {Promise}
     */
    async createComplexRequest(commands) {
        const request = {
            Protocol: 'jsonPTS',
            Packets: []
        };

        commands.forEach((command, index) => {
            const packet = {
                Id: index + 1,
                Type: command.function.name.replace(/^bound /, ''),
                Data: command.function.apply(this, command.arguments || [])
            };
            request.Packets.push(packet);
        });

        return this.sendRequest(JSON.stringify(request));
    }

    /**
     * Parse WWW-Authenticate header for Digest authentication
     */
    parseDigestChallenge(wwwAuthenticate) {
        const challenge = {};
        const parts = wwwAuthenticate.replace(/^Digest\s+/, '').split(/,\s*(?=(?:[^"]*"[^"]*")*[^"]*$)/);

        parts.forEach(part => {
            const match = part.match(/(\w+)=["']?([^"',]+)["']?/);
            if (match) {
                challenge[match[1]] = match[2];
            }
        });

        return challenge;
    }

    /**
     * Generate Digest authentication response
     */
    generateDigestAuth(method, uri, body) {
        const { realm, nonce, qop, algorithm, opaque } = this.digestAuth;
        const username = this.username;
        const password = this.password;

        // Generate cnonce (client nonce)
        const cnonce = crypto.randomBytes(16).toString('hex');

        // Generate nc (nonce count) - increment for each request
        if (!this.nc) this.nc = 0;
        this.nc++;
        const nc = String(this.nc).padStart(8, '0');

        // HA1 = MD5(username:realm:password)
        const ha1 = crypto.createHash('md5')
            .update(`${username}:${realm}:${password}`)
            .digest('hex');

        // HA2 = MD5(method:uri)
        const ha2 = crypto.createHash('md5')
            .update(`${method}:${uri}`)
            .digest('hex');

        // Response = MD5(HA1:nonce:nc:cnonce:qop:HA2)
        let response;
        if (qop) {
            response = crypto.createHash('md5')
                .update(`${ha1}:${nonce}:${nc}:${cnonce}:${qop}:${ha2}`)
                .digest('hex');
        } else {
            response = crypto.createHash('md5')
                .update(`${ha1}:${nonce}:${ha2}`)
                .digest('hex');
        }

        // Build Authorization header
        let authHeader = `Digest username="${username}", realm="${realm}", nonce="${nonce}", uri="${uri}", response="${response}"`;

        if (qop) {
            authHeader += `, qop=${qop}, nc=${nc}, cnonce="${cnonce}"`;
        }

        if (opaque) {
            authHeader += `, opaque="${opaque}"`;
        }

        if (algorithm) {
            authHeader += `, algorithm=${algorithm}`;
        }

        return authHeader;
    }

    /**
     * Send request to PTS controller with Digest authentication
     * @param {string} requestString - JSON string of the request
     * @returns {Promise}
     */
    async sendRequest(requestString) {
        logger.debug('Sending raw request to PTS', { body: requestString });
        const method = 'POST';
        // Extract URI path from baseURL for Digest authentication
        let uri = '/jsonPTS'; // Default
        try {
            const url = new URL(this.baseURL);
            uri = url.pathname || '/jsonPTS';
        } catch (e) {
            // Fallback: extract path from baseURL string
            const match = this.baseURL.match(/https?:\/\/[^\/]+(\/.*)/);
            if (match) {
                uri = match[1];
            }
        }

        try {
            logger.debug('Sending request to PTS', {
                url: this.baseURL,
                protocol: this.baseURL.startsWith('https://') ? 'HTTPS' : 'HTTP',
                username: this.username
            });

            // Try request with auth depending on protocol
            let response;
            let retryWithDigestAuth = false;

            const isHttps = this.baseURL.startsWith('https://');

            try {
                if (isHttps) {
                    // For HTTPS, always use Basic Authentication
                    const basicAuthHeader = 'Basic ' + Buffer.from(`${this.username}:${this.password}`).toString('base64');
                    response = await this.client.post('', requestString, {
                        headers: {
                            'Authorization': basicAuthHeader
                        }
                    });
                } else if (this.digestAuth.nonce) {
                    // For HTTP, we have digest auth data, use it
                    const authHeader = this.generateDigestAuth(method, uri, requestString);
                    response = await this.client.post('', requestString, {
                        headers: {
                            'Authorization': authHeader
                        }
                    });
                } else {
                    // First request (HTTP) - will get 401 with challenge
                    response = await this.client.post('', requestString);
                }
            } catch (error) {
                if (error.response && error.response.status === 401) {
                    // Parse WWW-Authenticate header
                    const wwwAuthenticate = error.response.headers['www-authenticate'];

                    if (wwwAuthenticate && wwwAuthenticate.toLowerCase().startsWith('basic')) {
                        // Some systems might return 401 even over HTTP with Basic Auth challege
                        const basicAuthHeader = 'Basic ' + Buffer.from(`${this.username}:${this.password}`).toString('base64');
                        response = await this.client.post('', requestString, {
                            headers: {
                                'Authorization': basicAuthHeader
                            }
                        });
                    } else if (wwwAuthenticate && wwwAuthenticate.startsWith('Digest')) {
                        this.digestAuth = this.parseDigestChallenge(wwwAuthenticate);
                        this.nc = 0; // Reset nonce count
                        retryWithDigestAuth = true;
                        logger.debug('Received Digest challenge', { realm: this.digestAuth.realm });
                    } else {
                        throw error;
                    }
                } else {
                    throw error;
                }
            }

            // Retry with Digest auth if needed
            if (retryWithDigestAuth) {
                const authHeader = this.generateDigestAuth(method, uri, requestString);
                response = await this.client.post('', requestString, {
                    headers: {
                        'Authorization': authHeader
                    }
                });
            }

            // Check for errors in response
            if (response.data.Error === true) {
                const errorMsg = response.data.Message || 'Unknown error';
                logger.error('PTS controller error', { message: errorMsg, data: response.data.Data });
                throw new Error(errorMsg);
            }

            // Check for errors in packets
            if (response.data.Packets) {
                response.data.Packets.forEach((packet) => {
                    if (packet.Error === true) {
                        const errorMsg = packet.Message || 'Unknown packet error';
                        // JSONPTS_ERROR_NOT_FOUND is expected for unconfigured devices - don't log as error
                        if (errorMsg === 'JSONPTS_ERROR_NOT_FOUND') {
                            logger.debug('Device not configured', {
                                packetId: packet.Id,
                                packetType: packet.Type
                            });
                        } else {
                            logger.error('PTS packet error', {
                                packetId: packet.Id,
                                packetType: packet.Type,
                                message: errorMsg,
                                data: packet.Data
                            });
                        }
                        // Don't throw, but log - some packets may have errors while others succeed
                    }
                });
            }

            return response.data;
        } catch (error) {
            if (error.response) {
                // If still 401, authentication failed
                if (error.response.status === 401) {
                    logger.error('PTS authentication failed', {
                        status: error.response.status,
                        statusText: error.response.statusText
                    });
                    throw new Error('PTS Authentication Failed: Check username and password');
                }

                logger.error('PTS HTTP error', {
                    status: error.response.status,
                    statusText: error.response.statusText,
                    data: error.response.data
                });
                throw new Error(`PTS HTTP Error: ${error.response.status} ${error.response.statusText}`);
            } else if (error.request) {
                logger.error('PTS request timeout/network error', { message: error.message });
                throw new Error(`PTS Network Error: ${error.message}`);
            } else {
                logger.error('PTS request error', { message: error.message });
                throw error;
            }
        }
    }

    // ============================================================================
    // General Requests
    // ============================================================================

    GetConfigurationIdentifier() {
        return {};
    }

    GetLanguage() {
        return undefined;
    }

    GetMeasurementUnits() {
        return undefined;
    }

    GetDateTime() {
        return undefined;
    }

    SetDateTime(dateTime, autoSync, utcOffset) {
        return {
            DateTime: dateTime,
            AutoSynchronize: autoSync,
            UTCOffset: utcOffset
        };
    }

    GetUserInformation() {
        return undefined;
    }

    GetFirmwareInformation() {
        return undefined;
    }

    GetBatteryVoltage() {
        return undefined;
    }

    GetCpuTemperature() {
        return undefined;
    }

    GetUniqueIdentifier() {
        return undefined;
    }

    GetSdInformation() {
        return undefined;
    }

    GetSystemOperationInformation() {
        return undefined;
    }

    Restart() {
        return undefined;
    }

    // ============================================================================
    // Pump Control Requests
    // ============================================================================

    PumpGetStatus(pumpNumber) {
        return {
            Pump: pumpNumber
        };
    }

    PumpAuthorize(pumpNumber, nozzleNumber, presetType, presetDose, price, options = {}) {
        const data = {
            Pump: pumpNumber,
            Type: presetType
        };

        // Only set Nozzle if provided (omit for RFID — any nozzle gets authorized)
        if (nozzleNumber) {
            data.Nozzle = nozzleNumber;
        }

        // Only set Price if provided
        if (price) {
            data.Price = price;
        }

        if (data.Type === 'Volume' || data.Type === 'Amount') {
            data.Dose = presetDose;
        }

        // Optional flags
        if (options.user) {
            data.User = options.user;
        }
        if (options.tag) {
            data.Tag = options.tag;
        }
        if (options.autoClose) {
            data.AutoCloseTransaction = true;
        }
        if (options.noTagVerification) {
            data.NoTagVerification = true;
        }

        return data;
    }

    PumpStop(pumpNumber) {
        return {
            Pump: pumpNumber
        };
    }

    PumpEmergencyStop(pumpNumber) {
        return {
            Pump: pumpNumber
        };
    }

    PumpResume(pumpNumber) {
        return {
            Pump: pumpNumber
        };
    }

    PumpSuspend(pumpNumber) {
        return {
            Pump: pumpNumber
        };
    }

    PumpCloseTransaction(pumpNumber, transactionNumber) {
        return {
            Pump: pumpNumber,
            Transaction: transactionNumber
        };
    }

    PumpGetTotals(pumpNumber, nozzleNumber) {
        return {
            Pump: pumpNumber,
            Nozzle: nozzleNumber
        };
    }

    PumpGetPrices(pumpNumber) {
        return {
            Pump: pumpNumber
        };
    }

    PumpSetPrices(pumpNumber, prices) {
        return {
            Pump: pumpNumber,
            Prices: Array.isArray(prices) ? prices : [prices]
        };
    }

    PumpGetTransactionInformation(pumpNumber, transactionNumber) {
        const data = { Pump: pumpNumber };
        if (transactionNumber) {
            data.Transaction = transactionNumber;
        }
        return data;
    }

    PumpGetTag(pumpNumber, nozzleNumber) {
        return {
            Pump: pumpNumber,
            Nozzle: nozzleNumber
        };
    }

    // ============================================================================
    // Transaction Query Requests
    // ============================================================================

    QueryTransactions(fromDateTime, toDateTime, pumpId = null, limit = 100) {
        const data = {
            FromDateTime: fromDateTime,
            ToDateTime: toDateTime,
            Limit: limit
        };

        if (pumpId !== null) {
            data.Pump = pumpId;
        }

        return data;
    }

    QueryLastTransaction(pumpId) {
        return {
            Pump: pumpId
        };
    }

    ReportGetPumpTransactions(pumpNumber, dateTimeStart, dateTimeEnd) {
        return {
            Pump: pumpNumber,
            DateTimeStart: dateTimeStart,
            DateTimeEnd: dateTimeEnd
        };
    }

    PumpSetLights(pumpNumber, state) {
        return {
            Pump: pumpNumber,
            State: state
        };
    }

    PumpLock(pumpNumber) {
        return {
            Pump: pumpNumber
        };
    }

    PumpUnlock(pumpNumber) {
        return {
            Pump: pumpNumber
        };
    }

    // ============================================================================
    // Probe/Tank Requests
    // ============================================================================

    ProbeGetMeasurements(probeNumber) {
        return {
            Probe: probeNumber
        };
    }

    ProbeGetTankVolumeForHeight(tankNumber, height) {
        return {
            Probe: tankNumber,
            Height: height
        };
    }

    // ============================================================================
    // Configuration Requests
    // ============================================================================

    AddUserConfiguration(userId, name, permissions = []) {
        return {
            UserId: userId,
            Name: name,
            Permissions: permissions
        };
    }

    GetPumpsConfiguration() {
        return {};  // No parameters needed for this query
    }

    GetProbesConfiguration() {
        return {};  // No parameters needed for this query
    }

    GetTanksConfiguration() {
        return {};  // No parameters needed for this query
    }

    GetFuelGradesConfiguration() {
        return {};  // No parameters needed for this query
    }

    GetNozzlesConfiguration() {
        return {};  // No parameters needed for this query
    }

    GetFuelGradesPrices() {
        return undefined;
    }

    SetFuelGradesPrices(fuelGradesPrices) {
        return {
            FuelGradesPrices: fuelGradesPrices
        };
    }

    GetPricesSchedulerConfiguration() {
        return undefined;  // No parameters needed
    }

    SetPricesSchedulerConfiguration(priceSchedules) {
        return {
            PriceSchedules: priceSchedules
        };
    }

    GetPumpNozzlesConfiguration() {
        return undefined;
    }

    GetPriceBoardsConfiguration() {
        return undefined;
    }

    GetReadersConfiguration() {
        return undefined;
    }

    GetTagsList() {
        return undefined;
    }

    GetPortsState() {
        return undefined;
    }

    // ============================================================================
    // Reader Requests
    // ============================================================================

    ReaderGetTag(readerNumber) {
        return {
            Reader: readerNumber
        };
    }

    ReaderGetStatus(readerNumber) {
        return {
            Reader: readerNumber
        };
    }
}

module.exports = PTSClient;

