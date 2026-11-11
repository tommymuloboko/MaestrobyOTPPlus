/**
 * Nozzle Totals Routes - Query nozzle totalisers on demand.
 *
 * Standalone, additive module. Does NOT modify the existing PTS routes.
 * Sends the PTS-2 `PumpGetTotals(pump, nozzle)` command and returns the
 * cumulative totaliser (volume + amount) read back from the controller's
 * asynchronous `PumpTotals` frame.
 *
 *   GET /api/pts/pumps/:pump/nozzles/:nozzle/totals   → one nozzle
 *   GET /api/pts/totals                               → all configured pumps/nozzles
 *
 * The PTS-2 does NOT support pump 0 ("all") for this command, so the "all"
 * route loops the configured pumps server-side.
 *
 * Mount (one line in index.js, alongside the other public PTS routes):
 *   app.use('/api/pts', require('./routes/nozzle-totals.routes')); // BEFORE authMiddleware
 */

const express = require('express');
const router = express.Router();
const ptsPollingService = require('../services/pts-polling.service');
const db = require('../utils/db');
const logger = require('../utils/logger')('NozzleTotals');

/** Grab the live PTS client, or null (caller returns 503). */
function getPtsClient() {
  const fuelService = ptsPollingService.fuelService;
  if (!fuelService || !fuelService.ptsClient) return null;
  return fuelService.ptsClient;
}

/**
 * Fire PumpGetTotals(pump, nozzle) and read back the async PumpTotals frame.
 * Purely on demand — drives its own status reads only while called; no
 * background/1s polling. Returns { ok, frame } or { ok:false, ... }.
 */
async function fetchNozzleTotals(ptsClient, pumpNumber, nozzleNumber) {
  const ack = await ptsClient.createComplexRequest([{
    function: ptsClient.PumpGetTotals.bind(ptsClient),
    arguments: [pumpNumber, nozzleNumber]
  }]);

  const packet = (ack && ack.Packets && ack.Packets[0]) ? ack.Packets[0] : null;
  if (!packet) return { ok: false, error: 'Empty response from PTS controller' };
  if (packet.Error === true) {
    return { ok: false, controllerError: packet.Message || 'Unknown packet error', code: packet.Code };
  }

  let lastType = packet.Type;
  for (let attempt = 0; attempt < 6; attempt++) {
    await new Promise(r => setTimeout(r, 250));
    const statusResp = await ptsClient.createComplexRequest([{
      function: ptsClient.PumpGetStatus.bind(ptsClient),
      arguments: [pumpNumber]
    }]);
    const sp = statusResp && statusResp.Packets && statusResp.Packets[0];
    if (sp && sp.Type === 'PumpTotals' && sp.Data) {
      return { ok: true, frame: sp.Data };
    }
    if (sp && sp.Type) lastType = sp.Type;
  }
  return { ok: false, error: 'No PumpTotals frame arrived in time', lastFrameType: lastType };
}

/**
 * Batched "all" fetch: fire EVERY (pump, nozzle) PumpGetTotals trigger in a
 * single complex request, then read back the async PumpTotals frames (also
 * batched — one status request covering every pump per attempt). On demand
 * only; no background polling.
 */
