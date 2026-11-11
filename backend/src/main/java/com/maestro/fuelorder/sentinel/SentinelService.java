package com.maestro.fuelorder.sentinel;

import tools.jackson.databind.ObjectMapper;
import com.maestro.fuelorder.dispense.FuelTransaction;
import com.maestro.fuelorder.dispense.FuelTransactionRepository;
import com.maestro.fuelorder.dispense.OtpAuthorizationRepository;
import com.maestro.fuelorder.notify.NotificationService;
import com.maestro.fuelorder.order.FuelOrder;
import com.maestro.fuelorder.order.OrderService;
import com.maestro.fuelorder.registry.Vehicle;
import com.maestro.fuelorder.registry.VehicleRepository;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;

import java.math.BigDecimal;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.time.Duration;
import java.time.Instant;
import java.time.LocalTime;
import java.time.ZoneId;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

/**
 * Maestro Sentinel: deterministic rules that run synchronously in the dispense path. Every hit becomes a
 * scored risk event; HIGH and CRITICAL hits also open an investigation case and seal a hash-chained
 * evidence record. Blocking actions (revoking an authorization) happen here, before fuel can flow.
 */
@Service
public class SentinelService {

    /** The detection catalogue shown in the portal. */
    public static final List<Map<String, String>> CATALOG = List.of(
            rule("OTP_REUSE", "CRITICAL", "A redeemed OTP was presented again", "Blocked; security alerted"),
            rule("OTP_BRUTE_FORCE", "HIGH", "5+ wrong OTPs from one attendant in 10 minutes", "Alert; attendant locked out"),
            rule("WRONG_DRIVER_PIN", "MEDIUM", "Driver identity PIN did not match", "3 misses revoke the authorization"),
            rule("OVER_DISPENSE", "HIGH", "Dispense above the authorized litres", "Refused at the approved limit"),
            rule("AFTER_HOURS", "MEDIUM", "Fuel dispensed outside 05:00-22:00", "Flagged for review"),
            rule("REFUEL_FREQUENCY", "HIGH", "Same vehicle fuelled again within 6 hours", "Flagged; case opened"),
            rule("SPLIT_DISPENSE", "MEDIUM", "3+ fills for one vehicle in a day", "Flagged for review"),
            rule("VOLUME_GT_TANK", "HIGH", "Dispensed more than the vehicle's tank", "Case opened"),
            rule("CONSUMPTION_ANOMALY", "MEDIUM", "Fill is over twice the vehicle's usual", "Flagged for review"),
            rule("COLLUSION_PATTERN", "HIGH", "Same attendant and driver repeatedly involved in alerts", "Case opened"),
            rule("TANK_VARIANCE", "CRITICAL", "Tank stock loss beyond tolerance", "Case opened"),
            rule("DELIVERY_SHORTAGE", "CRITICAL", "Delivered less than loaded", "Case opened"),
            rule("CONTAINER_DIVERSION", "CRITICAL", "CCTV saw a container at the nozzle", "Case opened with evidence"),
            rule("WRONG_VEHICLE", "HIGH", "Plate at the pump differs from the authorized vehicle", "Case opened"),
            rule("ATTENDANT_BEHAVIOR", "MEDIUM", "CCTV flagged unusual attendant behaviour", "Flagged for review"),
            rule("CONTROLLER_OFFLINE", "HIGH", "Pump controller stopped reporting", "Remote authorization disabled"));

    private static Map<String, String> rule(String code, String severity, String trigger, String response) {
        return Map.of("code", code, "severity", severity, "trigger", trigger, "response", response);
    }

    private final RiskEventRepository events;
    private final FraudCaseRepository cases;
    private final EvidenceRecordRepository evidence;
    private final RiskScorer scorer;
    private final NotificationService notifications;
    private final OtpAuthorizationRepository authorizations;
    private final FuelTransactionRepository transactions;
    private final VehicleRepository vehicles;
    private final ObjectMapper mapper;

    public SentinelService(RiskEventRepository events, FraudCaseRepository cases, EvidenceRecordRepository evidence,
                           RiskScorer scorer, NotificationService notifications,
                           OtpAuthorizationRepository authorizations, FuelTransactionRepository transactions,
                           VehicleRepository vehicles, ObjectMapper mapper) {
        this.events = events;
        this.cases = cases;
        this.evidence = evidence;
        this.scorer = scorer;
        this.notifications = notifications;
        this.authorizations = authorizations;
        this.transactions = transactions;
        this.vehicles = vehicles;
        this.mapper = mapper;
    }

