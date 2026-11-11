/**
 * Fuel Service - Manages pump operations and polling
 */

const EventEmitter = require('events');
const PTSClient = require('../lib/pts-client');
const logger = require('../utils/logger')('FuelService');
const db = require('../utils/db');
const dotenv = require('dotenv');
dotenv.config();

class FuelService extends EventEmitter {
    constructor(config) {
        super();
        this.ptsClient = new PTSClient(config);
        this.pollingInterval = config.pollingInterval || 1000;
        this.pollingTimer = null;
        this.isPolling = false;

        // State storage
        this.pumpStatuses = new Map(); // pumpNumber -> status object
        this.tankStatuses = new Map(); // tankNumber -> status object
        this.lastTransactionNumbers = new Map(); // pumpNumber -> last transaction number

        // Track which pumps/probes to poll (can be configured)
        this.pumpsToPoll = [];
        this.probesToPoll = [];

        // Track which devices are actually configured (discovered from responses)
        this.configuredPumps = new Set();
        this.configuredProbes = new Set();
    }

    /**
     * Start polling pumps and probes
     */
    async startPolling() {
        if (this.isPolling) {
            logger.warn('Polling already started');
            return;
        }

        logger.info('Starting fuel service polling', { interval: this.pollingInterval });
        this.isPolling = true;

        // Initial status fetch
        await this.pollAllPumps();
        await this.pollAllTanks();

        // Start periodic polling
        this.pollingTimer = setInterval(async () => {
            try {
                await this.pollAllPumps();
                // Poll tanks less frequently (every 5 seconds)
                if (Date.now() % 5000 < this.pollingInterval) {
                    await this.pollAllTanks();
                }
            } catch (error) {
                logger.error('Error during polling cycle', error);
            }
        }, this.pollingInterval);
    }

    /**
     * Stop polling
     */
    async stopPolling() {
        if (!this.isPolling) {
            return;
        }

        logger.info('Stopping fuel service polling');
        this.isPolling = false;

        if (this.pollingTimer) {
            clearInterval(this.pollingTimer);
            this.pollingTimer = null;
        }
    }

    /**
     * Poll status for all configured pumps
     */
    async pollAllPumps() {
        try {
            // Determine which pumps to check
            let pumpsToCheck;
            if (this.pumpsToPoll.length > 0) {
                // Use explicitly configured pumps
                pumpsToCheck = this.pumpsToPoll;
            } else if (this.configuredPumps.size > 0) {
                // Use discovered configured pumps
                pumpsToCheck = Array.from(this.configuredPumps);
            } else {
                // First time: try to discover configured pumps (check first 20 pumps)
                pumpsToCheck = Array.from({ length: 20 }, (_, i) => i + 1);
            }

            // Create batch request for all pumps
            const commands = pumpsToCheck.map(pumpNumber => ({
                function: this.ptsClient.PumpGetStatus.bind(this.ptsClient),
                arguments: [pumpNumber]
            }));

            if (commands.length === 0) {
                return;
            }

            const response = await this.ptsClient.createComplexRequest(commands);

            logger.debug('Pump polling response', {
                hasPackets: !!response.Packets,
                packetCount: response.Packets ? response.Packets.length : 0,
                responseKeys: Object.keys(response)
            });

            if (response.Packets) {
                response.Packets.forEach((packet, index) => {
                    const pumpNumber = pumpsToCheck[index];

                    logger.debug('Pump status response', {
                        pumpNumber,
                        packetId: packet.Id,
                        packetType: packet.Type,
                        hasError: packet.Error === true,
                        errorMessage: packet.Message,
                        hasData: !!packet.Data,
                        dataKeys: packet.Data ? Object.keys(packet.Data) : []
                    });

                    if (packet.Error !== true && packet.Data) {
                        // Pump is configured and responding
                        this.configuredPumps.add(pumpNumber);
                        // Pass through the exact raw PTS packet: Id, Type, and all Data fields
                        const rawPacket = {
                            Id: packet.Id,
                            Type: packet.Type,
                            Data: packet.Data
                        };
                        this.updatePumpStatus(pumpNumber, rawPacket);

                        logger.info('Pump status update', rawPacket);
                    } else if (packet.Error === true && packet.Message === 'JSONPTS_ERROR_NOT_FOUND') {
                        // Pump is not configured - remove from configured set if it was there
                        this.configuredPumps.delete(pumpNumber);
                    }
                });
            }
        } catch (error) {
            logger.error('Error polling pumps', error);
        }
    }

