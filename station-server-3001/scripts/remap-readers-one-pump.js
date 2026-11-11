/**
 * Sapphire Lusaka Depot - remap tag readers to ONE pump each.
 *
 * Plan change: originally two readers shared a pump-pair. Now each reader
 * authorizes exactly one pump. 6 readers -> 6 pumps, 1:1.
 *
 *   node scripts/remap-readers-one-pump.js           # show what would change
 *   node scripts/remap-readers-one-pump.js --apply   # write it
 *
 * Idempotent: keyed on the (ip_address, port) unique constraint, so re-running
 * corrects drift instead of creating duplicates. Also re-asserts purpose='pump'
 * and is_active=true, so it restores any reader left in enrollment / inactive.
 *
 * If your physical layout differs (e.g. the reader at .200 actually stands at
 * pump 2), edit the `pump` values in READERS below and re-run --apply.
 */

const path = require('path');

// Before utils/database - it reads process.env at load time.
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const database = require('../utils/database');

const APPLY = process.argv.includes('--apply');

const PORT = 8080;

/** reader IP -> the single pump it authorizes */
const READERS = [
  { pump: 1, ip: '192.168.1.200' },
  { pump: 2, ip: '192.168.1.201' },
  { pump: 3, ip: '192.168.1.202' },
  { pump: 4, ip: '192.168.1.203' },
  { pump: 5, ip: '192.168.1.204' },
  { pump: 6, ip: '192.168.1.205' },
];

const COMPANY_ID = process.env.OFFLINE_COMPANY_ID || process.env.COMPANY_ID;
const STATION_ID = process.env.OFFLINE_STATION_ID || process.env.STATION_ID;

async function main() {
  if (!COMPANY_ID || !STATION_ID) {
    throw new Error('OFFLINE_COMPANY_ID / OFFLINE_STATION_ID not set in .env');
  }

  console.log(`\nStation : ${process.env.STATION_NAME || STATION_ID}`);
  console.log(`Readers : ${READERS.length} on port ${PORT} (1 pump each)`);
  console.log(APPLY ? 'Mode    : APPLY\n' : 'Mode    : DRY RUN (add --apply to write)\n');

  if (APPLY) {
    await database.queryLocal(
      `ALTER TABLE rfid_readers ADD COLUMN IF NOT EXISTS purpose VARCHAR(20) DEFAULT 'pump'`
    );
  }

  const existing = await database.queryLocal(
    `SELECT reader_id, reader_name, ip_address, port, pump_ids, purpose, is_active
       FROM rfid_readers ORDER BY ip_address`
  );
  console.log('Current readers:');
  for (const r of existing.rows) {
    console.log(`  ${r.ip_address}:${r.port}  ${(r.reader_name || '').padEnd(18)} `
              + `pumps[${(r.pump_ids || []).join(',')}]  ${r.purpose}  active=${r.is_active}`);
  }
  console.log('');

  if (!APPLY) {
    for (const r of READERS) {
      const match = existing.rows.find((e) => e.ip_address === r.ip && e.port === PORT);
      console.log(`  ${match ? 'update' : 'create'}  ${r.ip}:${PORT}  ->  pump [${r.pump}]`);
    }
    console.log('\nRe-run with --apply to write.');
    return;
  }

  for (const r of READERS) {
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
         purpose      = 'pump',
         is_active    = true,
         updated_at   = now()
       RETURNING reader_id, (xmax = 0) AS inserted`,
      [
        COMPANY_ID, STATION_ID,
        `Pump ${r.pump} Reader`,
        r.ip, PORT,
        [r.pump],          // pump_ids - the column the service actually reads
        r.pump,            // pump_id  - kept in step for older queries
        `Pump ${r.pump}`,
      ]
    );
    const row = res.rows[0];
    console.log(`  ${row.inserted ? 'created' : 'updated'}  #${row.reader_id}  ${r.ip}:${PORT}  ->  pump ${r.pump}`);
  }

  // Verify through the same query shape the service uses at boot.
  const check = await database.queryLocal(
    `SELECT reader_id, reader_name, ip_address, port, pump_ids,
            COALESCE(purpose, 'pump') AS purpose
       FROM rfid_readers
      WHERE is_active = true
      ORDER BY ip_address`
  );

  console.log('\n-- As the service will load them --');
  let bad = 0;
  for (const r of check.rows) {
    const pumps = r.pump_ids || [];
    if (pumps.length !== 1) bad++;
    console.log(`  #${String(r.reader_id).padEnd(3)} ${(r.reader_name || '').padEnd(16)} `
              + `${r.ip_address}:${r.port}  pumps[${pumps.join(',')}]  ${r.purpose}`);
  }

  if (check.rows.length === READERS.length && bad === 0) {
    console.log(`\n${check.rows.length} readers active, each with exactly one pump.`);
    console.log('Restart the server (pm2 restart maestro-lite), then scan a card to test.');
  } else {
    if (bad) console.log(`\n${bad} reader(s) do NOT have exactly one pump - check the mapping above.`);
    if (check.rows.length !== READERS.length) {
      console.log(`\nExpected ${READERS.length} active readers, found ${check.rows.length}.`);
    }
    process.exitCode = 1;
  }
}

main()
  .catch((e) => { console.error('\nFailed:', e.message); process.exitCode = 1; })
  .finally(() => database.close());
