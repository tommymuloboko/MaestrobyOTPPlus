# 06 · Security & Fraud Detection

## 1. Authentication

| Principal | Mechanism |
|-----------|-----------|
| Users (all roles) | Email/phone + password (argon2id) → short-lived access JWT (15 min) + rotating refresh token, **issued and validated by the Spring Boot API Gateway** (Spring Security); optional TOTP MFA (mandatory for FINANCE, PLATFORM_ADMIN) |
| Android App devices (attendant tablets / Maestro POS, driver phones) | Device enrollment: one-time pairing code → device certificate + device token; sessions still require an attendant/driver user login on top |
| Devices (ATG, pump controllers, GPS) | X.509 client certs over mTLS to MQTT broker; broker ACL per topic subtree |
| Drivers at pump | OTP/QR **plus** driver PIN (hashed) for high-value authorizations |

## 2. Authorization (RBAC with scopes)

- Roles are assigned **with a scope**: organization, station or depot
  (e.g. `STATION_MANAGER @ station:123`).
- Spring Boot guards resolve `(user, role, scope)` against the route's required permission;
  Spring Data JPA tenant filters additionally constrain every query by the caller's scopes —
  defense in depth against cross-tenant leaks.
- Permission matrix (abbreviated):

| Permission | ORG_ADMIN | FLEET_MGR | DRIVER | ATTENDANT | STATION_MGR | DEPOT_MGR | FINANCE | PLATFORM |
|---|---|---|---|---|---|---|---|---|
| Create order | ✅ | ✅ | ✅ (own vehicle) | — | ✅ (replenish) | — | — | — |
| Approve order | ✅ | ✅ | — | — | — | — | ✅ (high value) | — |
| Validate OTP / dispense | — | — | — | ✅ | ✅ | — | — | — |
| Manage pricing/contracts | — | — | — | — | — | — | ✅ (four-eyes) | ✅ |
| Override resolved price at point of sale | — | — | — | — | — | — | — | — |
| View fraud alerts | — | — | — | — | ✅ (own station) | — | ✅ | ✅ |
| Reconciliation & billing | — | — | — | — | ✅ (station close) | ✅ (depot) | ✅ | ✅ |

## 3. OTP / token design (M2)

- **Generation**: 6-digit OTP from CSPRNG + QR payload = signed JWT (ES256) containing
  `jti`, order line, vehicle, product, max volume, station allow-list, `exp`.
- **Storage**: only `argon2id(otp + authId salt)` in `otp_authorizations.code_hash`;
  Redis mirror keyed by hash for sub-ms lookup with TTL = expiry.
- **Validation hardening**:
  - single use (status flips to `REDEEMED` atomically via `UPDATE … WHERE status='ACTIVE'`);
  - rate limiting: 5 failed attempts per station per 10 min → station cooldown + alert;
  - binding checks: station allow-list, fuel product, vehicle registration, driver PIN;
  - expiry sweep job revokes stale authorizations and notifies the orderer.
- **Offline QR**: attendant tablets validate the JWT signature offline; double-spend is caught at
  sync time (server-side `jti` uniqueness) and flagged for fraud review.

## 4. Maestro Sentinel™ — fraud intelligence module (M5)

Maestro Sentinel is the dedicated fraud engine: **deterministic rules in Java** run
synchronously in the dispense path (block/pause decisions in milliseconds), while the
**`sentinel-ai` Python service** provides ML risk scoring, behavioral anomaly models and
CCTV event detection. It subscribes to every domain event
(dispense, OTP attempt, telemetry, delivery, order) and evaluates the rule catalog in
near-real-time, with automated responses where safe.

### 4.1 Detection → response matrix (authoritative)