    /**
     * Update pump status and emit events if changed
     * statusData is the raw PTS packet: { Id, Type, Data: { ...all PTS fields } }
     */
    updatePumpStatus(pumpNumber, statusData) {
        const previousStatus = this.pumpStatuses.get(pumpNumber);
        this.pumpStatuses.set(pumpNumber, statusData);

        // Emit status update with the raw PTS packet
        this.emit('statusUpdate', {
            pump: pumpNumber,
            status: statusData
        });

        // Check for transaction changes (field is inside Data)
        const txn = statusData.Data?.Transaction;
        if (txn !== undefined) {
            const lastTransaction = this.lastTransactionNumbers.get(pumpNumber);
            if (lastTransaction !== txn) {
                this.lastTransactionNumbers.set(pumpNumber, txn);
            }
        }

        // Emit specific events based on packet Type
        const currentType = statusData.Type;
        const previousType = previousStatus?.Type;

        if (currentType === 'PumpFillingStatus' && previousType !== 'PumpFillingStatus') {
            this.emit('pumpFilling', {
                pump: pumpNumber,
                status: statusData
            });
        } else if (currentType === 'PumpIdleStatus' && previousType !== 'PumpIdleStatus') {
            this.emit('pumpIdle', {
                pump: pumpNumber,
                status: statusData
            });

            // AutoCloseTransaction: PTS-2 skips EndOfTransaction, goes Filling → Idle directly
            // Detect this and emit transactionComplete using last transaction data from PumpIdleStatus
            if (previousType === 'PumpFillingStatus') {
                const lastTx = statusData.Data?.LastTransaction;
                if (lastTx) {
                    this.emit('transactionComplete', {
                        pump: pumpNumber,
                        transaction: lastTx,
                        status: statusData
                    });
                }
            }
        } else if (currentType === 'PumpEndOfTransactionStatus' && previousType !== 'PumpEndOfTransactionStatus') {
            this.emit('transactionComplete', {
                pump: pumpNumber,
                transaction: statusData.Data?.Transaction,
                status: statusData
            });
        }
    }

    // fetchTransactionDetails removed as per request to undo sending data to the server

    /**
     * Get pump transaction info directly
     * Used by API to close transactions and to fetch full transaction details (Tag, Volume, Amount, etc.)
     * @param {number} pumpNumber - Pump number
     * @param {number} [transactionNumber] - Optional transaction number (0 or omit for last)
     */
    async getPumpTransactionInfo(pumpNumber, transactionNumber) {
        try {
            const response = await this.ptsClient.createComplexRequest([{
                function: this.ptsClient.PumpGetTransactionInformation.bind(this.ptsClient),
                arguments: [pumpNumber, transactionNumber]
            }]);

            if (response.Packets && response.Packets[0] && response.Packets[0].Data) {
                return response.Packets[0].Data;
            }

            return null;
        } catch (error) {
            logger.error('Error getting pump transaction info', { pump: pumpNumber, error: error.message });
            throw error;
        }
    }

