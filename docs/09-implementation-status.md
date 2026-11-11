# 09 · Implementation status

What is built, what has been verified and how, what is simulated, and what is **not** done.
This is the honest counterpart to the plan in [08-roadmap.md](./08-roadmap.md); the design documents
(01–07) describe the target, this one describes the code.

## Running it

| Piece | Command | Notes |
|-------|---------|-------|
| API (H2, in-memory) | `cd backend` then `.\mvnw.cmd spring-boot:run` | Port 8085. Data resets on restart and demo data re-seeds. Embedded MQTT broker on 1883. |
| API (PostgreSQL) | `docker compose up -d postgres` then `.\mvnw.cmd spring-boot:run "-Dspring-boot.run.profiles=postgres"` | Flyway applies `V1__baseline.sql`; Hibernate only validates. Postgres is published on **5434** (5432/5433 are commonly taken). |
| Portal | `cd portal` then `npm install` and `npm run dev -- --port 5174` | Talks to `http://localhost:8085`. |
| Device simulator | `cd tools/device-simulator` then `npm install` and `npm run selftest` | Publishes ATG and pump totalizer readings over MQTT, with store-and-forward. |
| Load test | `cd tools/load-test` then `npm install` and `npm start` | Start the API with the rate limiter off (see the script header). |
| Sentinel AI | `docker compose --profile ai up sentinel-ai` | FastAPI scorer on 8090; set `maestro.sentinel.ai-url` to use it. |
| Android | `cd android` then `.\gradlew.bat assembleDebug testDebugUnitTest` | Emulator reaches the API at `10.0.2.2:8085`. |

Demo accounts (password `Maestro#2026`): `fleet@acme.test`, `fleet@buildco.test` (customers),
`supplier@mainline.test` (Station Manager), `omc@mainline.test` (OMC Administrator), `attendant@mainline.test`, `finance@maestro.test`,
`admin@maestro.test`. Seeded drivers use PIN `1234`.

## Roadmap items

| Phase | Item | Status | Evidence / caveat |
|-------|------|--------|-------------------|
| 0 | Repo scaffold | **Partial** | Backend, portal, Android and `sentinel-ai` exist. The backend is a **single-module Maven** project, not a Gradle multi-module build. |
| 0 | Gateway, Postgres + Flyway, Redis, RabbitMQ, CI | **Partial** | Auth, permissions and tenancy are in the API process (no separate gateway). Postgres + Flyway verified (see below). Redis, RabbitMQ and EMQX run under `docker-compose.yml` but **the API does not use them yet**. The CI workflow is written but has not run on GitHub. |
| 0 | Identity, tenancy, RBAC, audit | Done | Organizations, branches, DB-backed users, role checks, append-only audit log. |
| 1 | Accounts, credit | Done | Registration, credit limit/terms, exposure = unbilled + open invoices + committed orders. |
| 1 | Orders | Done | Customer- and supplier-initiated, bulk, approval policy, status history, rejection reasons. |
| 1 | OTP, SMS, driver PIN | Done (SMS simulated) | Hashed OTP, time limit, brute-force lockout, PIN hashed with no getter. |
| 1 | Android attendant | **Built, not run** | `assembleDebug` and 15 unit tests pass. Never run on a device or emulator (none available). No offline queue. |
| 2 | Pricing and credit | Done | Customer/product/tier/station rules, tax, four-eyes approval, price history. Branch-level pricing is not done (orders carry no branch). |
| 2 | Integration layer | Done for HTTP and MQTT | Verified over real MQTT incl. store-and-forward replay and de-duplication. **No mTLS**; the embedded broker allows anonymous clients (dev only). Pump remote-authorisation disable is not enforced. |
| 2 | Deliveries | Done | Plan, load, depart, geofenced arrival, offload shortage, proof of delivery, tank deliveries. |
| 2 | Reconciliation, ledger, billing | Done (no PDF) | Variance engine, totalizer check, double-entry ledger, billing run, payments, statements. **No JasperReports PDF**; invoices are data and CSV only. |
| 3 | Sentinel + AI scoring | Done | Rules, risk events, cases, hash-chained evidence. The Python scorer is a **rules-and-weights service, not a trained model**. |
| 3 | CCTV | Done at the API | Events in, rules applied. **No ONVIF/VMS connection**; events are posted by hand or by a future integration. |
| 3 | Forecast, analytics | Done | Consumption, anomalies (z-score), days of cover. Simple averages, not a forecasting model. |
| 3 | Dashboards | Done | Staff and customer dashboards read live data. |
| 4 | Multi-country, currency | Partial | Organization country/currency, tax by country, FX rates and conversion. Fiscal integration is simulated. |
| 4 | ERP, payments, settlement | Done (simulated rails) | CSV export, webhook push with outbound log, supplier settlement with platform fee. Card gateway and fiscal reference are simulated. |
| 4 | White-label | Done | Supplier sets name and colour; customers see it. Verified in the browser. |
| 4 | Bulk Excel import (added later) | Done | Download a template, fill it in, upload it. Vehicles, drivers and bulk-order allocations. See below. |
| 4 | Hardening | **Partial** | See the checklist below. Pen test, OWASP ASVS audit, chaos tests, DR drills and multi-region are **not done**. |

