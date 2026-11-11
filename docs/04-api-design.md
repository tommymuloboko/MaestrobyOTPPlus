# 04 · API Design

## 1. Principles

- REST over HTTPS, JSON bodies; base path `/api/v1`.
- Auth: `Authorization: Bearer <JWT>` (users) or mTLS + device token (devices/Android
  terminals). Tokens are issued and validated by the **Spring Boot API Gateway**, which also
  enforces permissions and injects signed tenant context before requests reach domain services.
- Pagination: `?page=&pageSize=` with `X-Total-Count`; filtering via documented query params.
- Idempotency: mutating endpoints that may be retried accept `Idempotency-Key` header
  (orders, dispenses, payments).
- Errors: RFC 7807 problem+json → `{ type, title, status, detail, code, traceId }` with
  stable machine codes (`ORDER_LIMIT_EXCEEDED`, `OTP_INVALID`, `OTP_EXPIRED`, …).
- OpenAPI generated from Spring Boot decorators; published per environment.

## 2. REST resources by module

### Auth & identity
```
POST   /auth/login                     # email/phone + password (+ MFA)
POST   /auth/refresh
POST   /auth/logout
GET    /me
POST   /organizations                  # platform admin
GET    /organizations/{id}
POST   /organizations/{id}/users
GET/POST        /organizations/{id}/branches        # customer branch management
PATCH  /users/{id}                     # roles, status
GET    /organizations/{id}/credit-balance           # credit limit, used, available
```

### M6 · Fleet
```
GET/POST        /vehicles
GET/PATCH       /vehicles/{id}
GET/POST        /drivers
POST            /vehicles/{id}/assignments          # driver↔vehicle
GET/PUT         /fuel-limits                        # scope-based limits
GET             /fleet/analytics/consumption?groupBy=vehicle|department&period=...
GET             /fleet/analytics/anomalies
```

### M4 · Pricing & contracts
```
GET/POST        /price-lists                        # versioned
POST            /price-lists/{id}/activate
GET/POST        /contracts
GET/PATCH       /contracts/{id}
POST            /contracts/{id}/price-rules         # created PENDING_APPROVAL
POST            /price-rules/{id}/approve           # FINANCE role; approver ≠ proposer;
                                                    # activates on effective date
GET/POST        /tax-rules
GET/POST        /delivery-surcharges
GET             /pricing/changes?contractId=&from=  # price change log: previous price,
                                                    # new price, proposer, approver, effective date
GET             /pricing/resolve?orgId=&branchId=&productId=&qty=&siteId=&date=   # price preview
                # returns resolved net price, taxes, surcharges + which rule/list won;
                # always resolved per customer org — same site can yield different
                # prices for different customers.
                # NOTE: no endpoint exists to override a resolved price at the point of
                # sale — attendant/station roles have no price-write permissions.
```

### M1 · Orders & approvals
```
GET/POST        /orders
GET             /orders/{id}
POST            /orders/{id}/submit                 # DRAFT → PENDING_APPROVAL
POST            /orders/{id}/cancel
GET             /approvals/pending                  # customer approver inbox
POST            /orders/{id}/approvals/{stepNo}     # { decision, reason }
GET/PUT         /approval-policies
POST            /orders/standing                    # recurring orders
POST   /supplier/orders                             # supplier-initiated order (replenishment /
                                                    # scheduled supply) — customer approves per policy
POST   /orders/{id}/items                           # add/split allocations (per vehicle/truck)
GET    /orders/{id}/balance                         # overall balance vs. per-allocation fulfilment

# supplier side (station/depot operator — Supplier workspace review inbox)
GET    /supplier/orders?status=PENDING_SUPPLIER_REVIEW
GET    /supplier/orders/{id}/checks                 # stock availability, credit limit,
                                                    # contract pricing, dispensing equipment
POST   /supplier/orders/{id}/review                 # { decision: APPROVE|REJECT|REQUEST_CHANGES,
                                                    #   reason } → customer notified immediately
```

### M2 · Dispensing
```
POST   /orders/{id}/lines/{lineId}/authorizations   # issue OTP + QR (approved lines only)
GET    /authorizations/{id}
POST   /authorizations/{id}/revoke
POST   /dispense/validate            # console: { otp | qrToken, stationId, vehicleReg?, driverPin? }
                                     # → authorization summary + armable pumps
POST   /dispense/start               # { authorizationId, pumpId, nozzleId } → arms pump
POST   /dispense/complete            # { dispenseId, volume, totalizerEnd, odometer } (manual mode)
POST   /dispense/offline-sync        # console batch upload of OFFLINE_VALIDATED txns
GET    /dispense/transactions?stationId=&from=&to=
```

### M3 · Stations & monitoring (Wetstock Intelligence)
```
GET/POST        /stations
GET/POST        /stations/{id}/tanks | /pumps | /loading-bays
GET    /stations/{id}/dashboard                     # latest tank levels (incl. TC volume,
                                                    # water), pump & bay states, today totals
GET    /tanks/{id}/readings?from=&to=&resolution=raw|5m|1h&corrected=true
GET    /stations/{id}/variance?date=
POST   /variance/{id}/investigate                   # open leakage investigation case
POST   /tanks/{id}/calibration                      # manual dip entry
```