    /**
     * Poll all tanks/probes
     */
    async pollAllTanks() {
        try {
            // Determine which probes to check
            let probesToCheck;
            if (this.probesToPoll.length > 0) {
                // Use explicitly configured probes
                probesToCheck = this.probesToPoll;
            } else if (this.configuredProbes.size > 0) {
                // Use discovered configured probes
                probesToCheck = Array.from(this.configuredProbes);
            } else {
                // First time: try to discover configured probes
                // Start by checking probes 1-10, but also try to get probe configuration
                probesToCheck = Array.from({ length: 10 }, (_, i) => i + 1);

                // Try to get probe configuration to find which probes are actually configured
                try {
                    const configResponse = await this.ptsClient.createComplexRequest([{
                        function: this.ptsClient.GetProbesConfiguration.bind(this.ptsClient),
                        arguments: []
                    }]);

                    if (configResponse.Packets && configResponse.Packets[0] &&
                        configResponse.Packets[0].Data && configResponse.Packets[0].Data.Probes) {
                        const configuredProbeIds = configResponse.Packets[0].Data.Probes.map(p => p.Id);
                        if (configuredProbeIds.length > 0) {
                            logger.debug('Found configured probes from configuration', { probeIds: configuredProbeIds });
                            probesToCheck = configuredProbeIds;
                        }
                    }
                } catch (configError) {
                    logger.debug('Could not get probe configuration, using discovery method', { error: configError.message });
                }
            }

            const commands = probesToCheck.map(probeNumber => ({
                function: this.ptsClient.ProbeGetMeasurements.bind(this.ptsClient),
                arguments: [probeNumber]
            }));

            if (commands.length === 0) {
                return;
            }

            const response = await this.ptsClient.createComplexRequest(commands);

            logger.debug('Tank polling response', {
                hasPackets: !!response.Packets,
                packetCount: response.Packets ? response.Packets.length : 0,
                responseKeys: Object.keys(response)
            });

            if (response.Packets) {
                response.Packets.forEach((packet, index) => {
                    // Get probe number from request (fallback) or from response data
                    let probeNumber = probesToCheck[index];

                    // If response has Data with Probe field, use that (more reliable)
                    if (packet.Data && packet.Data.Probe !== undefined) {
                        probeNumber = packet.Data.Probe;
                    }

                    logger.debug('Tank probe response', {
                        probeNumber,
                        packetId: packet.Id,
                        packetType: packet.Type,
                        hasError: packet.Error === true,
                        errorMessage: packet.Message,
                        hasData: !!packet.Data,
                        dataKeys: packet.Data ? Object.keys(packet.Data) : [],
                        responseProbeNumber: packet.Data?.Probe
                    });

                    if (packet.Error !== true && packet.Data) {
                        // Verify this is a ProbeMeasurements response
                        if (packet.Type === 'ProbeMeasurements' || packet.Data.Probe !== undefined) {
                            // Probe is configured and responding
                            this.configuredProbes.add(probeNumber);
                            logger.info('Received tank measurements', {
                                probeNumber,
                                fuelGrade: packet.Data.FuelGradeName || packet.Data.FuelGradeId,
                                productVolume: packet.Data.ProductVolume,
                                productHeight: packet.Data.ProductHeight,
                                temperature: packet.Data.Temperature,
                                tankFillingPercentage: packet.Data.TankFillingPercentage
                            });
                            // Log the full probe data for diagnostics
                            logger.info('Full tank probe data received', { probeNumber, data: packet.Data });
                            this.updateTankStatus(probeNumber, packet.Data);

                            // Removed code that inserts tank data into tank_reports table
                        } else {
                            logger.warn('Unexpected packet type for tank measurements', {
                                probeNumber,
                                packetType: packet.Type,
                                hasData: !!packet.Data
                            });
                        }
                    } else if (packet.Error === true && packet.Message === 'JSONPTS_ERROR_NOT_FOUND') {
                        // Probe is not configured - remove from configured set if it was there
                        this.configuredProbes.delete(probeNumber);
                        logger.debug('Probe not configured', { probeNumber });
                    } else if (packet.Error !== true && !packet.Data) {
                        // Response received but no data - might be different format
                        logger.warn('Probe response has no data', {
                            probeNumber,
                            packetType: packet.Type,
                            packet: JSON.stringify(packet)
                        });
                    } else if (packet.Error === true) {
                        // Other error
                        logger.warn('Probe response error', {
                            probeNumber,
                            errorMessage: packet.Message,
                            packetType: packet.Type
                        });
                    }
                });
            } else {
                logger.warn('No Packets in tank response', { response: JSON.stringify(response) });
            }
        } catch (error) {
            logger.error('Error polling tanks', error);
        }
    }

    /**
     * Update tank status
     */
    updateTankStatus(tankNumber, statusData) {
        const previousStatus = this.tankStatuses.get(tankNumber);
        this.tankStatuses.set(tankNumber, statusData);

        this.emit('tankUpdate', {
            tank: tankNumber,
            status: statusData
        });
    }