async function fetchBatchTotals(ptsClient, targets) {
  const framesByKey = new Map();
  const triggerErrors = [];

  // Process one NOZZLE INDEX per round, batched across pumps. This guarantees a
  // single pump is never asked for two nozzles at once (which the controller
  // rejects with PUMP_BUSY_OTHER_REQUEST_EXECUTED), while still batching the
  // work across different pumps in each round.
  const maxNozzle = targets.reduce((m, t) => Math.max(m, ...t.nozzles), 0);

  for (let nozzle = 1; nozzle <= maxNozzle; nozzle++) {
    const pumpsThisRound = targets.filter(t => t.nozzles.includes(nozzle)).map(t => t.pump);
    if (pumpsThisRound.length === 0) continue;

    // 1) Batch every pump's trigger for this nozzle in one request.
    const triggerCmds = pumpsThisRound.map(pump => ({
      function: ptsClient.PumpGetTotals.bind(ptsClient),
      arguments: [pump, nozzle]
    }));
    const ack = await ptsClient.createComplexRequest(triggerCmds);
    if (ack && Array.isArray(ack.Packets)) {
      ack.Packets.forEach((pk, i) => {
        if (pk && pk.Error === true) {
          triggerErrors.push({ pump: pumpsThisRound[i], nozzle, controllerError: pk.Message || 'packet error', code: pk.Code });
        }
      });
    }

    // 2) Read back this round's frames (status batched across the round's pumps).
    const statusCmds = pumpsThisRound.map(pump => ({
      function: ptsClient.PumpGetStatus.bind(ptsClient),
      arguments: [pump]
    }));
    const want = pumpsThisRound.length;
    let got = 0;
    for (let attempt = 0; attempt < 8 && got < want; attempt++) {
      await new Promise(r => setTimeout(r, 250));
      const statusResp = await ptsClient.createComplexRequest(statusCmds);
      const packets = (statusResp && statusResp.Packets) ? statusResp.Packets : [];
      for (const sp of packets) {
        // Match this round's nozzle so a leftover frame can't be miscounted.
        if (sp && sp.Type === 'PumpTotals' && sp.Data && sp.Data.Nozzle === nozzle) {
          const key = `${sp.Data.Pump}-${sp.Data.Nozzle}`;
          if (!framesByKey.has(key)) { framesByKey.set(key, sp.Data); got++; }
        }
      }
    }
  }

  return { frames: Array.from(framesByKey.values()), triggerErrors };
}

/**
 * Enrich totals rows with the LAST-DISPENSE attendant for each pump, joined
 * from fuel_transactions_raw → attendants. One query for all pumps; no extra
 * PTS calls. Returns a map: pumpId → { attendant, tag, lastAmount, lastTime, transaction }.
 */
async function lastDispenseByPump(pumpIds) {
  const stationId = process.env.OFFLINE_STATION_ID || process.env.STATION_ID || ptsPollingService.stationId;
  const byPump = {};
  if (!stationId || pumpIds.length === 0) return byPump;
  try {
    const r = await db.query(`
      SELECT DISTINCT ON (t.pump_id)
        t.pump_id,
        t.transaction_id,
        t.amount      AS last_amount,
        t.time        AS last_time,
        t.tag_number,
        COALESCE(a.full_name, t.full_name) AS attendant_name
      FROM fuel_transactions_raw t
      LEFT JOIN attendants a ON a.id = t.attendant_id
      WHERE t.station_id = $1 AND t.pump_id = ANY($2)
      ORDER BY t.pump_id, t.time DESC
    `, [stationId, pumpIds]);
    for (const row of r.rows) {
      byPump[row.pump_id] = {
        attendant: row.attendant_name ?? null,
        tag: row.tag_number ?? null,
        lastAmount: row.last_amount ?? null,
        lastTime: row.last_time ?? null,
        transaction: row.transaction_id ?? null
      };
    }
  } catch (e) {
    logger.error('Attendant enrichment failed', e);
  }
  return byPump;
}

/** Shape a raw PumpTotals frame into a clean totals object. */
function toTotals(f) {
  return {
    pump: f.Pump ?? null,
    nozzle: f.Nozzle ?? null,
    volume: f.Volume ?? null,
    amount: f.Amount ?? null,
    transaction: f.Transaction ?? null,
    fuelGrade: f.FuelGradeName ?? null
  };
}

/**
 * Work out which pumps/nozzles to query for the "all" route.
 * Discovery only — reads the live status cache to find configured pumps and
 * their priced nozzles. The totaliser values themselves still come from the
 * on-demand PumpGetTotals calls. Override with ?pumps=1,2,3&nozzles=1.
 */
function resolveTargets(req) {
  if (req.query.pumps) {
    const pumps = String(req.query.pumps).split(',')
      .map(s => parseInt(s, 10)).filter(n => Number.isInteger(n) && n > 0);
    const nozzles = req.query.nozzles
      ? String(req.query.nozzles).split(',').map(s => parseInt(s, 10)).filter(n => Number.isInteger(n) && n > 0)
      : [1];
    return pumps.map(p => ({ pump: p, nozzles }));
  }

  const all = ptsPollingService.getCachedPumpsStatus();
  const targets = [];
  for (const entry of (Array.isArray(all) ? all : [])) {
    const d = (entry && entry.Data) ? entry.Data : {};
    const pumpNo = d.Pump ?? entry.pump;
    if (!pumpNo) continue;

    // Configured nozzles = NozzlePrices indices with a non-zero price.
    let nozzles = [];
    if (Array.isArray(d.NozzlePrices)) {
      nozzles = d.NozzlePrices.map((p, i) => (p > 0 ? i + 1 : null)).filter(Boolean);
    }
    const active = nozzles.length > 0 || d.LastTransaction > 0 || d.LastTotalVolume > 0 || d.LastVolume > 0;
    if (!active) continue; // skip unconfigured/empty pumps

    if (nozzles.length === 0) nozzles = [d.LastNozzle && d.LastNozzle > 0 ? d.LastNozzle : 1];
    targets.push({ pump: pumpNo, nozzles });
  }
  return targets;
}