### M7 · Logistics & deliveries
```
GET/POST        /depots | /depots/{id}/tanks | /trucks
GET/POST        /deliveries
POST   /deliveries/{id}/plan                        # assign truck/compartments/driver
POST   /deliveries/{id}/load                        # depot confirms loaded qty + seals
POST   /deliveries/{id}/depart | /arrive
POST   /deliveries/{id}/offload                     # metered/dip qty into receiving tank
POST   /deliveries/{id}/complete                    # PoD: signature + photos (object storage refs)
GET    /deliveries/{id}/track                       # latest GPS + ETA
```

### M8 · Finance
```
POST   /billing/runs                                # generate invoices for period/org
GET    /invoices?orgId=&status=
GET    /invoices/{id} | /invoices/{id}/pdf          # PDF via JasperReports; Excel via Apache POI
POST   /invoices/{id}/credit-notes
GET/POST        /payments
POST   /payments/{id}/allocate
GET    /statements?orgId=&period=
GET/POST        /reconciliation/runs                # daily station close
GET    /reconciliation/runs/{id}                    # totals vs totalizers vs tank movement
GET    /ledger/entries?account=&from=&to=
```

### Alerts & insights (cross-module)
```
GET/PUT /alert-rules                        # thresholds, severity, escalation chains, channels
GET     /alerts?category=&status=&severity=&ownerId=&siteId=
POST    /alerts/{id}/acknowledge
POST    /alerts/{id}/assign                 # { ownerUserId }
POST    /alerts/{id}/resolve                # { note }
GET/PUT /me/notification-preferences        # channels incl. WhatsApp opt-in
GET     /insights/stockout-forecast?tankId=         # predicted stockout vs next delivery
GET     /insights/pump-health?stationId=            # flow rate vs baseline
GET     /insights/credit-burndown?orgId=            # usage vs credit limit
```

### M5 · Fraud
```
GET/PUT         /fraud/rules
GET    /fraud/alerts?status=&severity=&stationId=
GET    /fraud/alerts/{id}
POST   /fraud/alerts/{id}/status                    # investigate/confirm/dismiss
POST   /fraud/alerts/{id}/verify                    # supervisor on-site verification outcome
                                                    # { decision: RESUME|REDUCE|TERMINATE, notes }
GET    /fraud/alerts/{id}/investigation-record      # protected record (investigator role; access audited)
POST   /fraud/alerts/{id}/notes
GET    /audit-log?entity=&entityId=&actor=&from=&to=
```

## 3. WebSocket events (WebSocket)

Clients join rooms after JWT handshake; server enforces room authorization.

| Room | Event | Payload (summary) |
|------|-------|-------------------|
| `station:{id}` | `tank.level` | tankId, volume, percent, trend |
| `station:{id}` | `pump.state` | pumpId, state (`IDLE`,`ARMED`,`DISPENSING`,`ERROR`), currentVolume |
| `station:{id}` | `dispense.started` / `dispense.completed` | txn summary |
| `station:{id}` | `authorization.pending` | queue for attendant console |
| `org:{id}` | `order.status` | orderId, status, step |
| `org:{id}` | `invoice.issued`, `limit.warning` | |
| `org:{id}` / `station:{id}` / `depot:{id}` | `alert.raised`, `alert.escalated`, `alert.resolved` | alertId, category, severity, subject, owner |
| `delivery:{id}` | `gps` | lat, lng, speed, etaMinutes |
| `delivery:{id}` | `status` | DeliveryStatus transitions |
| `fraud` (HQ) | `alert.raised` | alertId, rule, severity, subject |

## 4. MQTT topics (devices)

```
# upstream (device → cloud)
station/{stationId}/tank/{tankId}/reading      { ts, volumeL, levelMm, tempC, waterMm }
station/{stationId}/pump/{pumpId}/event        { ts, kind, value }         # QoS 1
station/{stationId}/pump/{pumpId}/tag          { ts, nozzleId, tagValue, present }   # filler-ring interlock
station/{stationId}/camera/{camId}/anpr        { ts, plate, confidence, imageRef }
station/{stationId}/camera/{camId}/vision      { ts, kind: CONTAINER_DETECTED | NOZZLE_AWAY | ATTENDANT_BEHAVIOR, confidence, clipRef }
vehicle/{vehicleId}/telematics                 { ts, fuelLevelPct, odometerKm, lat, lng }
truck/{truckId}/gps                            { ts, lat, lng, speed }
+/status                                       # LWT online/offline → CONTROLLER_OFFLINE alert

# downstream (cloud → device)
station/{stationId}/pump/{pumpId}/cmd          { cmd: ARM|PAUSE|RESUME|STOP|DISARM, presetVolumeL?, authRef }  # QoS 1
                                               # STOP honored only where supportsSafeInterruption
station/{stationId}/pump/{pumpId}/cmd/ack
```

Devices authenticate with per-device X.509 certificates (mTLS); broker ACLs restrict each
device to its own topic subtree.

## 5. Versioning & compatibility

- URI versioning (`/api/v1`); additive changes don't bump versions.
- Deprecations announced via `Deprecation` + `Sunset` response headers.
- Clients report their version in `X-Client-Version`; API can force minimum
  versions for security-critical updates (OTP validation logic).