| Detection | System response | Rule code | Severity |
|-----------|-----------------|-----------|----------|
| Duplicate or reused OTP | **Block authorization** and alert security | `OTP_REUSE` | CRITICAL |
| Wrong driver or vehicle | **Require identity verification** (PIN + photo/ANPR) before dispense can proceed | `WRONG_DRIVER_VEHICLE` | HIGH |
| Dispensing exceeds authorized litres | **Automatically stop at approved limit** (Maestro Controller preset + hard cutoff) | `OVER_DISPENSE` | HIGH |
| Fuel dispensed without valid order | **Critical alert** + transaction investigation case | `UNAUTHORIZED_DISPENSE` | CRITICAL |
| Unexplained tank stock loss | Compare ATG readings against pump sales and deliveries (variance engine) | `TANK_VARIANCE` | CRITICAL |
| Unusual late-night fueling | Flag transactions outside approved schedules | `AFTER_HOURS` | MEDIUM |
| Suspicious repeated transactions | Detect frequency, quantity and timing anomalies | `REFUEL_FREQUENCY` / `SPLIT_DISPENSE` | HIGH |
| Pump controller disconnected | Alert and **disable remote authorization** where supported (fallback to supervised manual mode) | `CONTROLLER_OFFLINE` | HIGH |
| Unusual customer fuel consumption | Compare with historical consumption baselines and vehicle limits | `CONSUMPTION_ANOMALY` | MEDIUM |
| Attendant and driver collusion | Correlate repeated suspicious interactions and exceptions across the pair | `COLLUSION_PATTERN` | HIGH |

### 4.2 Supplementary rule catalog

| Code | Trigger | Severity | Auto action |
|------|---------|----------|-------------|
| `VOLUME_GT_TANK` | dispense volume > vehicle tank capacity × 1.05 | HIGH | BLOCK_AUTH |
| `OTP_BRUTE_FORCE` | ≥5 failed OTP validations / 10 min / station | HIGH | station cooldown |
| `TOTALIZER_MISMATCH` | nozzle totalizer delta vs. recorded txns > 0.5% at close | HIGH | — |
| `OFFLINE_ABUSE` | station exceeds offline-validated txn ratio threshold | MEDIUM | — |
| `GEOFENCE_BREACH` | delivery truck deviates > X km from route corridor or unscheduled stop > Y min | HIGH | notify logistics |
| `DELIVERY_SHORTAGE` | offloaded qty < loaded qty − transit tolerance | CRITICAL | hold PoD completion |
| `ODOMETER_ROLLBACK` | odometer entered lower than previous reading | MEDIUM | — |
| `CONTAINER_DIVERSION` | cross-signal mismatch from §5 technologies (e.g. vehicle fuel level did not rise by dispensed amount) | CRITICAL | investigation case |

### 4.3 Risk scoring & graduated response

Risk score = rule base severity × contextual multipliers (actor history, station history,
value at risk, pair/collusion history). Alerts above threshold page the fraud room
(WebSocket + SMS).

**Graduated response for high-confidence detections:**
1. **Pause for supervisor verification** (default): the Maestro Controller holds the
   dispense at the next safe point; the Android App (Attendant mode) / Supplier workspace prompts a
   supervisor to verify on the spot (`PAUSE_SUPERVISOR` action). The transaction resumes,
   is reduced, or is terminated based on the verification outcome — all recorded.
2. **Automatic shutdown** (`PUMP_CUTOFF`) is only enabled where the controller and
   dispensing equipment **support safe interruption** — per-pump capability flag
   (`supports_safe_interruption`); bulk flow meters and legacy pumps without safe-stop
   default to pause + alarm instead. Safety always outranks loss prevention.

Blocking actions (`BLOCK_AUTH`, `REQUIRE_IDENTITY`) execute synchronously inside the
dispense flow; everything else is evaluated asynchronously via RabbitMQ within seconds.

### 4.4 Protected investigation records

Every **high-risk event** (CRITICAL severity or risk score above the evidence threshold)
automatically assembles a **protected investigation record** containing:

- a short **CCTV evidence clip** (pre/post-roll around the event, from the fueling-zone camera),
- full **transaction data** (order, authorization, dispense transaction references),
- **pump readings** (flow trace, totalizer before/after),
- **driver identity** (profile, verification method used, signature if captured),
- **GPS location** (site coordinates; truck position for delivery events).

