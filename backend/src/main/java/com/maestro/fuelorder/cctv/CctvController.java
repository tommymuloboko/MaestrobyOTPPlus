package com.maestro.fuelorder.cctv;

import com.maestro.fuelorder.auth.Access;
import com.maestro.fuelorder.dispense.FuelTransaction;
import com.maestro.fuelorder.dispense.FuelTransactionRepository;
import com.maestro.fuelorder.order.FuelOrder;
import com.maestro.fuelorder.order.FuelOrderRepository;
import com.maestro.fuelorder.sentinel.RiskEvent;
import com.maestro.fuelorder.sentinel.SentinelService;
import com.maestro.fuelorder.site.Site;
import com.maestro.fuelorder.site.SiteCatalog;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.validation.Valid;
import jakarta.validation.constraints.DecimalMax;
import jakarta.validation.constraints.DecimalMin;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Pattern;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.*;

import java.time.Duration;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;

/**
 * Receives detections from the site VMS (ONVIF analytics events or a vendor webhook mapped to this shape)
 * and ties each one to the dispense it overlaps in time. A live ONVIF/RTSP connection is not part of the
 * skeleton; this is the seam it would feed.
 */
@RestController
@RequestMapping("/api/v1/cctv")
public class CctvController {

    private static final double MIN_CONFIDENCE = 0.8;
    private static final Duration WINDOW = Duration.ofMinutes(10);

    public record EventRequest(@NotBlank String siteCode, @NotBlank String cameraId,
                               @NotBlank @Pattern(regexp = "CONTAINER_DETECTED|NOZZLE_AWAY|ATTENDANT_BEHAVIOR|ANPR") String kind,
                               String plate, @DecimalMin("0") @DecimalMax("1") double confidence, String clipRef) {}

    private final CctvEventRepository events;
    private final FuelTransactionRepository transactions;
    private final FuelOrderRepository orders;
    private final SentinelService sentinel;
    private final SiteCatalog siteCatalog;

    public CctvController(CctvEventRepository events, FuelTransactionRepository transactions,
                          FuelOrderRepository orders, SentinelService sentinel, SiteCatalog siteCatalog) {
        this.events = events;
        this.transactions = transactions;
        this.orders = orders;
        this.sentinel = sentinel;
        this.siteCatalog = siteCatalog;
    }

    @PostMapping("/events")
    @ResponseStatus(HttpStatus.CREATED)
    public CctvEvent ingest(@RequestBody @Valid EventRequest r, HttpServletRequest request) {
        Access.requireSupplier(Access.session(request));
        CctvEvent e = new CctvEvent(r.siteCode(), r.cameraId(), r.kind(), r.plate(), r.confidence(), r.clipRef());
        FuelTransaction tx = recentDispense(r.siteCode(), e.at).orElse(null);
        if (r.confidence() >= MIN_CONFIDENCE) {
            RiskEvent risk = evaluate(e, tx);
            if (risk != null) {
                e.riskEventId = risk.getId();
            }
        }
        return events.save(e);
    }

    @GetMapping("/events")
    public List<CctvEvent> list(HttpServletRequest request) {
        Access.requireStaff(Access.session(request));
        return events.findTop200ByOrderByAtDesc();
    }

    private RiskEvent evaluate(CctvEvent e, FuelTransaction tx) {
        Map<String, Object> ev = new LinkedHashMap<>();
        ev.put("camera", e.cameraId);
        ev.put("cctvKind", e.kind);
        ev.put("confidence", e.confidence);
        ev.put("clipRef", String.valueOf(e.clipRef));
        if (tx != null) {
            ev.put("transactionId", tx.getId());
            ev.put("litres", tx.getVolumeLitres());
        }
        String org = tx == null ? null : orders.findById(tx.getOrderId()).map(FuelOrder::getCustomerName).orElse(null);
        String vehicle = tx == null ? null : tx.getVehicleReg();
        String driver = tx == null ? null : tx.getDriverName();
        String attendant = tx == null ? null : tx.getAttendantName();
        UUID ref = tx == null ? null : tx.getId();
        return switch (e.kind) {
            case "CONTAINER_DETECTED" -> sentinel.raise("CONTAINER_DIVERSION", RiskEvent.CRITICAL, org, e.siteCode,
                    vehicle, driver, attendant, "TRANSACTION", ref,
                    "Camera %s saw a container at the pump (%.0f%% confidence)".formatted(e.cameraId, e.confidence * 100),
                    "CASE_OPENED", ev);
            case "NOZZLE_AWAY" -> tx == null ? null : sentinel.raise("CONTAINER_DIVERSION", RiskEvent.HIGH, org,
                    e.siteCode, vehicle, driver, attendant, "TRANSACTION", ref,
                    "Nozzle moved away from the vehicle during a dispense (camera " + e.cameraId + ")", "CASE_OPENED", ev);
            case "ATTENDANT_BEHAVIOR" -> sentinel.raise("ATTENDANT_BEHAVIOR", RiskEvent.MEDIUM, org, e.siteCode,
                    vehicle, driver, attendant, "TRANSACTION", ref,
                    "Unusual attendant behaviour flagged by camera " + e.cameraId, "NONE", ev);
            case "ANPR" -> tx != null && e.plate != null && !normal(e.plate).equals(normal(tx.getVehicleReg()))
                    ? sentinel.raise("WRONG_VEHICLE", RiskEvent.HIGH, org, e.siteCode, vehicle, driver, attendant,
                    "TRANSACTION", ref, "Plate %s at the pump but fuel was authorized for %s".formatted(e.plate, vehicle),
                    "CASE_OPENED", ev)
                    : null;
            default -> null;
        };
    }

    /** The most recent dispense at this site inside the matching window. */
    private Optional<FuelTransaction> recentDispense(String siteCode, Instant at) {
        String siteName = siteCatalog.find(siteCode).map(Site::getName).orElse(null);
        if (siteName == null) {
            return Optional.empty();
        }
        return transactions.findBySiteNameAndDispensedAtBetween(siteName, at.minus(WINDOW), at.plus(WINDOW)).stream()
                .max((a, b) -> a.getDispensedAt().compareTo(b.getDispensedAt()));
    }

    private static String normal(String plate) {
        return plate.replaceAll("[^A-Za-z0-9]", "").toUpperCase();
    }
}