    /**
     * Records a rule hit. Runs in its own transaction so the event survives even when the request that
     * triggered it (a refused dispense, say) rolls back.
     */
    @Transactional(propagation = Propagation.REQUIRES_NEW)
    public RiskEvent raise(String rule, String severity, String org, String siteCode, String vehicle,
                           String driver, String attendant, String refType, UUID refId, String details,
                           String autoAction, Map<String, Object> extraEvidence) {
        Instant weekAgo = Instant.now().minus(Duration.ofDays(7));
        int prior = (int) events.findByCreatedAtAfter(weekAgo).stream()
                .filter(e -> (attendant != null && attendant.equals(e.getAttendantName()))
                        || (driver != null && driver.equals(e.getDriverName())))
                .count();
        RiskEvent e = events.save(new RiskEvent(rule, severity, scorer.score(rule, severity, prior), org, siteCode,
                vehicle, driver, attendant, refType, refId, details, autoAction));
        if (RiskEvent.HIGH.equals(severity) || RiskEvent.CRITICAL.equals(severity)) {
            cases.save(new FraudCase(e.getId()));
            seal(e, extraEvidence);
        }
        notifications.inApp(OrderService.SUPPLIER_ORG, "ALERT",
                "[%s] %s: %s".formatted(severity, rule, details), e.getId().toString());
        if (org != null && !RiskEvent.LOW.equals(severity)) {
            notifications.inApp(org, "ALERT", "[%s] %s: %s".formatted(severity, rule, details), e.getId().toString());
        }
        if (attendant != null && driver != null && !"COLLUSION_PATTERN".equals(rule)) {
            checkCollusion(e, weekAgo);
        }
        return e;
    }

    private void checkCollusion(RiskEvent latest, Instant since) {
        List<RiskEvent> pair = events.findByCreatedAtAfter(since).stream()
                .filter(x -> latest.getAttendantName().equals(x.getAttendantName())
                        && latest.getDriverName().equals(x.getDriverName()))
                .toList();
        boolean already = pair.stream().anyMatch(x -> "COLLUSION_PATTERN".equals(x.getRule()));
        long hits = pair.stream().filter(x -> !"COLLUSION_PATTERN".equals(x.getRule())).count();
        if (hits >= 3 && !already) {
            raise("COLLUSION_PATTERN", RiskEvent.HIGH, latest.getOrganization(), latest.getSiteCode(), null,
                    latest.getDriverName(), latest.getAttendantName(), "RISK_EVENT", latest.getId(),
                    "%s and %s were both involved in %d alerts this week".formatted(
                            latest.getAttendantName(), latest.getDriverName(), hits), "NONE", Map.of());
        }
    }

    /** Appends a tamper-evident evidence record to the chain. */
    private void seal(RiskEvent e, Map<String, Object> extra) {
        Map<String, Object> content = new LinkedHashMap<>();
        content.put("riskEventId", e.getId());
        content.put("rule", e.getRule());
        content.put("severity", e.getSeverity());
        content.put("at", e.getCreatedAt());
        content.put("site", e.getSiteCode());
        content.put("vehicle", e.getVehicleReg());
        content.put("driver", e.getDriverName());
        content.put("attendant", e.getAttendantName());
        content.put("details", e.getDetails());
        if (extra != null) {
            content.putAll(extra);
        }
        String json;
        try {
            json = mapper.writeValueAsString(content);
        } catch (Exception ex) {
            throw new IllegalStateException(ex);
        }
        String prev = evidence.findAllByOrderByCreatedAtAsc().stream()
                .reduce((a, b) -> b).map(EvidenceRecord::getContentHash).orElse("GENESIS");
        evidence.save(new EvidenceRecord(e.getId(), json, prev, sha256(prev + json)));
    }

    /** Walks the whole chain and reports the first record whose hash no longer matches. */
    public Map<String, Object> verifyChain() {
        String prev = "GENESIS";
        int n = 0;
        for (EvidenceRecord r : evidence.findAllByOrderByCreatedAtAsc()) {
            n++;
            if (!r.getPrevHash().equals(prev) || !r.getContentHash().equals(sha256(prev + r.getContent()))) {
                return Map.of("valid", false, "records", n, "brokenAt", r.getId().toString());
            }
            prev = r.getContentHash();
        }
        return Map.of("valid", true, "records", n);
    }

    @Transactional
    public void blockAuthorization(UUID authorizationId) {
        authorizations.findById(authorizationId).ifPresent(a -> { a.revoke(); authorizations.save(a); });
    }