## Bulk Excel import (vehicles, drivers, bulk orders)

Customers (Fleet Manager) can load many records at once from the **Vehicles**, **Drivers** and **Bulk order** pages with *Import from Excel*:

1. **Download the template** (`.xlsx`). It has a *Data* sheet (headers, dropdowns, number checks) and an *Instructions* sheet. The bulk-order template is pre-filled with the customer's vehicles (for the chosen fuel) and their usual drivers.
2. **Upload the filled file.** Every row is checked first and the result is shown, with the Excel row number against each problem.
3. **Confirm.** If any row is invalid, **nothing** is imported. Vehicles and drivers are saved only when the user confirms; for bulk orders the valid rows are loaded into the allocation table to review and submit as usual.

Behaviour worth knowing:

- Drivers get a random 4-digit PIN each. The PINs are shown once after the import (with a CSV download) and sent by SMS (simulated) only after the data is committed.
- Bulk orders use the same fleet rules as single orders: vehicle and driver must be in the customer's fleet, the fuel must suit the vehicle, the litres must fit the tank, and a vehicle may appear once. A blank driver uses the vehicle's assigned driver. Rows with no litres are skipped.
- Columns are matched by header name, so reordering or adding columns is fine. Formulas are rejected, and files are limited to `.xlsx`, 2 MB and 500 rows.
- Endpoints: `GET /api/v1/bulk/templates/{vehicles|drivers|orders}`, `POST /api/v1/bulk/vehicles`, `POST /api/v1/bulk/drivers` (both take `dryRun`, default `true`), `POST /api/v1/bulk/orders/parse`.
- Verified by 5 integration tests that build real `.xlsx` files and upload them over HTTP (validation, atomic import, PIN issue, tenant isolation, malformed and oversized files), and by a run in the browser. Only `.xlsx` is supported, not `.xls` or `.csv`. Customers only: suppliers and staff cannot import vehicles or drivers.
- Not covered: the browser's file-save dialog was not observable in the test browser; I confirmed the downloaded blob is the valid 4,685-byte workbook, but not the dialog itself.

## OMC Administrator console (Phase 1)

A new role, **OMC Administrator** (`omc@mainline.test`), runs the supplier network. It has the supplier, finance and staff privileges, may register **customers** (not other suppliers), may register vehicles on a customer's behalf, and cannot read the audit log (that stays with the Platform Admin). The console lists the 15 modules in the owner's brief. The table shows what is real today:

| Module | State |
|--------|-------|
| Overview, Tanks, Pump & Meter Monitoring, Fraud & Risk Centre, Financial Management, Reports & Analytics | Built on the existing features, regrouped under the console |
| Order Management | Approve and reject existed; **amend** (litres, destination, cost centre; only before authorization, re-priced, tank limit enforced) and **cancel** (an authorized order's code is revoked) are new. **Select all / Approve selected / Approve all** approve every order awaiting approval in the current filter, one request each, with a confirmation step and a per-order result (each order's code, or why it failed) |
| OTP Management | New: monitor every code (the code itself is never listed), **revoke** a live code, **regenerate** a replacement. A redeemed code can never be reissued; the old code stops working because its hash is replaced |
| Customer Management | Register customers, edit credit limit, terms and budget; contract prices via the existing four-eyes pricing page |
| Driver Management | New: **verify/unverify** a driver, **suspend/restore** fuel access. A suspended driver cannot be ordered for and cannot redeem a code. PINs are never visible to the OMC. Drivers can be **selected (or all selected)** for bulk verify, unverify, suspend (one shared reason) and restore, plus **Verify all unverified**; each bulk action only applies to the selected drivers it fits and reports every driver's outcome |
| Vehicle Management | New: register for a customer, edit tank capacity, per-vehicle **fuelling history** |
| Facilities Management | **Add site**: the OMC registers a station, depot or fuel depot by the unique ID of its **PTS-2 controller** (plus name, type, coordinates and optional tanks with capacity, reorder level and opening stock). Sites are stored in the database (the three demo sites are seeded with demo PTS-2 IDs); telemetry posted under a PTS-2 ID is recorded against its site. Editing and removing sites is not built |
| Transporter Management | **Phase 2**: not built (see below) |
| Users & Permissions | **Add, edit, deactivate, reactivate, reset password and delete** user accounts. The OMC Administrator cannot create, change or delete a Platform Admin, cannot change their own role or delete/deactivate themselves, and the platform always keeps one active Platform Admin. Changing, deactivating, resetting or deleting an account signs that person out at once. The roles themselves are fixed; per-user approval limits are Phase 2 |
| Settings & Integrations | Read-only status plus the existing ERP tools; configuring SMS, payment gateways and the controller is Phase 2 |

Phase 2 needs new data models: a Transporter organisation type that owns fleets and is linked to customers, editing and pump management for Facilities, per-user approval limits, and editable integration settings.

Schema change: Flyway `V2__omc_driver_controls.sql` adds the driver verification and suspension columns. It was applied to an empty PostgreSQL 16 and the application booted with `ddl-auto=validate`; the OMC order, OTP and driver-control flow was then run against it.

Verified by 6 integration tests (`OmcConsoleTest`): role boundaries, cancel (including code revocation), amend, OTP revoke and regenerate with the never-reuse rules, driver suspension and verification, and vehicle administration with tenant isolation on the history.

## Print, PDF, Excel and CSV export

Every report table in the customer portal and the Finance pages has an **Export** menu: Vehicles, Drivers, Fuel Allocations, Fuel Suppliers, the four Reports, and Invoices, Statement and Payments on Invoices & Payments, plus Invoices, Ledger and Statements in staff Finance. Exports carry a title, who generated them and when, typed columns (money, litres, dates), and totals; a statement ends with the closing balance.

- **Excel** is a real `.xlsx` (typed numbers, currency and date formats, frozen header, filters, print titles) written by a small in-house writer, because the common library failed the dependency audit. Text is always stored as text, never as a formula.
- **PDF** is generated in the browser with jsPDF (lazy-loaded, so it does not add to the main bundle).
- **CSV** gets a BOM so Excel reads it correctly, and values that start with `=`, `+`, `-` or `@` are neutralised.
- Verified by reading the files back with independent readers (ExcelJS and pdf.js) for Vehicles (xlsx, csv, pdf), Invoices (xlsx) and Statement (xlsx, pdf), including a hostile value (a `=HYPERLINK(...)` description) that stayed text in all three formats.
- **Not verified:** the browser **Print** path (it opens the print dialog, which the test browser cannot show), and the Payments, Ledger, Allocations, Suppliers and Reports exports were compiled and share the same code but were not each opened and read back.

## What was verified, and how

- **Backend tests** (`backend`, `.\mvnw.cmd test`): 16 integration tests over real HTTP. Five cover the workflow rules: rejected orders never get an OTP, customers cannot approve their own orders, OTP cannot be overdrawn or reused, tenant isolation, and the delivery lifecycle including GPS track and proof of delivery. Five cover the Excel import and six cover the OMC console (see above).
- **Smoke scripts** exercised pricing, credit, billing, settlement, Sentinel, telemetry, reconciliation, deliveries, CCTV and ERP end to end on H2 and again on PostgreSQL 16 with identical results.
- **PostgreSQL + Flyway:** `V1__baseline.sql` was generated from the entities, applied to an empty PostgreSQL 16, and the application booted with `ddl-auto=validate`.
- **MQTT:** a Node device simulator published tank and pump readings, dropped its connection, buffered with original timestamps, reconnected and replayed twice. The API stored exactly one row per reading.
- **Portal:** the staff and customer pages were clicked through in a browser against the live API. Pages that were only compiled and not clicked are listed in the hand-over notes.
- **sentinel-ai:** 5 pytest tests pass inside the Docker image (Python is not installed on the development machine).