    /**
     * Authorize a pump for fueling
     * @param {number} pumpNumber - Pump number
     * @param {number} nozzleNumber - Nozzle number
     * @param {string} presetType - 'Volume', 'Amount', or null for no preset
     * @param {number} presetDose - Preset dose value
     * @param {number} price - Price per liter
     * @param {string} user - User/Attendant name (optional, for PTS-2 tracking)
     */
    async authorizePump(pumpNumber, nozzleNumber, presetType = null, presetDose = null, price = null, user = null) {
        try {
            logger.info('Authorizing pump', { pump: pumpNumber, nozzle: nozzleNumber, type: presetType, dose: presetDose, price, user });

            const response = await this.ptsClient.createComplexRequest([{
                function: this.ptsClient.PumpAuthorize.bind(this.ptsClient),
                arguments: [pumpNumber, nozzleNumber, presetType, presetDose, price, user]
            }]);

            if (response.Packets && response.Packets[0]) {
                if (response.Packets[0].Error === true) {
                    throw new Error(response.Packets[0].Message || 'Authorization failed');
                }

                // Immediately fetch updated pump status after authorization
                setTimeout(async () => {
                    try {
                        const statusResponse = await this.ptsClient.createComplexRequest([{
                            function: this.ptsClient.PumpGetStatus.bind(this.ptsClient),
                            arguments: [pumpNumber]
                        }]);

                        if (statusResponse.Packets && statusResponse.Packets[0] && !statusResponse.Packets[0].Error) {
                            this.updatePumpStatus(pumpNumber, statusResponse.Packets[0].Data);
                        }
                    } catch (err) {
                        logger.error('Error fetching pump status after authorization', err);
                    }
                }, 100);

                return response.Packets[0].Data;
            }

            throw new Error('Invalid response from PTS controller');
        } catch (error) {
            logger.error('Error authorizing pump', { pump: pumpNumber, error: error.message });
            throw error;
        }
    }

    /**
     * Ensure a user (attendant) exists in the PTS configuration
     * @param {string} userId - The unique user ID/code
     * @param {string} name - The user's name
     */
    async ensureUserExists(userId, name) {
        if (!userId) return;

        try {
            logger.debug('Ensuring user exists in PTS', { userId, name });
            // By sending AddUserConfiguration, if the user exists it might update or error
            // We'll optimistically try to add it. 
            // Most PTS controllers will update or ignore if exists.

            await this.ptsClient.createComplexRequest([{
                function: this.ptsClient.AddUserConfiguration.bind(this.ptsClient),
                arguments: [userId, name, ['AuthorizePump', 'ViewTransactions']]
            }]);

        } catch (error) {
            // Log but don't fail the flow - if registration fails, we still try to authorize
            // It might fail if user already exists
            logger.warn('Failed to register user in PTS (safely ignored)', { userId, error: error.message });
        }
    }

    /**
     * Stop a pump
     */
    async stopPump(pumpNumber) {
        try {
            logger.info('Stopping pump', { pump: pumpNumber });

            const response = await this.ptsClient.createComplexRequest([{
                function: this.ptsClient.PumpStop.bind(this.ptsClient),
                arguments: [pumpNumber]
            }]);

            if (response.Packets && response.Packets[0]) {
                if (response.Packets[0].Error === true) {
                    throw new Error(response.Packets[0].Message || 'Stop failed');
                }
                return response.Packets[0].Data;
            }

            throw new Error('Invalid response from PTS controller');
        } catch (error) {
            logger.error('Error stopping pump', { pump: pumpNumber, error: error.message });
            throw error;
        }
    }

    /**
     * Emergency stop a pump
     */
    async emergencyStopPump(pumpNumber) {
        try {
            logger.warn('Emergency stopping pump', { pump: pumpNumber });

            const response = await this.ptsClient.createComplexRequest([{
                function: this.ptsClient.PumpEmergencyStop.bind(this.ptsClient),
                arguments: [pumpNumber]
            }]);

            if (response.Packets && response.Packets[0]) {
                if (response.Packets[0].Error === true) {
                    throw new Error(response.Packets[0].Message || 'Emergency stop failed');
                }
                return response.Packets[0].Data;
            }

            throw new Error('Invalid response from PTS controller');
        } catch (error) {
            logger.error('Error emergency stopping pump', { pump: pumpNumber, error: error.message });
            throw error;
        }
    }