    /** Post-dispense rules over the vehicle's own history. */
    @Transactional(propagation = Propagation.REQUIRES_NEW)
    public void onDispense(FuelTransaction tx, FuelOrder order) {
        Map<String, Object> ev = new LinkedHashMap<>();
        ev.put("transactionId", tx.getId());
        ev.put("orderNumber", order.getNumber());
        ev.put("litres", tx.getVolumeLitres());
        ev.put("amount", tx.getAmount());
        ev.put("pumpMode", "MANUAL");
        ev.put("site", order.getSiteCode());

        LocalTime t = tx.getDispensedAt().atZone(ZoneId.systemDefault()).toLocalTime();
        if (t.isBefore(LocalTime.of(5, 0)) || t.isAfter(LocalTime.of(22, 0))) {
            raise("AFTER_HOURS", RiskEvent.MEDIUM, order.getCustomerName(), order.getSiteCode(), tx.getVehicleReg(),
                    tx.getDriverName(), tx.getAttendantName(), "TRANSACTION", tx.getId(),
                    "Dispense at " + t.withNano(0) + ", outside 05:00-22:00", "NONE", ev);
        }

        // 90 days of this vehicle's history is plenty for the frequency and average checks
        List<FuelTransaction> sameVehicle = transactions
                .findByVehicleRegAndDispensedAtGreaterThanEqual(tx.getVehicleReg(), tx.getDispensedAt().minus(Duration.ofDays(90)))
                .stream().filter(x -> !x.getId().equals(tx.getId())).toList();
        boolean recent = sameVehicle.stream()
                .anyMatch(x -> Duration.between(x.getDispensedAt(), tx.getDispensedAt()).abs().toHours() < 6);
        if (recent) {
            raise("REFUEL_FREQUENCY", RiskEvent.HIGH, order.getCustomerName(), order.getSiteCode(),
                    tx.getVehicleReg(), tx.getDriverName(), tx.getAttendantName(), "TRANSACTION", tx.getId(),
                    tx.getVehicleReg() + " was already fuelled less than 6 hours ago", "NONE", ev);
        }
        long today = sameVehicle.stream()
                .filter(x -> x.getDispensedAt().atZone(ZoneId.systemDefault()).toLocalDate()
                        .equals(tx.getDispensedAt().atZone(ZoneId.systemDefault()).toLocalDate()))
                .count() + 1;
        if (today >= 3) {
            raise("SPLIT_DISPENSE", RiskEvent.MEDIUM, order.getCustomerName(), order.getSiteCode(),
                    tx.getVehicleReg(), tx.getDriverName(), tx.getAttendantName(), "TRANSACTION", tx.getId(),
                    today + " fills for " + tx.getVehicleReg() + " today", "NONE", ev);
        }

        vehicles.findByOrganizationAndRegistrationIgnoreCaseAndActiveTrue(order.getCustomerName(), tx.getVehicleReg())
                .ifPresent(v -> checkVehicle(v, tx, order, sameVehicle, ev));
    }

    private void checkVehicle(Vehicle v, FuelTransaction tx, FuelOrder order, List<FuelTransaction> history,
                              Map<String, Object> ev) {
        if (tx.getVolumeLitres().compareTo(v.getTankCapacityLitres()) > 0) {
            raise("VOLUME_GT_TANK", RiskEvent.HIGH, order.getCustomerName(), order.getSiteCode(), tx.getVehicleReg(),
                    tx.getDriverName(), tx.getAttendantName(), "TRANSACTION", tx.getId(),
                    tx.getVolumeLitres() + " L exceeds the " + v.getTankCapacityLitres() + " L tank", "NONE", ev);
        }
        if (history.size() >= 3) {
            BigDecimal avg = history.stream().map(FuelTransaction::getVolumeLitres)
                    .reduce(BigDecimal.ZERO, BigDecimal::add)
                    .divide(BigDecimal.valueOf(history.size()), 2, java.math.RoundingMode.HALF_UP);
            if (tx.getVolumeLitres().compareTo(avg.multiply(BigDecimal.valueOf(2))) > 0) {
                raise("CONSUMPTION_ANOMALY", RiskEvent.MEDIUM, order.getCustomerName(), order.getSiteCode(),
                        tx.getVehicleReg(), tx.getDriverName(), tx.getAttendantName(), "TRANSACTION", tx.getId(),
                        "Fill of %s L is over twice this vehicle's average of %s L".formatted(tx.getVolumeLitres(), avg),
                        "NONE", ev);
            }
        }
    }

    public static String sha256(String value) {
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256")
                    .digest(value.getBytes(StandardCharsets.UTF_8)));
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }
}
