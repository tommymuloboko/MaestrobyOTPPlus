package com.maestro.fuelorder.recon;

import com.maestro.fuelorder.integration.PumpEvent;
import com.maestro.fuelorder.integration.PumpEventRepository;
import com.maestro.fuelorder.integration.TankReading;
import com.maestro.fuelorder.integration.TankReadingRepository;
import com.maestro.fuelorder.sentinel.RiskEvent;
import com.maestro.fuelorder.sentinel.SentinelService;
import com.maestro.fuelorder.site.Site;
import com.maestro.fuelorder.site.SiteCatalog;
import com.maestro.fuelorder.stock.StockMovement;
import com.maestro.fuelorder.stock.StockMovementRepository;
import com.maestro.fuelorder.stock.Tank;
import com.maestro.fuelorder.stock.TankRepository;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpStatus;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.server.ResponseStatusException;

import java.math.BigDecimal;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import java.util.stream.Collectors;

/**
 * Daily site close. Two independent checks: what the tank gauge says against what the books say should
 * be in the tank, and what the pump totalizers say against what was recorded as sold. Anything outside
 * tolerance becomes an exception for a person to explain, and a Sentinel risk event.
 */
@Service
public class ReconciliationService {

    private static final Logger log = LoggerFactory.getLogger(ReconciliationService.class);
    private static final BigDecimal MIN_TOLERANCE = BigDecimal.valueOf(50);
    private static final BigDecimal TOLERANCE_PCT = new BigDecimal("0.005");

    private final TankRepository tanks;
    private final StockMovementRepository movements;
    private final TankReadingRepository readings;
    private final PumpEventRepository pumpEvents;
    private final ReconciliationRunRepository runs;
    private final VarianceExceptionRepository exceptions;
    private final SentinelService sentinel;
    private final SiteCatalog siteCatalog;

    public ReconciliationService(TankRepository tanks, StockMovementRepository movements,
                                 TankReadingRepository readings, PumpEventRepository pumpEvents,
                                 ReconciliationRunRepository runs, VarianceExceptionRepository exceptions,
                                 SentinelService sentinel, SiteCatalog siteCatalog) {
        this.tanks = tanks;
        this.movements = movements;
        this.readings = readings;
        this.pumpEvents = pumpEvents;
        this.runs = runs;
        this.exceptions = exceptions;
        this.sentinel = sentinel;
        this.siteCatalog = siteCatalog;
    }

