/**
 * Create the admin and manager logins on a fresh station database.
 *
 * A newly created database has no companies, stations, roles or users, so a
 * user row alone is not enough to log in with: the login route joins
 * user_roles -> roles to decide what the account may do, and users.company_id is
 * NOT NULL. This creates the whole chain.
 *
 * Idempotent. Run it twice and nothing is duplicated. An account that already
 * exists is left alone unless --reset is passed, so this can never silently
 * change a password someone is relying on.
 *
 *   node scripts/create-admin-manager.js           # create what is missing
 *   node scripts/create-admin-manager.js --reset   # also reset existing passwords
 *
 * The password is held here rather than taken as an argument because it contains
 * "!", which cmd.exe and PowerShell both mangle. Override with an env var if
 * needed:  set MAESTRO_INIT_PASSWORD=... && node scripts/create-admin-manager.js
 */

const path = require('path');

// Before utils/database — that module reads process.env at load time.
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const bcrypt = require('bcrypt');
const database = require('../utils/database');

const PASSWORD = process.env.MAESTRO_INIT_PASSWORD || 'ChangeMe123!';
const ROUNDS = parseInt(process.env.BCRYPT_ROUNDS || '10', 10);
const RESET = process.argv.includes('--reset');

const COMPANY_ID = process.env.OFFLINE_COMPANY_ID || process.env.COMPANY_ID;
const STATION_ID = process.env.OFFLINE_STATION_ID || process.env.STATION_ID;
// Display name for this site. OFFLINE_SCOPE_MODE is an ENUM consumed by
// sync.service.js (none|company|station|both) and must NOT be reused as a label
// -- doing so both breaks scoping and names the company after the mode.
const STATION_NAME = process.env.STATION_NAME || process.env.OFFLINE_SCOPE_MODE_LABEL || 'Station';

/** Roles the routes actually check for (requireRole in routes/*.js). */
const ROLES = ['admin', 'manager', 'attendant'];

const ACCOUNTS = [
  { username: 'admin',   role: 'admin',   full_name: 'Administrator', email: 'admin@maestro.local' },
  { username: 'manager', role: 'manager', full_name: 'Manager',       email: 'manager@maestro.local' },
];

async function main() {
  if (!COMPANY_ID || !STATION_ID) {
    throw new Error(
      'OFFLINE_COMPANY_ID / OFFLINE_STATION_ID are not set in .env — cannot scope the accounts'
    );
  }

  console.log(`\nStation : ${STATION_NAME}`);
  console.log(`Company : ${COMPANY_ID}`);
  console.log(`Station : ${STATION_ID}`);
  console.log(RESET ? 'Mode    : create + reset existing passwords\n' : 'Mode    : create missing only\n');

  // --- company and station rows ------------------------------------------
  // users.company_id is NOT NULL, and reports join these for names. There are no
  // FK constraints on this schema, but leaving them absent gives every screen a
  // blank station name.
  await database.queryLocal(
    `INSERT INTO companies (id, name, code) VALUES ($1, $2, $3) ON CONFLICT (id) DO NOTHING`,
    [COMPANY_ID, STATION_NAME, String(STATION_NAME).replace(/\s+/g, '').toUpperCase().slice(0, 12)]
  );
  await database.queryLocal(
    `INSERT INTO stations (id, company_id, name, code, timezone, is_active)
     VALUES ($1, $2, $3, $4, 'Africa/Lusaka', true) ON CONFLICT (id) DO NOTHING`,
    [STATION_ID, COMPANY_ID, STATION_NAME, String(STATION_NAME).replace(/\s+/g, '').toUpperCase().slice(0, 12)]
  );
  console.log('company + station rows ensured');

  // --- roles --------------------------------------------------------------
  const roleIds = {};
  for (const name of ROLES) {
    const found = await database.queryLocal(`SELECT id FROM roles WHERE name = $1`, [name]);
    if (found.rows.length) {
      roleIds[name] = found.rows[0].id;
    } else {
      const ins = await database.queryLocal(
        `INSERT INTO roles (name) VALUES ($1) RETURNING id`, [name]
      );
      roleIds[name] = ins.rows[0].id;
      console.log(`  + role "${name}"`);
    }
  }
  console.log('roles ensured:', ROLES.join(', '));

  // --- accounts -----------------------------------------------------------
  const hash = await bcrypt.hash(PASSWORD, ROUNDS);
  console.log('');

  for (const acct of ACCOUNTS) {
    const existing = await database.queryLocal(
      `SELECT id FROM users WHERE username = $1`, [acct.username]
    );

    let userId;
    if (existing.rows.length === 0) {
      const ins = await database.queryLocal(
        `INSERT INTO users (company_id, station_id, username, password_hash, full_name, email, is_active)
         VALUES ($1, $2, $3, $4, $5, $6, true)
         RETURNING id`,
        [COMPANY_ID, STATION_ID, acct.username, hash, acct.full_name, acct.email]
      );
      userId = ins.rows[0].id;
      console.log(`created  ${acct.username}`);
    } else {
      userId = existing.rows[0].id;
      if (RESET) {
        await database.queryLocal(
          `UPDATE users SET password_hash = $1, is_active = true WHERE id = $2`, [hash, userId]
        );
        console.log(`reset    ${acct.username} (password changed)`);
      } else {
        console.log(`exists   ${acct.username} (left alone — use --reset to change its password)`);
      }
    }

    // Role assignment is separate from creation: an account created by an
    // earlier run without a role would otherwise log in and be able to do
    // nothing, which looks like a broken login rather than a missing role.
    await database.queryLocal(
      `INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2)
       ON CONFLICT (user_id, role_id) DO NOTHING`,
      [userId, roleIds[acct.role]]
    );
  }

  // --- verify -------------------------------------------------------------
  // Prove the stored hash actually validates the password, rather than trusting
  // that the INSERT succeeded. A wrong bcrypt cost or a truncated column would
  // both look fine above and fail at the login screen.
  console.log('\n-- Verification --');
  let allOk = true;
  for (const acct of ACCOUNTS) {
    const { rows } = await database.queryLocal(
      `SELECT u.password_hash, u.is_active,
              COALESCE(array_agg(r.name) FILTER (WHERE r.name IS NOT NULL), '{}') AS roles
         FROM users u
         LEFT JOIN user_roles ur ON ur.user_id = u.id
         LEFT JOIN roles r       ON r.id = ur.role_id
        WHERE u.username = $1
        GROUP BY u.password_hash, u.is_active`,
      [acct.username]
    );
    if (!rows.length) {
      console.log(`  ${acct.username.padEnd(8)} MISSING`);
      allOk = false;
      continue;
    }
    const match = await bcrypt.compare(PASSWORD, rows[0].password_hash);
    const ok = match && rows[0].is_active && rows[0].roles.length > 0;
    if (!ok) allOk = false;
    console.log(
      `  ${acct.username.padEnd(8)} password:${match ? 'OK' : 'FAIL'}` +
      `  active:${rows[0].is_active}  roles:[${rows[0].roles.join(',')}]`
    );
  }

  if (allOk) {
    console.log(`\nBoth accounts are usable. Password: ${PASSWORD}`);
    console.log('Change it after first login.');
  } else {
    console.log('\nSomething is not right — send this output.');
    process.exitCode = 1;
  }
}

main()
  .catch((e) => { console.error('\nFailed:', e.message); process.exitCode = 1; })
  .finally(() => database.close());
