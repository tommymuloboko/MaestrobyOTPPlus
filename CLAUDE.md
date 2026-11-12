# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Repository layout

Maestro FuelOrder is a fuel ordering / OTP-authorised dispensing platform. Independent projects live side by side:

| Dir | Stack | Role |
|-----|-------|------|
| `backend/` | Java 21, Spring Boot, single-module Maven | The cloud API (`com.maestro.fuelorder`), port **8085** |
| `portal/` | React 19 + TypeScript + Vite | Web portal for customers, suppliers/OMC, staff |
| `android/` | Kotlin, Jetpack Compose | Attendant/driver app (`com.maestro.attendant`) |
| `sentinel-ai/` | Python FastAPI | Fraud risk scorer, port 8090 (rules-and-weights, not a trained model) |
| `station-server-3001/` | Node.js + Express (CommonJS) | On-site station server, port 3001: polls the PTS-2 forecourt controller, RFID readers, local Postgres, syncs to central. Separate codebase from `backend/` |
| `tools/device-simulator`, `tools/load-test` | Node | MQTT telemetry simulator and HTTP load test |
| `docs/` | Markdown | `01`–`08` describe the *target* design and are partly ahead of the code. `09-implementation-status.md` is the honest record of what is built/simulated; `10` covers station-server ↔ PTS-2 integration |

## Commands

Windows dev machine; use `.\mvnw.cmd` / `.\gradlew.bat` in PowerShell (`./mvnw`, `./gradlew` in bash/CI).

```powershell
# Backend (H2 in-memory, demo data seeded on every start, embedded MQTT broker on 1883)
cd backend; .\mvnw.cmd spring-boot:run
.\mvnw.cmd test                                   # all integration tests
.\mvnw.cmd test -Dtest=OmcConsoleTest             # one class
.\mvnw.cmd test -Dtest=OmcConsoleTest#methodName  # one method
.\mvnw.cmd -B verify                              # what CI runs

# Backend against PostgreSQL (docker-compose publishes Postgres on 5434)
docker compose up -d postgres
.\mvnw.cmd spring-boot:run "-Dspring-boot.run.profiles=postgres"

# This dev machine: no Docker; a local PostgreSQL 18 service on 5432 with database maestro_fuelorder
# (role maestro / maestro_dev). Do not use the database named "maestro" there: it holds another app's functions.
# Only JDK 17 is installed, hence the java.version override.
$env:MAESTRO_DB_URL="jdbc:postgresql://localhost:5432/maestro_fuelorder"; .\mvnw.cmd "-Djava.version=17" spring-boot:run "-Dspring-boot.run.profiles=postgres"
# PowerShell splits unquoted -Dname.with.dots=value arguments, so always quote -D flags.

# Portal (expects API at http://localhost:8085/api/v1, override with VITE_API_BASE)
cd portal; npm install; npm run dev -- --port 5174
npm run build    # tsc -b && vite build — CI's type check
npm run lint     # oxlint

# Sentinel AI
cd sentinel-ai; python -m pytest -q
docker compose --profile ai up sentinel-ai

# Android (JDK 17; emulator reaches API at 10.0.2.2:8085)
cd android; .\gradlew.bat testDebugUnitTest assembleDebug

# Station server
cd station-server-3001; npm start   # or npm run dev (nodemon)
```

Demo logins (password `Maestro#2026`, or `MAESTRO_SEED_PASSWORD` if set): `fleet@acme.test`, `fleet@buildco.test` (Fleet Manager / customer), `supplier@mainline.test` (Station Manager), `omc@mainline.test` (OMC Administrator), `attendant@mainline.test`, `finance@maestro.test`, `admin@maestro.test` (Platform Admin). Seeded drivers use PIN `1234`.

## Backend architecture

