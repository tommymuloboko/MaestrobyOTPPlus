/**
 * Register attendants and their RFID tags on a fresh station database.
 *
 * Taken from Maestro Central's Attendants page for SURYA ROMA. Edit the ROSTER
 * below for a different station — it is the only thing that changes.
 *
 *   node scripts/register-attendants.js           # show what would change
 *   node scripts/register-attendants.js --apply   # write it
 *
 * A tag has to land in THREE places for the station to behave, which is the
 * whole reason this is a script and not one INSERT:
 *
 *   rfid_tags       the operational table. Both the physical card scan
 *                   (rfid-reader.service.js lookupAttendant) and the PTS tag
 *                   path (pts-polling.service.js) read this and nothing else.
 *                   A tag missing here does not attribute fuel to anyone.
 *   attendants      .tag_number is a legacy fallback still consulted by
 *                   pts-polling when the rfid_tags lookup misses.
 *   attendant_tags  the sync/reporting table. It is in offline-sync's
 *                   SYNC_TABLES, so this is what reaches HQ.
 *
 * Idempotent: re-running matches on (station, name) and (station, tag) rather
 * than blindly inserting, so nobody ends up with two records or two cards.
 */

const path = require('path');

// Before utils/database — it reads process.env at load time.
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const database = require('../utils/database');

const APPLY = process.argv.includes('--apply');

const COMPANY_ID = process.env.OFFLINE_COMPANY_ID || process.env.COMPANY_ID;
const STATION_ID = process.env.OFFLINE_STATION_ID || process.env.STATION_ID;
// Display name for this site. OFFLINE_SCOPE_MODE is an ENUM consumed by
// sync.service.js (none|company|station|both) and must NOT be reused as a label
// -- doing so both breaks scoping and names the company after the mode.
const STATION_NAME = process.env.STATION_NAME || process.env.OFFLINE_SCOPE_MODE_LABEL || 'Station';

/** full_name -> current tag number. Tags are stored and compared upper-case. */
const ROSTER = [
  { name: 'BEATRICE CHANDA',      tag: '580085D4' },
  { name: 'CATHERINE CHIYOKONIA', tag: '5800863B' },
  { name: 'DAVID MUMBI',          tag: '52002564' },
  { name: 'GRACE MUBANGA',        tag: '5800867A' },
  { name: 'ISAIAH MUNYONA',       tag: '5800856C' },
  { name: 'JOHN KALUWE',          tag: '58008650' },
  { name: 'LAWRENCE MAKEKA',      tag: '58008554' },
  { name: 'LOVENESS KUNDA',       tag: '58008591' },
  { name: 'PETER KATEBE',         tag: '58008563' },
  { name: 'THANDIWE MUKUWA',      tag: '58008678' },
];

