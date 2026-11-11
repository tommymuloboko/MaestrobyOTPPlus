/**
 * Bring an EMPTY or PARTIAL local database up to the full station schema.
 *
 * Written for a station-PC swap: the server was copied to the new machine and a
 * blank "maestroroma" database was created, but the schema was never applied, so
 * the service started and then failed on nearly every table it touched.
 *
 * Runs, in order:
 *   1. setup-db-complete.sql  — 71 tables, 20 indexes, all guarded with
 *      IF NOT EXISTS, no DROPs. Safe over a partially-created database.
 *   2. tank_measurements      — defined here because it exists in NO sql file or
 *      script in this copy, yet the PTS polling service writes to it every cycle.
 *
 * Uses the app's own database config, so there are no credentials to type and it
 * cannot be pointed at the wrong database by accident.
 *
 *   node scripts/apply-full-schema.js            # report what is missing, change nothing
 *   node scripts/apply-full-schema.js --apply    # create it
 */

const path = require('path');

// MUST come before requiring utils/database: that module builds its pool config
// from process.env at load time, and only index.js calls dotenv normally. Without
// this the script would silently connect with libpq defaults instead of the
// station's configured database.
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const fs = require('fs');
const database = require('../utils/database');

const APPLY = process.argv.includes('--apply');

/**
 * Every table the running services actually touch. Checked after the run so the
 * result is "is the server able to work now", not "did the SQL file execute".
 */
const REQUIRED = [
  'companies', 'stations', 'pumps', 'tanks', 'users', 'roles', 'user_roles',
  'attendants', 'attendant_shifts', 'attendant_tags',
  'shifts', 'shift_attendants', 'shift_cashup', 'shift_close_declarations',
  'fuel_transactions_raw', 'fuel_transactions_verified',
  'pts_sales', 'pts_sales_records', 'pump_report_transactions',
  'tank_measurements', 'tank_readings',
  'rfid_readers', 'rfid_tags', 'rfid_transactions', 'rfid_authorizations',
  'rfid_reader_pumps',
  'drivers', 'debtors', 'debtor_vehicles', 'debtor_transactions',
  'price_change_log', 'audit_log', 'sync_queue', 'pending_transactions',
  'station_settings',
  // Forecourt tables carried over from Maestro POS (setup-db-complete.sql, STEP 12).
  'fuel_pump_items', 'fuel_sales', 'fuel_clearings', 'fuel_nozzles', 'fuel_pump_events',
  'fuel_faults', 'fuel_readings', 'fuel_attendant_sessions', 'fuel_pump_tags',
  'fuel_payments', 'fuel_idem', 'fuel_provider_records', 'fuel_deposits', 'fuel_vouchers',
  'fuel_vehicles', 'fuel_contract_prices', 'fuel_otps', 'fuel_cash_moves',
  'fuel_deliveries', 'fuel_price_changes', 'fuel_price_history', 'fuel_cost_history',
  'fuel_lpg', 'fuel_lpg_moves', 'fuel_issues', 'fuel_targets', 'fuel_account_flags',
  'fuel_delivery_checks', 'fuel_recon_notes', 'fuel_delivery_invoices',
  'fuel_calibration_log',
];

// Not in any sql file in this copy, but pts-polling.service.js writes to it.
const TANK_MEASUREMENTS_DDL = `
CREATE TABLE IF NOT EXISTS public.tank_measurements (
  id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
  station_id uuid,
  pts2_tank_id integer NOT NULL,
  date_time timestamp with time zone NOT NULL,
  fuel_grade_id integer,
  fuel_grade_name text,
  status text,
  alarms jsonb,
  product_height numeric,
  water_height numeric,
  temperature numeric,
  product_volume numeric,
  water_volume numeric,
  product_ullage numeric,
  tank_filling_percentage numeric,
  recorded_at timestamp with time zone DEFAULT now() NOT NULL,
  synced boolean DEFAULT false,
  synced_at timestamp with time zone,
  CONSTRAINT tank_measurements_unique_tank_time UNIQUE (pts2_tank_id, date_time)
)`;

/**
 * Column spec per table, read out of setup-db-complete.sql.
 *
 * Needed because CREATE TABLE IF NOT EXISTS is silent about a table that already
 * exists with the WRONG shape. rfid_readers on this station is exactly that: the
 * table is present but has no device_address, so the RFID service fails on every
 * read and the schema file alone would never fix it.
 *
 * NOT NULL is stripped from every definition. A NOT NULL column cannot be added
 * to a table that already holds rows unless it has a default, and the app does
 * not rely on the constraint — getting the column there is what matters.
 */