Protection guarantees: records are **append-only**, stored with a SHA-256 content hash
chained to the previous record (tamper-evident), replicated to versioned object storage
with legal-hold retention, and access-controlled to fraud-investigator roles with every
access audited.

## 5. Detecting fuel diverted into containers

Pump flow readings alone cannot prove where the fuel physically went — a nozzle filling a
jerry can produces the same flow profile as one filling the authorized vehicle. Maestro
Sentinel therefore **fuses four independent technologies**; each alone is defeatable, but a
diversion must defeat all four simultaneously:

| # | Technology | What it proves | Integration |
|---|-----------|----------------|-------------|
| 1 | **Vehicle tag / filler-neck ring interlock** (RFID ring on the vehicle's filler neck + reader on the nozzle) | The nozzle is physically inserted into the *authorized vehicle's* tank; flow is only enabled while the tag is read | Maestro Controller enables flow only while the tag reads and cuts flow on tag loss; tag ID checked against `vehicle_tags` |
| 2 | **AI CCTV analytics** (ANPR + fueling-zone cameras, integrated via **ONVIF / supported VMS APIs**) | The authorized vehicle (plate) is present at that pump during the dispense; computer vision monitors the fueling zone for **visible containers**, **nozzle movement away from the vehicle** and **unusual attendant behavior** (loitering at idle pumps, repeated off-camera handoffs) | `anpr_events` matched to the dispense window; vision detections (`CONTAINER_DETECTED`, `NOZZLE_AWAY`, `ATTENDANT_BEHAVIOR`) raise `CONTAINER_DIVERSION` / `COLLUSION_PATTERN` evidence with video clip refs |
| 3 | **Vehicle telematics cross-check** (CAN-bus/fuel-level sender via telematics unit) | The vehicle's own fuel level rose by ≈ the dispensed litres shortly after the transaction | `telematics_readings` compared to `fuel_transactions`; mismatch beyond tolerance → `CONTAINER_DIVERSION` |
| 4 | **Flow pattern analysis** | Identifies suspicious flow interruptions (nozzle lifts mid-dispense), abnormal dispensing durations vs. volume, and repeated small-volume transactions consistent with decanting into containers; corroborated by odometer-vs-volume implausibility | Sentinel models on `meter_readings` flow traces (interruption count, duration, flow-rate profile) + transaction frequency/volume history; feeds `SPLIT_DISPENSE` and `CONTAINER_DIVERSION`; corroborates signals 1–3 |

**Fusion logic:** each signal contributes a confidence weight; a dispense with
(tag absent ∨ tag lost mid-flow) ∧ (no telematics rise) escalates straight to CRITICAL,
triggers the graduated response (§4.3) and assembles a protected investigation record
(§4.4) with the CCTV clip, flow trace and telematics curve attached. Sites without full
hardware degrade gracefully — available signals still score, and hardware coverage per
site is recorded so confidence thresholds adapt.

## 6. Platform security controls

- **Transport**: TLS 1.2+ everywhere; HSTS; mTLS for devices.
- **Secrets**: cloud KMS / secret manager; no secrets in code or client bundles
  (clients get short-lived tokens, never signing keys — only the *public* key ships).
- **Data**: AES-256 at rest (managed), PII column minimization, field-level encryption for
  license numbers; configurable data-retention jobs.
- **Audit**: interceptor writes append-only `audit_log` (actor, action, before/after, IP)
  for every mutation; log shipping to immutable storage.
- **Web Portal hardening**: strict CSP, SRI, HttpOnly/SameSite session handling via the
  gateway, no tokens in localStorage, dependency audit in CI.
- **Android App hardening**: managed devices (MDM), kiosk/lock-task
  mode, Play Integrity / device attestation at enrollment, encrypted local queue, remote
  wipe of device tokens.
- **API**: input validation (Bean Validation / JSR 380 DTOs), output serialization whitelists,
  rate limiting per principal, idempotency keys, OWASP ASVS L2 target.
- **Compliance posture**: financial records immutable 7 years; GDPR-style subject access
  and erasure (where legally allowed) via anonymization of personal fields.