## Defects found by testing, and fixed

- Nested JPA entities were not resolvable by simple name in HQL. Fixed with explicit `@Entity(name=...)`, or top-level classes, plus a regression test.
- `value` is a reserved word in H2; columns renamed.
- CORS did not allow `PUT`; found only in a real browser.
- Moquette pulled an incompatible H2 MVStore and a second SLF4J binding; excluded. Moquette also tries to send usage telemetry to an external collector; disabled.
- Several endpoints loaded whole tables into memory. After the write load test, the dashboard fell to about 10 requests/s and the orders list to about 3 requests/s. Fixed with bounded and indexed queries.

## Load test (development laptop, H2 in-memory, 30 connections, 10 s per scenario)

The machine was also running other work, so treat these as indicative only.

| Scenario | Before the query fixes (about 10,000 orders) | After (about 10,000 orders) |
|----------|----------------------------------------------|------------------------------|
| `GET /insights/dashboard` | about 10 req/s, p50 2.4 s | about 800 req/s, p50 42 ms |
| `GET /orders` (customer) | about 3 req/s, p50 5.6 s | about 154 req/s (returns up to 200 rows), p50 136 ms |
| `POST /orders` | about 284 req/s | about 536 req/s |
| `POST /auth/login` | about 1,270 req/s | about 1,420 req/s |

There were no non-2xx responses. The client reported intermittent socket errors (roughly 0–1%) in the multi-scenario runs that did not reproduce in isolated runs; the cause was not isolated. This is a single instance on in-memory H2: it says nothing about PostgreSQL under load, multiple instances or production hardware.

## Security checklist (what exists, what does not)

| Control | State |
|---------|-------|
| Passwords | Salted SHA-256 in the skeleton. **Production needs argon2id or bcrypt.** |
| Sessions | Opaque in-memory tokens. **Lost on restart, single instance only.** Production needs JWT/Redis behind the gateway. |
| Login protection | Account lockout after 5 failures; per-client request limit (login 30/min, API 600/min). In-memory, so per instance. |
| Tenant isolation | Enforced in the API and covered by a test. |
| Roles | Supplier, attendant, finance, admin and customer checks per endpoint. |
| OTP and PIN | Hashed at rest, expiry, single use, attempt log and lockout. |
| Audit | Append-only audit log of every API request. |
| Evidence | Hash-chained records with a verify endpoint. |
| Headers | `nosniff`, `X-Frame-Options: DENY`, `no-referrer`, `Cache-Control: no-store`, restrictive CSP, HSTS when served over HTTPS. |
| CORS | Localhost only, for development. |
| Demo shortcuts | The OTP is returned in the approve response while `maestro.demo.expose-otp=true` (default); production must turn it off and send SMS only. |
| Transport | **No TLS** in the skeleton; **no mTLS for MQTT devices.** |
| Secrets | Dev credentials in `docker-compose.yml` and `application-postgres.properties` are throwaway defaults. |
| Not done | Penetration test, OWASP ASVS L2 audit, dependency scanning, secrets management, chaos testing, DR drills, multi-region. |

## Simulated, not real

SMS gateway, card payment gateway, fiscal (tax authority) reference, the CCTV/ONVIF source, the pump controller (telemetry is posted by a simulator), and the ERP endpoint when no webhook URL is configured. Tax rates are demo values and must be checked with a tax adviser before use.

## Known limits

- `docs/01–07` describe the target architecture and are partly ahead of, or different from, the code.
- Analytics read the last 90 days; list endpoints return the most recent 200 rows. There is no pagination yet.
- Branch-level pricing, bulk-delivery billing and a PDF invoice are not implemented.
- The Android app has no offline queue.