/**
 * @swagger
 * /api/pts/pumps/{pumpNumber}/nozzles/{nozzleNumber}/totals:
 *   get:
 *     tags: [PTS]
 *     summary: Get the live totaliser for ONE specific pump nozzle
 *     parameters:
 *       - in: path
 *         name: pumpNumber
 *         required: true
 *         schema: { type: integer }
 *       - in: path
 *         name: nozzleNumber
 *         required: true
 *         schema: { type: integer }
 *     responses:
 *       200: { description: Nozzle totaliser }
 */
router.get('/pumps/:pumpNumber/nozzles/:nozzleNumber/totals', async (req, res) => {
  try {
    const pumpNumber = parseInt(req.params.pumpNumber, 10);
    const nozzleNumber = parseInt(req.params.nozzleNumber, 10);
    if (!Number.isInteger(pumpNumber) || pumpNumber < 1 ||
        !Number.isInteger(nozzleNumber) || nozzleNumber < 1) {
      return res.status(400).json({ success: false, error: 'pumpNumber and nozzleNumber must be positive integers' });
    }

    const ptsClient = getPtsClient();
    if (!ptsClient) return res.status(503).json({ success: false, error: 'PTS service not running' });

    const result = await fetchNozzleTotals(ptsClient, pumpNumber, nozzleNumber);
    if (!result.ok) {
      const status = result.controllerError ? 404 : 504;
      return res.status(status).json({ success: false, pump: pumpNumber, nozzle: nozzleNumber, ...result });
    }

    res.json({
      success: true,
      timestamp: new Date().toISOString(),
      pump: pumpNumber,
      requestedNozzle: nozzleNumber,
      reportedNozzle: result.frame.Nozzle ?? null,
      totals: toTotals(result.frame),
      raw: result.frame
    });
  } catch (error) {
    logger.error('Error getting nozzle totals', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

/**
 * @swagger
 * /api/pts/totals:
 *   get:
 *     tags: [PTS]
 *     summary: Get live totalisers for ALL configured pumps/nozzles
 *     description: |
 *       Loops every configured pump/nozzle (discovered from live status, or via
 *       ?pumps=1,2,3&nozzles=1) and returns each nozzle's totaliser. The PTS-2
 *       does not support a single "all" command, so this fans out server-side.
 *     responses:
 *       200: { description: Array of nozzle totalisers }
 */
router.get('/totals', async (req, res) => {
  try {
    const ptsClient = getPtsClient();
    if (!ptsClient) return res.status(503).json({ success: false, error: 'PTS service not running' });

    const targets = resolveTargets(req);
    if (targets.length === 0) {
      return res.status(404).json({ success: false, error: 'No configured pumps found to query' });
    }

    // Triggers fire batched per nozzle-round, then frames are collected.
    const { frames, triggerErrors } = await fetchBatchTotals(ptsClient, targets);
    let data = frames.map(toTotals).sort((a, b) => (a.pump - b.pump) || (a.nozzle - b.nozzle));

    // Enrich each row with the last-dispense attendant/tag for its pump.
    const pumpIds = [...new Set(data.map(r => r.pump))];
    const byPump = await lastDispenseByPump(pumpIds);
    data = data.map(row => {
      const info = byPump[row.pump] || {};
      return {
        ...row,
        attendant: info.attendant ?? null,
        tag: info.tag ?? null,
        lastDispense: {
          amount: info.lastAmount ?? null,
          time: info.lastTime ?? null,
          transaction: info.transaction ?? null
        }
      };
    });

    res.json({
      success: true,
      timestamp: new Date().toISOString(),
      count: data.length,
      data,
      ...(triggerErrors.length ? { errors: triggerErrors } : {})
    });
  } catch (error) {
    logger.error('Error getting all nozzle totals', error);
    res.status(500).json({ success: false, error: error.message });
  }
});

module.exports = router;
