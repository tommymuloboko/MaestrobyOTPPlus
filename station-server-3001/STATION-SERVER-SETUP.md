# MAESTRO-LITE station server (:3001) — Sapphire Lusaka Depot

This is the on-site server that does **PTS-2 polling, RFID attendant badges, tanks,
local transactions**, and (optionally) **syncs to Maestro Central** for the HQ
dashboard + price management. The OTP server (:3005) calls it for RFID badges.

Runs on the depot PC alongside the OTP server. Node 18+, local PostgreSQL.

## 1. Local PostgreSQL

Install PostgreSQL (5432) and create the database:

```sql
CREATE DATABASE maestro_sapphire;
```

## 2. Schema — use `apply-full-schema.js`, NOT `setup-local-schema.js`

`setup-local-schema.js` misnames `pump_report_transactions` and leaves the DB
subtly wrong. Use the additive, correct one:

```powershell
cd station-server-3001
npm install
# fill .env first (next step), then:
node scripts/apply-full-schema.js
```

Its constraint checker may print "multiple primary keys not allowed" — that means
the key already exists, not a failure.

## 3. `.env` — identity is the trap

Copy `env.sapphire.txt` to `.env` and fill the `SET_*` values. The critical ones:

- **`COMPANY_ID` / `STATION_ID`** — Sapphire's identity. If you're registering on
  Maestro Central (step 6), use the UUIDs from `cloud/3-sapphire-maestro-central.sql`.
  If you're running local-only for now, generate two UUIDs and keep them stable.
- `OFFLINE_COMPANY_ID` / `OFFLINE_STATION_ID` = the same two.
- `LOCAL_DB_*` — the Postgres from step 1 (port **5432**, not 5433).
- `PTS_*` — Sapphire's controller.
- `SERVICE_TOKEN` / `JWT_SECRET` — fresh 32-byte hex. **`SERVICE_TOKEN` must equal
  the OTP server's `STATION_SERVICE_TOKEN`** (that's how :3005 authenticates to :3001).

> ⚠️ **Identity placeholder trap:** the schema seeds placeholder identity. After you
> set the real `.env` identity, the local DB's RFID/company rows must be repointed to
> match, or RFID auth rejects every tap. Run:
> ```powershell
> node scripts/fix-station-identity.js
> ```
> Do this whenever you change `COMPANY_ID`/`STATION_ID`.

## 4. Admin + service accounts

```powershell
node scripts/create-admin-manager.js     # station admin/manager login for the tablet
```

If Central will push prices to this station (step 6), the account Central logs in as
(`station_registry.service_username`) **must have the admin or manager role** — this
is the Surya 403 cause. `create-admin-manager.js` creates a manager; confirm its role.

## 5. RFID readers (if the depot has pump-side tag readers)

```powershell
node scripts/setup-rfid-tables.js
node scripts/register-tag-readers.js     # register Sapphire's own readers
node scripts/register-attendants.js      # enroll Sapphire's attendants + tags
```

Set `RFID_ENABLED=false` in `.env` (and `REQUIRE_ATTENDANT_BADGE=false` in the OTP
server's `.env`) if there are no readers.

## 6. Register on Maestro Central (optional — for the HQ dashboard + price push)

Needed only if Sapphire goes on the HQ dashboard / has HQ-managed prices. Two parts:
- Run `cloud/3-sapphire-maestro-central.sql` on the VPS (`maestro_central`): creates
  the company + `station_registry` row (base_url = Sapphire's inbound tunnel URL,
  service_username/password = the step-4 service account). See that file.
- Set up an **inbound cloudflared tunnel** (a hostname → `localhost:3001`) so Central
  can reach this server, and register the DNS. Mirror an existing Surya station.

Leave `AUTO_PULL_ON_STARTUP=false` until this is done.

## 7. Run + verify

```powershell
node scripts/test-db-connection.js
npm start                     # or install as a service (see install-station.ps1 / pm2 ecosystem.config.js)
curl http://localhost:3001/api/health
```

`/api/health` should report `configured: true` with the Sapphire company_id/station_id.

## 8. Prove RFID → OTP end-to-end

With both servers up: a driver's OTP + an attendant badge tap at the pump should
authorize the fill. If RFID taps are rejected, re-run `fix-station-identity.js`
(identity mismatch is the usual cause).