function parseColumnSpec(sql) {
  const spec = {};
  const re = /CREATE TABLE IF NOT EXISTS public\."?([a-z_]+)"?\s*\(([\s\S]*?)\n\);/gi;
  let m;
  while ((m = re.exec(sql)) !== null) {
    const cols = [];
    for (let line of m[2].split('\n')) {
      line = line.trim().replace(/,$/, '');
      if (!line || line.startsWith('--')) continue;
      if (/^(CONSTRAINT|PRIMARY|UNIQUE|FOREIGN|CHECK)/i.test(line)) continue;
      const cm = line.match(/^"([a-z_]+)"\s+(.+)$/i);
      if (cm) {
        cols.push({
          name: cm[1],
          def: cm[2].replace(/,$/, '').replace(/\s+NOT NULL/gi, '').trim(),
        });
      }
    }
    spec[m[1]] = cols;
  }
  return spec;
}

/**
 * PRIMARY KEY / UNIQUE constraints per table, from the same SQL file.
 *
 * Columns were not the only thing CREATE TABLE IF NOT EXISTS skipped on tables
 * that already existed — constraints were skipped too. rfid_readers came out of
 * that with no UNIQUE (ip_address, port), so every upsert against it failed with
 * "no unique or exclusion constraint matching the ON CONFLICT specification",
 * including the one in POST /api/rfid/readers.
 */
