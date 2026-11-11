/**
 * fix-station-identity.js — repoint a station database from its placeholder
 * identity onto the real company/station UUIDs from the .env.
 *
 * Stations set up from setup-db-complete.sql get a single placeholder company
 * ("SET_COMPANY_NAME") and station ("SET_STATION_NAME") with generated UUIDs.
 * Everything registered afterwards — attendants, RFID tags, readers, users —
 * carries those placeholder ids. The moment OFFLINE_STATION_ID in the .env is
 * corrected to the station's real id, every station-scoped lookup stops
 * matching. RFID taps are denied, because lookupAttendant() filters on
 * `t.station_id = $2`.
 *
 * This copies the placeholder rows onto the real ids, repoints every table that
 * carries a station_id/company_id, and leaves the placeholders in place (harmless,
 * and a rollback path).
 *
 *   node scripts/fix-station-identity.js           # report only
 *   node scripts/fix-station-identity.js --apply   # do it
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { Pool } = require('pg');

const APPLY = process.argv.includes('--apply');

const NEW_COMPANY = process.env.OFFLINE_COMPANY_ID;
const NEW_STATION = process.env.OFFLINE_STATION_ID;
const STATION_NAME = process.env.STATION_NAME || 'Station';

if (!NEW_COMPANY || !NEW_STATION) {
  console.error('OFFLINE_COMPANY_ID / OFFLINE_STATION_ID missing from .env');
  process.exit(1);
}

const pool = new Pool({
  host: process.env.LOCAL_DB_HOST,
  port: process.env.LOCAL_DB_PORT,
  database: process.env.LOCAL_DB_NAME,
  user: process.env.LOCAL_DB_USER,
  password: process.env.LOCAL_DB_PASSWORD,
});

const q = (n) => '"' + n + '"';

async function columnsOf(client, table) {
  const r = await client.query(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = $1
      ORDER BY ordinal_position`, [table]);
  return r.rows.map((x) => x.column_name);
}

/** Clone one row, overriding some columns. Avoids guessing NOT NULL columns. */
async function cloneRow(client, table, fromId, overrides) {
  const cols = await columnsOf(client, table);
  const params = [fromId];
  const select = cols.map((c) => {
    if (Object.prototype.hasOwnProperty.call(overrides, c)) {
      params.push(overrides[c]);
      return '$' + params.length;
    }
    return q(c);
  });
  await client.query(
    `INSERT INTO ${q(table)} (${cols.map(q).join(', ')})
     SELECT ${select.join(', ')} FROM ${q(table)} WHERE id = $1
     ON CONFLICT (id) DO NOTHING`, params);
}

async function tablesWith(client, column) {
  const r = await client.query(
    `SELECT table_name FROM information_schema.columns
      WHERE table_schema = 'public' AND column_name = $1
      ORDER BY table_name`, [column]);
  return r.rows.map((x) => x.table_name);
}

(async () => {
  const client = await pool.connect();
  try {
    // Never hold a lock on a trading station. The 2026-08-18 Shaan outage was an
    // unbounded ALTER TABLE queueing behind live fills.
    await client.query("SET lock_timeout = '5s'");
    await client.query("SET statement_timeout = '30s'");

    const comp = await client.query('SELECT id, name FROM companies');
    const stat = await client.query('SELECT id, company_id, name FROM stations');

    const oldCompany = comp.rows.find((r) => r.id !== NEW_COMPANY)?.id;
    const oldStation = stat.rows.find((r) => r.id !== NEW_STATION)?.id;

    console.log('');
    console.log('  current company : ' + (oldCompany || '(none)'));
    console.log('  current station : ' + (oldStation || '(none)'));
    console.log('  target  company : ' + NEW_COMPANY);
    console.log('  target  station : ' + NEW_STATION);
    console.log('');

    if (comp.rows.some((r) => r.id === NEW_COMPANY) &&
        stat.rows.some((r) => r.id === NEW_STATION) && !oldStation) {
      console.log('  Already on the real identity. Nothing to do.');
      return;
    }
    if (!oldCompany || !oldStation) {
      console.log('  Could not identify the placeholder rows — stopping.');
      return;
    }

    const stationTables = await tablesWith(client, 'station_id');
    const companyTables = await tablesWith(client, 'company_id');

    // Count what would move, per table.
    const plan = [];
    for (const t of stationTables) {
      const r = await client.query(
        `SELECT COUNT(*)::int c FROM ${q(t)} WHERE station_id = $1`, [oldStation]);
      if (r.rows[0].c) plan.push([t, 'station_id', r.rows[0].c]);
    }
    for (const t of companyTables) {
      const r = await client.query(
        `SELECT COUNT(*)::int c FROM ${q(t)} WHERE company_id = $1`, [oldCompany]);
      if (r.rows[0].c) plan.push([t, 'company_id', r.rows[0].c]);
    }

    console.log('  rows to repoint:');
    plan.forEach(([t, c, n]) => console.log('    ' + t.padEnd(28) + c.padEnd(12) + n));
    console.log('');

    if (!APPLY) {
      console.log('  CHECK ONLY — re-run with --apply to make these changes.');
      return;
    }

    await client.query('BEGIN');

    // Parents first: the real company, then the real station referencing it.
    await cloneRow(client, 'companies', oldCompany, { id: NEW_COMPANY });
    await cloneRow(client, 'stations', oldStation, {
      id: NEW_STATION, company_id: NEW_COMPANY, name: STATION_NAME,
    });
    console.log('  + companies/stations rows for the real identity');

    // Children. stations.company_id is handled by the clone above; skip it here
    // so we do not drag the placeholder station onto the real company.
    for (const [t, col] of plan.map(([t, c]) => [t, c])) {
      if (t === 'stations' && col === 'company_id') continue;
      if (t === 'companies' || (t === 'stations' && col === 'id')) continue;
      const oldVal = col === 'station_id' ? oldStation : oldCompany;
      const newVal = col === 'station_id' ? NEW_STATION : NEW_COMPANY;
      const r = await client.query(
        `UPDATE ${q(t)} SET ${q(col)} = $1 WHERE ${q(col)} = $2`, [newVal, oldVal]);
      console.log('  ~ ' + t.padEnd(28) + col.padEnd(12) + r.rowCount);
    }

    await client.query('COMMIT');
    console.log('');
    console.log('  Done. Restart the station server so it reloads readers and tags.');
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    console.error('');
    console.error('  FAILED: ' + e.message);
    console.error('  Nothing was changed.');
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
})();