    @Transactional
    public ReconciliationRun close(String siteCode, LocalDate date) {
        if (siteCatalog.find(siteCode).isEmpty()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Unknown site " + siteCode);
        }
        ZoneId zone = ZoneId.systemDefault();
        Instant from = date.atStartOfDay(zone).toInstant();
        Instant to = date.plusDays(1).atStartOfDay(zone).toInstant();
        ReconciliationRun run = runs.save(new ReconciliationRun(siteCode, date));
        StringBuilder notes = new StringBuilder();
        BigDecimal soldAtSite = BigDecimal.ZERO;

        for (Tank t : tanks.findAll().stream().filter(x -> x.getSiteCode().equals(siteCode)).toList()) {
            List<StockMovement> all = movements.findBySiteCodeAndProduct(siteCode, t.getProduct());
            BigDecimal book = t.getOpeningLitres().add(all.stream().filter(m -> m.getAt().isBefore(to))
                    .map(StockMovement::getLitres).reduce(BigDecimal.ZERO, BigDecimal::add));
            BigDecimal sold = all.stream().filter(m -> StockMovement.DISPENSE.equals(m.getKind())
                            && !m.getAt().isBefore(from) && m.getAt().isBefore(to))
                    .map(m -> m.getLitres().abs()).reduce(BigDecimal.ZERO, BigDecimal::add);
            soldAtSite = soldAtSite.add(sold);
            TankReading measured = readings.findFirstBySiteCodeAndProductAndAtBeforeOrderByAtDesc(
                    siteCode, t.getProduct(), to).orElse(null);
            if (measured == null) {
                notes.append(t.getProduct()).append(": no gauge reading. ");
                continue;
            }
            BigDecimal variance = measured.volumeLitres.subtract(book);
            if (variance.abs().compareTo(tolerance(sold)) > 0) {
                flag(run, t.getProduct(), "TANK_VARIANCE", book, measured.volumeLitres, variance);
                sentinel.raise("TANK_VARIANCE", RiskEvent.CRITICAL, null, siteCode, null, null, null, "TANK", t.getId(),
                        "%s at %s: gauge %s L vs books %s L (%s L)".formatted(t.getProduct(), siteCode,
                                measured.volumeLitres, book, variance), "NONE",
                        Map.of("product", t.getProduct(), "bookLitres", book, "gaugeLitres", measured.volumeLitres));
            }
            notes.append(t.getProduct()).append(" gauge ").append(measured.volumeLitres).append(" vs books ")
                    .append(book).append(". ");
        }

        BigDecimal totalizer = totalizerDelta(siteCode, from, to);
        run.dispensedLitres = soldAtSite;
        run.totalizerLitres = totalizer;
        if (totalizer != null && soldAtSite.subtract(totalizer).abs().compareTo(tolerance(soldAtSite)) > 0) {
            flag(run, null, "TOTALIZER_MISMATCH", soldAtSite, totalizer, totalizer.subtract(soldAtSite));
            sentinel.raise("TANK_VARIANCE", RiskEvent.HIGH, null, siteCode, null, null, null, "SITE", run.id,
                    "Pump totalizers moved %s L but %s L was recorded as sold at %s".formatted(totalizer, soldAtSite, siteCode),
                    "NONE", Map.of("totalizerLitres", totalizer, "soldLitres", soldAtSite));
        } else if (totalizer == null) {
            notes.append("No totalizer data. ");
        }
        run.summary = notes.toString().trim();
        run.status = run.exceptions == 0 ? "OK" : "EXCEPTIONS";
        return runs.save(run);
    }

    private void flag(ReconciliationRun run, String product, String kind, BigDecimal expected,
                      BigDecimal actual, BigDecimal variance) {
        exceptions.save(new VarianceException(run.id, run.siteCode, product, kind, expected, actual, variance));
        run.exceptions++;
    }

    private static BigDecimal tolerance(BigDecimal throughput) {
        return MIN_TOLERANCE.max(throughput.multiply(TOLERANCE_PCT));
    }

    /** Sum over pumps of (last - first) totalizer reading inside the window; null when there are none. */
    private BigDecimal totalizerDelta(String siteCode, Instant from, Instant to) {
        List<PumpEvent> ev = pumpEvents.findBySiteCodeAndKindAndAtBetweenOrderByAtAsc(siteCode, "TOTALIZER", from, to);
        if (ev.isEmpty()) {
            return null;
        }
        Map<String, List<PumpEvent>> byPump = ev.stream().collect(Collectors.groupingBy(e -> e.pumpId, TreeMap::new, Collectors.toList()));
        return byPump.values().stream()
                .map(l -> l.get(l.size() - 1).value.subtract(l.get(0).value))
                .reduce(BigDecimal.ZERO, BigDecimal::add);
    }

    @Transactional
    public VarianceException resolve(java.util.UUID id, String by, String note) {
        VarianceException e = exceptions.findById(id)
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND, "Exception not found"));
        e.status = "RESOLVED";
        e.resolvedBy = by;
        e.note = note;
        return exceptions.save(e);
    }

    /** Closes every site at the end of the day. */
    @Scheduled(cron = "${maestro.recon.cron:0 59 23 * * *}")
    public void closeAllSites() {
        for (Site s : siteCatalog.all()) {
            try {
                close(s.getCode(), LocalDate.now());
            } catch (RuntimeException e) {
                log.warn("Daily close failed for {}: {}", s.getCode(), e.getMessage());
            }
        }
    }
}
