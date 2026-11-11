# 08 · Development Phases

Phased so every phase ships a usable product increment; modules M1–M8 map to
[System overview](./01-system-overview.md).

> **Status:** the items below have been implemented to varying degrees. See
> [09 · Implementation status](./09-implementation-status.md) for what is done, verified, simulated or not done.

## Phase 0 — Foundations (2–3 weeks)
- Repo scaffold: Gradle multi-module backend (Java 21 + Spring Boot), React + TypeScript
  portal, Kotlin Android app, `sentinel-ai` Python service skeleton.
- **Spring Boot API Gateway** (authentication, permissions, multi-tenancy), PostgreSQL +
  Flyway, Redis, RabbitMQ/Kafka, CI pipeline, environments.
- Identity & tenancy: organizations, branches, organization_users, scoped RBAC (gateway
  policies + domain guards), audit-log interceptor.

## Phase 1 — Core Fuel Ordering & OTP (5–7 weeks)
- Customer accounts and supplier registration (organizations, customers, credit accounts).
- Orders (customer- and supplier-initiated) with per-vehicle/truck allocations,
  configurable approvals, rejection reasons, complete status history.
- OTP generation (hashed, time-limited, bound to driver/vehicle/site/product/quantity),
  SMS notifications, driver verification (PIN/identity).
- Android App — Attendant mode: validate → dispense → receipt; dispensing integration via
  Maestro Controller (manual mode first); fuel transactions + stock movements.
- **Milestone: a customer orders fuel, gets approval, and a driver redeems an OTP at a site.**

## Phase 2 — Advanced Fuel Operations (5–6 weeks)
- Customer-specific pricing (price rules, tiers, branch pricing, taxes, surcharges,
  price approval controls + price history) and credit management (limits, terms, balances).
- Maestro Integration Layer: pump monitoring, ATG tank monitoring, bulk flow meter
  integration (MQTT/mTLS, edge agent, store-and-forward, fail-secure offline).
- Deliveries: delivery notes, GPS tracking, geofenced arrival, proof of delivery,
  tank deliveries; delivery reports.
- Stock reconciliation: variance engine, daily site close, exception queue; double-entry
  ledger, billing runs → JasperReports invoices, payments, statements.

## Phase 3 — AI, Fraud & Business Intelligence (4–6 weeks)
- Maestro Sentinel™: deterministic rules engine + `sentinel-ai` Python risk scoring,
  fraud investigation cases, protected evidence records, graduated response.
- CCTV event detection (ONVIF/VMS): containers, nozzle-away, attendant behavior, ANPR.
- Predictive stock forecasting, consumption analytics, anomaly surfacing.
- Advanced management dashboards (Wetstock Intelligence, fleet BI, alert insights).

## Phase 4 — Enterprise & Regional Expansion (ongoing)
- Multi-country operations: multiple currencies, locales, fiscal/tax integrations.
- ERP APIs (Central adapter), payment gateways, advanced supplier settlement.
- White-label customer portals.
- Hardening & scale: load/chaos testing, OWASP ASVS L2 audit, pen test, DR drills,
  multi-region readiness; optional extraction of hot modules into services.

## Suggested immediate next steps
1. Approve this architecture (or request changes).
2. Scaffold Phase 0 in this workspace (backend + portal + Android + sentinel-ai).
3. Define the seed Flyway migration (organizations, facilities, customers, fleet, pricing).
4. Build the Attendant-mode walking skeleton end-to-end with a simulated Maestro Controller.