    /**
     * Get pump status
     */
    async getPumpStatus(pumpNumber) {
        try {
            const response = await this.ptsClient.createComplexRequest([{
                function: this.ptsClient.PumpGetStatus.bind(this.ptsClient),
                arguments: [pumpNumber]
            }]);

            if (response.Packets && response.Packets[0] && response.Packets[0].Data) {
                this.updatePumpStatus(pumpNumber, response.Packets[0].Data);
                return response.Packets[0].Data;
            }

            return null;
        } catch (error) {
            logger.error('Error getting pump status', { pump: pumpNumber, error: error.message });
            throw error;
        }
    }

    /**
     * Get all pump statuses (from cache)
     */
    getPumpStatuses() {
        const statuses = {};
        this.pumpStatuses.forEach((status, pumpNumber) => {
            statuses[pumpNumber] = status;
        });
        return statuses;
    }

    /**
     * Get tank statuses
     */
    getTankStatuses() {
        const statuses = {};
        this.tankStatuses.forEach((status, tankNumber) => {
            statuses[tankNumber] = status;
        });
        return statuses;
    }

    /**
     * Get pump totals
     */
    async getPumpTotals(pumpNumber, nozzleNumber) {
        try {
            const response = await this.ptsClient.createComplexRequest([{
                function: this.ptsClient.PumpGetTotals.bind(this.ptsClient),
                arguments: [pumpNumber, nozzleNumber]
            }]);

            if (response.Packets && response.Packets[0] && response.Packets[0].Data) {
                return response.Packets[0].Data;
            }

            return null;
        } catch (error) {
            logger.error('Error getting pump totals', { pump: pumpNumber, nozzle: nozzleNumber, error: error.message });
            throw error;
        }
    }

    /**
     * Set pump prices
     */
    async setPumpPrices(pumpNumber, prices) {
        try {
            logger.info('Setting pump prices', { pump: pumpNumber, prices });

            // Ensure prices is an array
            const pricesArray = Array.isArray(prices) ? prices : [prices];

            const response = await this.ptsClient.createComplexRequest([{
                function: this.ptsClient.PumpSetPrices.bind(this.ptsClient),
                arguments: [pumpNumber, pricesArray]
            }]);

            if (response.Packets && response.Packets[0]) {
                if (response.Packets[0].Error === true) {
                    throw new Error(response.Packets[0].Message || 'Set prices failed');
                }
                return response.Packets[0].Data;
            }

            throw new Error('Invalid response from PTS controller');
        } catch (error) {
            logger.error('Error setting pump prices', { pump: pumpNumber, error: error.message });
            throw error;
        }
    }

    /**
     * Get pump prices
     */
    async getPumpPrices(pumpNumber) {
        try {
            const response = await this.ptsClient.createComplexRequest([{
                function: this.ptsClient.PumpGetPrices.bind(this.ptsClient),
                arguments: [pumpNumber]
            }]);

            if (response.Packets && response.Packets[0] && response.Packets[0].Data) {
                return response.Packets[0].Data;
            }

            return null;
        } catch (error) {
            logger.error('Error getting pump prices', { pump: pumpNumber, error: error.message });
            throw error;
        }
    }

    /**
     * Configure which pumps to poll
     */
    setPumpsToPoll(pumpNumbers) {
        this.pumpsToPoll = Array.isArray(pumpNumbers) ? pumpNumbers : [pumpNumbers];
        logger.info('Updated pumps to poll', { pumps: this.pumpsToPoll });
    }

    /**
     * Set which probes to poll
     */
    setProbesToPoll(probeNumbers) {
        this.probesToPoll = Array.isArray(probeNumbers) ? probeNumbers : [probeNumbers];
        logger.info('Updated probes to poll', { probes: this.probesToPoll });
    }

    /**
     * Get list of configured pumps (discovered)
     */
    getConfiguredPumps() {
        return Array.from(this.configuredPumps);
    }

    /**
     * Get list of configured probes (discovered)
     */
    getConfiguredProbes() {
        return Array.from(this.configuredProbes);
    }
}

module.exports = FuelService;