function parseConstraintSpec(sql) {
  const spec = {};
  const re = /CREATE TABLE IF NOT EXISTS public\."?([a-z_]+)"?\s*\(([\s\S]*?)\n\);/gi;
  let m;
  while ((m = re.exec(sql)) !== null) {
    const list = [];
    for (let line of m[2].split('\n')) {
      line = line.trim().replace(/,$/, '');
      const cm = line.match(/^CONSTRAINT\s+([a-z_0-9]+)\s+(PRIMARY KEY|UNIQUE)\s*\(([^)]+)\)/i);
      if (cm) {
        list.push({
          name: cm[1],
          type: cm[2].toUpperCase(),
          cols: cm[3].split(',').map((c) => c.trim().replace(/"/g, '').toLowerCase()),
        });
      }
    }
    spec[m[1]] = list;
  }
  return spec;
}

/** Existing PK/UNIQUE constraints on a table, as sorted column-name lists. */
async function constraintsOf(table) {
  const { rows } = await database.queryLocal(
    `SELECT con.conname, con.contype,
            array_agg(att.attname::text ORDER BY u.ord) AS cols
       FROM pg_constraint con
       JOIN pg_class     rel ON rel.oid = con.conrelid
       JOIN pg_namespace ns  ON ns.oid = rel.relnamespace
       CROSS JOIN LATERAL unnest(con.conkey) WITH ORDINALITY AS u(attnum, ord)
       JOIN pg_attribute att ON att.attrelid = rel.oid AND att.attnum = u.attnum
      WHERE ns.nspname = 'public' AND rel.relname = $1 AND con.contype IN ('p','u')
      GROUP BY con.conname, con.contype`,
    [table]
  );
  // Compare by column SET, not by name: an equivalent constraint under a
  // different name is fine and must not be duplicated.
  return rows.map((r) => ({
    name: r.conname,
    type: r.contype === 'p' ? 'PRIMARY KEY' : 'UNIQUE',
    key: [...r.cols].map((c) => c.toLowerCase()).sort().join(','),
  }));
}

async function columnsOf(table) {
  const { rows } = await database.queryLocal(
    `SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = $1`, [table]
  );
  return new Set(rows.map((r) => r.column_name));
}

async function existingTables() {
  const { rows } = await database.queryLocal(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema = 'public' AND table_type = 'BASE TABLE'`
  );
  return new Set(rows.map((r) => r.table_name));
}

async function main() {
  const dbName = process.env.LOCAL_DB_NAME || '(from config)';
  console.log(`\nDatabase: ${dbName}`);
  console.log(APPLY ? 'Mode: APPLY\n' : 'Mode: CHECK ONLY (add --apply to create)\n');

  const sqlPath = path.join(__dirname, '..', 'setup-db-complete.sql');
  if (!fs.existsSync(sqlPath)) {
    throw new Error(`setup-db-complete.sql not found at ${sqlPath}`);
  }
  const sql = fs.readFileSync(sqlPath, 'utf8');
  const spec = parseColumnSpec(sql);
  const conSpec = parseConstraintSpec(sql);

  const before = await existingTables();
  const missingBefore = REQUIRED.filter((t) => !before.has(t));

  // Tables that exist but are missing columns. CREATE TABLE IF NOT EXISTS will
  // not touch these, so without this pass they stay broken after a "successful"
  // run — which is what happened to rfid_readers.device_address here.
  const columnGaps = [];
  for (const table of Object.keys(spec)) {
    if (!before.has(table)) continue;
    const have = await columnsOf(table);
    const missing = spec[table].filter((c) => !have.has(c.name));
    if (missing.length) columnGaps.push({ table, missing });
  }

  // Same story for constraints — skipped on tables that already existed.
  const constraintGaps = [];
  for (const table of Object.keys(conSpec)) {
    if (!before.has(table)) continue;
    const have = await constraintsOf(table);
    const haveKeys = new Set(have.map((c) => `${c.type}:${c.key}`));
    const missing = conSpec[table].filter(
      (c) => !haveKeys.has(`${c.type}:${[...c.cols].sort().join(',')}`)
    );
    if (missing.length) constraintGaps.push({ table, missing });
  }

  console.log(`Tables present  : ${before.size}`);
  console.log(`Required missing: ${missingBefore.length}`);
  if (missingBefore.length) console.log(`  ${missingBefore.join(', ')}\n`);

  if (columnGaps.length) {
    console.log('Existing tables missing columns:');
    for (const g of columnGaps) {
      console.log(`  ${g.table}: ${g.missing.map((c) => c.name).join(', ')}`);
    }
    console.log('');
  }

  if (constraintGaps.length) {
    console.log('Existing tables missing constraints:');
    for (const g of constraintGaps) {
      for (const c of g.missing) {
        console.log(`  ${g.table}: ${c.type} (${c.cols.join(', ')})`);
      }
    }
    console.log('');
  }

  const nothingToDo =
    missingBefore.length === 0 && columnGaps.length === 0 && constraintGaps.length === 0;

  if (!APPLY) {
    console.log(nothingToDo ? 'Nothing to do — schema is complete.' : 'Re-run with --apply to fix.');
    return;
  }

  if (nothingToDo) {
    console.log('Schema already complete. Nothing to do.');
    return;
  }

  // --- 1. the main schema file -------------------------------------------
  console.log('Applying setup-db-complete.sql ...');

  // One statement at a time: a single failure (an index on a column this
  // install does not have, say) must not abort the other 39 tables.
  // Strip LEADING comment lines from each chunk rather than discarding chunks
  // that start with one. Most tables in this file sit under a "-- STEP n:"
  // banner, so dropping comment-led chunks silently threw away 9 of the 40
  // CREATE TABLE statements — the failure mode being guarded against here.
  const statements = sql
    .split(/;\s*[\r\n]/)
    .map((s) => s.replace(/^(?:[ \t]*--[^\n]*\r?\n)+/, '').trim())
    .filter(Boolean);

  let ok = 0, failed = 0;
  for (const stmt of statements) {
    try {
      await database.queryLocal(stmt);
      ok++;
    } catch (e) {
      failed++;
      console.warn(`  ! ${e.message}`);
      console.warn(`    in: ${stmt.slice(0, 80).replace(/\s+/g, ' ')}...`);
    }
  }
  console.log(`  ${ok} statements applied, ${failed} failed\n`);

  // --- 2. tank_measurements ----------------------------------------------
  console.log('Creating tank_measurements ...');
  try {
    await database.queryLocal(TANK_MEASUREMENTS_DDL);
    console.log('  done\n');
  } catch (e) {
    console.error(`  FAILED: ${e.message}\n`);
  }

  // --- 2b. indexes the CODE depends on but no SQL file creates -------------
  //
  // pts-polling.service.js stores every completed fill with
  //   ON CONFLICT (station_id, pump_id, transaction_id) DO NOTHING
  // which Postgres refuses outright unless a UNIQUE index covers exactly those
  // columns: "there is no unique or exclusion constraint matching the ON
  // CONFLICT specification". setup-db-complete.sql never defined one, so at
  // Shaan on 2026-08-18 every single fill threw and fell through to the parking
  // table — the table had held zero rows for the life of the station.
  //
  // The clause is right: the poller reports a finished fill on two consecutive
  // cycles, so each one is stored twice and the index is what de-duplicates it.
  // The index was the missing half, not the clause.
  console.log('Ensuring code-required indexes ...');
  const REQUIRED_INDEXES = [
    ['fuel_transactions_raw_station_pump_txn_key',
     `CREATE UNIQUE INDEX IF NOT EXISTS fuel_transactions_raw_station_pump_txn_key
        ON public.fuel_transactions_raw (station_id, pump_id, transaction_id)`],
  ];
  for (const [name, ddl] of REQUIRED_INDEXES) {
    try {
      await database.queryLocal(ddl);
      console.log(`  ok  ${name}`);
    } catch (e) {
      // A duplicate-key failure here means the table already holds rows that
      // violate uniqueness — worth seeing rather than swallowing.
      console.error(`  !   ${name}: ${e.message}`);
    }
  }
  console.log('');

  // --- 3. columns on tables that already existed --------------------------
  if (columnGaps.length) {
    console.log('Adding missing columns to existing tables ...');
    let added = 0;
    for (const gap of columnGaps) {
      for (const col of gap.missing) {
        try {
          await database.queryLocal(
            `ALTER TABLE public."${gap.table}" ADD COLUMN IF NOT EXISTS "${col.name}" ${col.def}`
          );
          console.log(`  + ${gap.table}.${col.name}`);
          added++;
        } catch (e) {
          console.warn(`  ! ${gap.table}.${col.name}: ${e.message}`);
        }
      }
    }
    console.log(`  ${added} columns added\n`);
  }

  // --- 3b. constraints on tables that already existed ---------------------
  if (constraintGaps.length) {
    console.log('Adding missing constraints ...');
    let added = 0;
    for (const gap of constraintGaps) {
      for (const c of gap.missing) {
        const cols = c.cols.map((x) => `"${x}"`).join(', ');
        try {
          await database.queryLocal(
            `ALTER TABLE public."${gap.table}" ADD CONSTRAINT "${c.name}" ${c.type} (${cols})`
          );
          console.log(`  + ${gap.table}: ${c.type} (${c.cols.join(', ')})`);
          added++;
        } catch (e) {
          // Most likely cause is duplicate rows already in the table. Say so
          // plainly — it needs a human decision, not a retry.
          console.warn(`  ! ${gap.table}: ${c.type} (${c.cols.join(', ')}) — ${e.message}`);
        }
      }
    }
    console.log(`  ${added} constraints added\n`);
  }

  // --- 4. verify ----------------------------------------------------------
  const after = await existingTables();
  const stillMissing = REQUIRED.filter((t) => !after.has(t));

  const stillGaps = [];
  for (const table of Object.keys(spec)) {
    if (!after.has(table)) continue;
    const have = await columnsOf(table);
    const missing = spec[table].filter((c) => !have.has(c.name)).map((c) => c.name);
    if (missing.length) stillGaps.push(`${table}(${missing.join(',')})`);
  }

  const stillCon = [];
  for (const table of Object.keys(conSpec)) {
    if (!after.has(table)) continue;
    const have = await constraintsOf(table);
    const haveKeys = new Set(have.map((c) => `${c.type}:${c.key}`));
    const missing = conSpec[table].filter(
      (c) => !haveKeys.has(`${c.type}:${[...c.cols].sort().join(',')}`)
    );
    if (missing.length) stillCon.push(`${table}(${missing.map((c) => c.cols.join('+')).join(' ')})`);
  }

  console.log('-- Result --');
  console.log(`  tables now present : ${after.size}`);
  console.log(`  created this run   : ${after.size - before.size}`);
  console.log(`  tables missing     : ${stillMissing.length ? stillMissing.join(', ') : 'none'}`);
  console.log(`  columns missing    : ${stillGaps.length ? stillGaps.join(', ') : 'none'}`);
  console.log(`  constraints missing: ${stillCon.length ? stillCon.join(', ') : 'none'}\n`);

  if (stillMissing.length === 0 && stillGaps.length === 0 && stillCon.length === 0) {
    console.log('Schema is complete. Restart the server.');
  } else {
    console.log('Something did not get created — send this output before restarting.');
    process.exitCode = 1;
  }
}

main()
  .catch((e) => { console.error('\nFailed:', e.message); process.exitCode = 1; })
  .finally(() => database.close());