- **Package-by-domain** under `com.maestro.fuelorder`: `order`, `dispense` (OTP + transactions), `pricing`, `org` (orgs, users, credit), `registry` (vehicles, drivers), `delivery`, `stock`, `finance` (invoices, double-entry ledger), `recon`, `sentinel` (risk events, fraud cases, hash-chained evidence), `integration` (MQTT/HTTP telemetry), `erp`, `bulk` (Excel import), `site`, `cctv`, `notify`, `audit`, `insights`. Each is Controller → Service → JPA Repository/Entity.
- **Auth is in-process, not Spring Security.** `auth/AuthFilter` requires `Authorization: Bearer <token>` on every `/api/**` except `/api/v1/auth/login`, and stores the session as a request attribute. Tokens are opaque and in-memory (lost on restart). Controllers call the static helpers in `auth/Access` (`Access.session(req)`, `requireSupplier`, `requireOmc`, `isCustomer`, …) for role and tenant checks — add new permission checks there, not ad hoc.
- **Roles are fixed strings** in `Access` (`Fleet Manager`, `Station Manager`, `Attendant`, `Finance`, `OMC Administrator`, `Platform Admin`). Customers (Fleet Manager) must only ever see their own organization's data; tenant isolation is tested and must be preserved.
- Filter order: `WebConfig` CORS (ahead of auth so 401s carry CORS headers; origins from `maestro.cors.allowed-origins`), `HardeningFilter` (security headers, rate limits), `AuthFilter`, `audit/AuditFilter` (append-only log of every API request). Errors are RFC 7807 problem JSON via `ApiExceptionHandler`.
- **Schema**: default H2 profile uses `ddl-auto=update` with Flyway disabled. The `postgres` profile runs Flyway (`src/main/resources/db/migration/V*__*.sql`) with Hibernate `validate` — any entity change needs a new `V{n}__*.sql` migration or Postgres boot fails. Avoid reserved words like `value` as column names (H2), and give nested entities an explicit `@Entity(name=...)` so HQL resolves them.
- `bootstrap/DemoData` seeds orgs/users/fleet only when the DB is empty.
- `maestro.demo.expose-otp=true` (default) returns the OTP in the approve response for demos; production sets `MAESTRO_DEMO_EXPOSE_OTP=false`.
- Tests in `backend/src/test` are `@SpringBootTest` integration tests over real HTTP (e.g. `WorkflowInvariantsTest` encodes core rules: rejected orders never get an OTP, customers can't approve their own orders, OTPs can't be overdrawn/reused).
- Simulated, not real: SMS, card payments, fiscal reference, CCTV/ONVIF source, ERP endpoint without webhook. Redis/RabbitMQ/EMQX in `docker-compose.yml` are **not used by the API** yet.

## PTS-2 live tanks (`pts2` package)

- Tanks shown in the portal come **live from each site's PTS-2 controller**, not from seeded data (DemoData no longer creates tanks). `Pts2Service` polls every enabled `Pts2Connection` (one per site, table `pts2_connections`, migration `V5`) every `maestro.pts2.poll-ms` (15 s): `GetUniqueIdentifier`, `GetProbesConfiguration`, `GetTanksConfiguration`, `GetFuelGradesConfiguration`, then `ProbeGetMeasurements` per probe. The latest result per site is held in memory and served at `GET /api/v1/pts2/tanks`.
- Each good reading is also fed to `TelemetryService.ingestTank`, so tank trends, reconciliation and device-offline alerts see it. The product code is derived from the fuel grade name (`Diesel 50` → `DIESEL_50`); a second tank with the same grade at a site gets `_T<n>`.
- `Pts2Client` speaks jsonPTS over HTTP or HTTPS (self-signed certificate is trusted) and answers either a Digest or Basic challenge (selected on the controller by DIP switch 2). Connections are managed at `/api/v1/pts2/connections` (OMC or Platform Admin; the password is never returned) and in the portal under **PTS-2 Connection** (`portal/src/Pts2Pages.tsx`).
- The API must be able to reach the controller on the network, so this works from a dev machine on the station LAN, not from the VPS deployment. Run the `postgres` profile to keep saved connections; on the default H2 profile they are lost when the API restarts.
- **Pump prices** (`Pts2PriceService`, portal **Pump Prices**): `POST /api/v1/pts2/prices/{site}` with no `effectiveAt` sends `SetFuelGradesPrices` now; with `effectiveAt` (controller local time) it writes a one-time entry to the controller's own prices scheduler (`SetPricesSchedulerConfiguration`, 10 slots), so the change happens on time without the API. Both commands replace the whole list on the controller, so the service always reads and merges first. Every change and cancellation is logged in `pts2_price_changes` (migration `V6`). These are pump prices per site, separate from the platform's `pricing` list prices and customer rules.
- Protocol reference: `jsonPTS protocol for PTS-2 controller.pdf` in the Tactivo PTS-2 docs folder (probe measurements p.219–223, tanks configuration p.117). `Pts2ConnectionTest` runs a fake Digest-auth controller.

## Portal architecture

- No router or state library: `App.tsx` holds the session and switches pages by role using nav definitions exported from page modules (`STAFF_NAV`, `OMC_NAV`, `CustomerPages`, …).
- All HTTP goes through `src/api.ts` (`api`, `sessionStore`, typed DTOs, unauthorized handler).
- Exports (`exporter.ts`, `xlsx.ts`) use an in-house `.xlsx` writer (a common library failed the dependency audit), lazy-loaded jsPDF, and CSV with BOM and formula-injection neutralisation — keep text cells as text, never formulas.

## Deployment

`docker-compose.prod.yml` + `deploy.sh` run Postgres, the API (`postgres` profile) and the portal (Caddy, `portal/Caddyfile`) behind a shared VPS Caddy for `maestrobyotpplus.com`. Required env: `DB_PASSWORD`, `SEED_PASSWORD` (see `.env.prod.example`).
