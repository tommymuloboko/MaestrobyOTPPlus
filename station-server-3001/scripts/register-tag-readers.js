/**
 * Register the forecourt RFID tag readers.
 *
 * One reader per pump, each on its own IP. Edit the READERS table below for a
 * different station — it is the only thing that changes.
 *
 *   node scripts/register-tag-readers.js           # show what would change
 *   node scripts/register-tag-readers.js --apply   # write it
 *
 * Idempotent: keyed on the (ip_address, port) unique constraint, so re-running
 * corrects drift instead of creating duplicates or failing.
 *
 * Note pump_ids, plural. services/rfid-reader.service.js reads the integer ARRAY
 * column, not the singular pump_id (a leftover from an earlier 1:1 schema). A
 * reader registered with only pump_id set loads with an empty pump list and
 * silently attributes scans to nothing.
 */

const path = require('path');

// Before utils/database — it reads process.env at load time.
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const database = require('../utils/database');

const APPLY = process.argv.includes('--apply');

const PORT = 9761;

/** pump number -> reader IP */
const READERS = [
  { pump: 1, ip: '192.168.1.45' },
  { pump: 2, ip: '192.168.1.46' },
  { pump: 3, ip: '192.168.1.47' },
  { pump: 4, ip: '192.168.1.48' },
  { pump: 5, ip: '192.168.1.49' },
  { pump: 6, ip: '192.168.1.50' },
];

const COMPANY_ID = process.env.OFFLINE_COMPANY_ID || process.env.COMPANY_ID;
const STATION_ID = process.env.OFFLINE_STATION_ID || process.env.STATION_ID;

async function main() {
  if (!COMPANY_ID || !STATION_ID) {
    throw new Error('OFFLINE_COMPANY_ID / OFFLINE_STATION_ID not set in .env');
  }

  console.log(`\nStation : ${process.env.STATION_NAME || STATION_ID}`);
  console.log(`Readers : ${READERS.length} on port ${PORT}`);
  console.log(APPLY ? 'Mode    : APPLY\n' : 'Mode    : DRY RUN (add --apply to write)\n');

  // The server adds this at boot, but the script must not depend on the server
  // having been started first.
  if (APPLY) {
    await database.queryLocal(
      `ALTER TABLE rfid_readers ADD COLUMN IF NOT EXISTS purpose VARCHAR(20) DEFAULT 'pump'`
    );
  }

  const existing = await database.queryLocal(
    `SELECT reader_id, reader_name, ip_address, port, pump_ids, is_active
       FROM rfid_readers ORDER BY reader_id`
  );
  console.log(`Currently registered: ${existing.rows.length}`);
  for (const r of existing.rows) {
    console.log(`  #${r.reader_id} ${r.reader_name} ${r.ip_address}:${r.port} `
              + `pumps[${(r.pump_ids || []).join(',')}] active=${r.is_active}`);
  }
  console.log('');

  if (!APPLY) {
    for (const r of READERS) {
      const match = existing.rows.find((e) => e.ip_address === r.ip && e.port === PORT);
      console.log(`  ${match ? 'update' : 'create'}  Pump ${r.pump} Reader  ${r.ip}:${PORT}  pumps[${r.pump}]`);
    }
    console.log('\nRe-run with --apply to write.');
    return;
  }

  for (const r of READERS) {
    // ON CONFLICT on the (ip_address, port) unique constraint. Updating rather
    // than skipping means a reader moved to a different pump is corrected.
    const res = await database.queryLocal(
      `INSERT INTO rfid_readers
         (company_id, station_id, reader_name, ip_address, port, device_address,
          pump_ids, pump_id, location, purpose, is_active)
       VALUES ($1, $2, $3, $4, $5, 0, $6::int[], $7, $8, 'pump', true)
       ON CONFLICT (ip_address, port) DO UPDATE SET
         company_id   = EXCLUDED.company_id,
         station_id   = EXCLUDED.station_id,
         reader_name  = EXCLUDED.reader_name,
         pump_ids     = EXCLUDED.pump_ids,
         pump_id      = EXCLUDED.pump_id,
         location     = EXCLUDED.location,
         purpose      = EXCLUDED.purpose,
         is_active    = true,
         updated_at   = now()
       RETURNING reader_id, (xmax = 0) AS inserted`,
      [
        COMPANY_ID, STATION_ID,
        `Pump ${r.pump} Reader`,
        r.ip, PORT,
        [r.pump],          // pump_ids — the column the service actually reads
        r.pump,            // pump_id  — kept in step for older queries
        `Pump ${r.pump}`,
      ]
    );
    const row = res.rows[0];
    console.log(`  ${row.inserted ? 'created' : 'updated'}  #${row.reader_id}  Pump ${r.pump}  ${r.ip}:${PORT}`);
  }

  // --- verify -------------------------------------------------------------
  // Re-read through the SAME query shape the service uses at boot, so this
  // proves the service will load them, not merely that rows exist.
  const check = await database.queryLocal(
    `SELECT reader_id, reader_name, ip_address, port, device_address, pump_ids,
            COALESCE(purpose, 'pump') AS purpose
       FROM rfid_readers
      WHERE is_active = true
      ORDER BY reader_id`
  );

  console.log('\n-- As the service will load them --');
  let bad = 0;
  for (const r of check.rows) {
    const pumps = r.pump_ids || [];
    if (pumps.length === 0) bad++;
    console.log(`  #${String(r.reader_id).padEnd(3)} ${r.reader_name.padEnd(16)} `
              + `${r.ip_address}:${r.port}  pumps[${pumps.join(',')}]  ${r.purpose}`);
  }

  if (check.rows.length === READERS.length && bad === 0) {
    console.log(`\n${check.rows.length} readers active, all with a pump assigned.`);
    console.log('Restart the server, then scan a card to test.');
  } else {
    if (bad) console.log(`\n${bad} reader(s) have NO pump assigned — scans would be attributed to nothing.`);
    if (check.rows.length !== READERS.length) {
      console.log(`\nExpected ${READERS.length} active readers, found ${check.rows.length}.`);
      console.log('If there are extras from the old PC, deactivate them:');
      console.log("  UPDATE rfid_readers SET is_active = false WHERE ip_address NOT IN ("
                + READERS.map((r) => `'${r.ip}'`).join(',') + ');');
    }
    process.exitCode = 1;
  }
}

main()
  .catch((e) => { console.error('\nFailed:', e.message); process.exitCode = 1; })
  .finally(() => database.close());