async function main() {
  if (!COMPANY_ID || !STATION_ID) {
    throw new Error('OFFLINE_COMPANY_ID / OFFLINE_STATION_ID not set in .env');
  }

  // Two people cannot share a card, and one person cannot hold two in this
  // roster. Catch a typo here rather than after it is in the database.
  const dupTags = ROSTER.map((r) => r.tag.toUpperCase())
    .filter((t, i, a) => a.indexOf(t) !== i);
  const dupNames = ROSTER.map((r) => r.name).filter((n, i, a) => a.indexOf(n) !== i);
  if (dupTags.length) throw new Error(`Duplicate tag(s) in roster: ${[...new Set(dupTags)].join(', ')}`);
  if (dupNames.length) throw new Error(`Duplicate name(s) in roster: ${[...new Set(dupNames)].join(', ')}`);

  console.log(`\nStation : ${STATION_NAME}`);
  console.log(`Roster  : ${ROSTER.length} attendants`);
  console.log(APPLY ? 'Mode    : APPLY\n' : 'Mode    : DRY RUN (add --apply to write)\n');

  const existing = await database.queryLocal(
    `SELECT id, full_name, tag_number FROM attendants WHERE station_id = $1 ORDER BY full_name`,
    [STATION_ID]
  );
  console.log(`Already registered: ${existing.rows.length}`);
  for (const a of existing.rows) console.log(`  ${a.full_name} (${a.tag_number || 'no tag'})`);
  console.log('');

  if (!APPLY) {
    for (const r of ROSTER) {
      const match = existing.rows.find(
        (e) => e.full_name.toUpperCase() === r.name.toUpperCase()
      );
      console.log(`  ${match ? 'update' : 'create'}  ${r.name.padEnd(22)} tag ${r.tag}`);
    }
    console.log('\nRe-run with --apply to write.');
    return;
  }

  for (const r of ROSTER) {
    const tag = r.tag.toUpperCase();

    // --- attendant --------------------------------------------------------
    // attendants has no unique key on the name, so match explicitly rather
    // than relying on ON CONFLICT.
    const found = await database.queryLocal(
      `SELECT id FROM attendants WHERE station_id = $1 AND UPPER(full_name) = UPPER($2) LIMIT 1`,
      [STATION_ID, r.name]
    );

    let attendantId;
    let verb;
    if (found.rows.length) {
      attendantId = found.rows[0].id;
      await database.queryLocal(
        `UPDATE attendants SET tag_number = $1, is_active = true, blocked = false WHERE id = $2`,
        [tag, attendantId]
      );
      verb = 'updated';
    } else {
      const ins = await database.queryLocal(
        `INSERT INTO attendants (company_id, station_id, full_name, tag_number, is_active, blocked)
         VALUES ($1, $2, $3, $4, true, false)
         RETURNING id`,
        [COMPANY_ID, STATION_ID, r.name, tag]
      );
      attendantId = ins.rows[0].id;
      verb = 'created';
    }

    // --- rfid_tags (the one that actually authorises) ---------------------
    // Release the card from anyone else at this station first. Without this, a
    // card reassigned to a new person would still resolve to the old one.
    await database.queryLocal(
      `UPDATE rfid_tags SET attendant_id = NULL, is_active = false
        WHERE station_id = $1 AND UPPER(tag_number) = $2 AND attendant_id IS DISTINCT FROM $3`,
      [STATION_ID, tag, attendantId]
    );
    await database.queryLocal(
      `INSERT INTO rfid_tags (tag_number, label, company_id, station_id, attendant_id, is_active, assigned_at)
       VALUES ($1, $2, $3, $4, $5, true, now())
       ON CONFLICT (tag_number, station_id) DO UPDATE SET
         attendant_id = EXCLUDED.attendant_id,
         company_id   = EXCLUDED.company_id,
         label        = EXCLUDED.label,
         is_active    = true,
         assigned_at  = now()`,
      [tag, r.name, COMPANY_ID, STATION_ID, attendantId]
    );

    // --- attendant_tags (what syncs to HQ) --------------------------------
    // No unique constraint on this table, so retire any previous active row for
    // this attendant before issuing the current one.
    await database.queryLocal(
      `UPDATE attendant_tags SET is_active = false, revoked_at = now()
        WHERE station_id = $1 AND attendant_id = $2
          AND is_active = true AND UPPER(tag_number) <> $3`,
      [STATION_ID, attendantId, tag]
    );
    const held = await database.queryLocal(
      `SELECT id FROM attendant_tags
        WHERE station_id = $1 AND attendant_id = $2 AND UPPER(tag_number) = $3 LIMIT 1`,
      [STATION_ID, attendantId, tag]
    );
    if (held.rows.length) {
      await database.queryLocal(
        `UPDATE attendant_tags SET is_active = true, revoked_at = NULL WHERE id = $1`,
        [held.rows[0].id]
      );
    } else {
      await database.queryLocal(
        `INSERT INTO attendant_tags (attendant_id, station_id, tag_number, is_active, issued_at)
         VALUES ($1, $2, $3, true, now())`,
        [attendantId, STATION_ID, tag]
      );
    }

    console.log(`  ${verb.padEnd(8)} ${r.name.padEnd(22)} tag ${tag}`);
  }

  // --- verify -------------------------------------------------------------
  // Run the REAL authorisation query from rfid-reader.service.js lookupAttendant
  // for every tag. This proves a card scan will resolve, rather than proving
  // that rows exist somewhere.
  console.log('\n-- Scanning each tag through the real lookup --');
  let bad = 0;
  for (const r of ROSTER) {
    const { rows } = await database.queryLocal(
      `SELECT COALESCE(a.full_name, 'Unknown') AS attendant_name
         FROM rfid_tags t
         JOIN attendants a ON t.attendant_id = a.id
        WHERE UPPER(t.tag_number) = UPPER($1)
          AND t.is_active = true
          AND t.attendant_id IS NOT NULL
          AND a.blocked = false
          AND t.station_id = $2`,
      [r.tag, STATION_ID]
    );

    if (rows.length === 1 && rows[0].attendant_name.toUpperCase() === r.name.toUpperCase()) {
      console.log(`  OK    ${r.tag}  -> ${rows[0].attendant_name}`);
    } else if (rows.length === 0) {
      console.log(`  FAIL  ${r.tag}  -> resolves to NOBODY`);
      bad++;
    } else {
      console.log(`  FAIL  ${r.tag}  -> ${rows.length} matches: ${rows.map((x) => x.attendant_name).join(', ')}`);
      bad++;
    }
  }

  const hqCount = await database.queryLocal(
    `SELECT COUNT(*)::int AS n FROM attendant_tags WHERE station_id = $1 AND is_active = true`,
    [STATION_ID]
  );
  console.log(`\nattendant_tags active (syncs to HQ): ${hqCount.rows[0].n}`);

  if (bad === 0) {
    console.log(`\nAll ${ROSTER.length} tags resolve. Restart the server, then scan a card at a pump.`);
  } else {
    console.log(`\n${bad} tag(s) do not resolve — send this output.`);
    process.exitCode = 1;
  }
}

main()
  .catch((e) => { console.error('\nFailed:', e.message); process.exitCode = 1; })
  .finally(() => database.close());
