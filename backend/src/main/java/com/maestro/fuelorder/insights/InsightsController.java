package com.maestro.fuelorder.insights;

import com.maestro.fuelorder.auth.Access;
import com.maestro.fuelorder.auth.AuthService;
import com.maestro.fuelorder.dispense.FuelTransaction;
import com.maestro.fuelorder.dispense.FuelTransactionRepository;
import com.maestro.fuelorder.finance.Invoice;
import com.maestro.fuelorder.finance.InvoiceRepository;
import com.maestro.fuelorder.order.FuelOrder;
import com.maestro.fuelorder.order.FuelOrderRepository;
import com.maestro.fuelorder.recon.VarianceException;
import com.maestro.fuelorder.recon.VarianceExceptionRepository;
import com.maestro.fuelorder.sentinel.RiskEvent;
import com.maestro.fuelorder.sentinel.RiskEventRepository;
import com.maestro.fuelorder.stock.StockMovement;
import com.maestro.fuelorder.stock.StockMovementRepository;
import com.maestro.fuelorder.stock.StockService;
import com.maestro.fuelorder.stock.Tank;
import com.maestro.fuelorder.stock.TankRepository;
import jakarta.servlet.http.HttpServletRequest;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.math.BigDecimal;
import java.math.RoundingMode;
import java.time.Duration;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.stream.Collectors;

/** Consumption analytics, stock forecasting, anomaly surfacing and the management dashboard. */
@RestController
@RequestMapping("/api/v1/insights")
public class InsightsController {

    private final FuelTransactionRepository transactions;
    private final FuelOrderRepository orders;
    private final StockService stock;
    private final StockMovementRepository movements;
    private final TankRepository tanks;
    private final RiskEventRepository risks;
    private final VarianceExceptionRepository exceptions;
    private final InvoiceRepository invoices;

    public InsightsController(FuelTransactionRepository transactions, FuelOrderRepository orders, StockService stock,
                              StockMovementRepository movements, TankRepository tanks, RiskEventRepository risks,
                              VarianceExceptionRepository exceptions, InvoiceRepository invoices) {
        this.transactions = transactions;
        this.orders = orders;
        this.stock = stock;
        this.movements = movements;
        this.tanks = tanks;
        this.risks = risks;
        this.exceptions = exceptions;
        this.invoices = invoices;
    }

    /** Per-vehicle consumption for a customer (or every customer, for staff). */
    @GetMapping("/consumption")
    public List<Map<String, Object>> consumption(HttpServletRequest request) {
        List<FuelTransaction> mine = visible(Access.session(request));
        Map<String, List<FuelTransaction>> byVehicle = mine.stream().collect(Collectors.groupingBy(FuelTransaction::getVehicleReg));
        List<Map<String, Object>> out = new ArrayList<>();
        byVehicle.forEach((reg, txs) -> {
            BigDecimal litres = sum(txs.stream().map(FuelTransaction::getVolumeLitres).toList());
            BigDecimal cost = sum(txs.stream().map(FuelTransaction::getAmount).toList());
            long days = Math.max(1, txs.stream().map(t -> t.getDispensedAt().atZone(ZoneId.systemDefault()).toLocalDate())
                    .distinct().count());
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("vehicle", reg);
            m.put("fills", txs.size());
            m.put("litres", litres);
            m.put("averageFill", litres.divide(BigDecimal.valueOf(txs.size()), 1, RoundingMode.HALF_UP));
            m.put("litresPerActiveDay", litres.divide(BigDecimal.valueOf(days), 1, RoundingMode.HALF_UP));
            m.put("cost", cost);
            out.add(m);
        });
        out.sort((a, b) -> ((BigDecimal) b.get("litres")).compareTo((BigDecimal) a.get("litres")));
        return out;
    }

    /** Fills that are statistically unusual for their own vehicle (more than two standard deviations over). */
    @GetMapping("/anomalies")
    public List<Map<String, Object>> anomalies(HttpServletRequest request) {
        List<Map<String, Object>> out = new ArrayList<>();
        visible(Access.session(request)).stream().collect(Collectors.groupingBy(FuelTransaction::getVehicleReg))
                .forEach((reg, txs) -> {
                    if (txs.size() < 4) {
                        return;
                    }
                    double mean = txs.stream().mapToDouble(t -> t.getVolumeLitres().doubleValue()).average().orElse(0);
                    double sd = Math.sqrt(txs.stream().mapToDouble(t -> Math.pow(t.getVolumeLitres().doubleValue() - mean, 2)).average().orElse(0));
                    if (sd == 0) {
                        return;
                    }
                    txs.stream().filter(t -> (t.getVolumeLitres().doubleValue() - mean) / sd > 2).forEach(t -> {
                        Map<String, Object> m = new LinkedHashMap<>();
                        m.put("vehicle", reg);
                        m.put("litres", t.getVolumeLitres());
                        m.put("usual", Math.round(mean * 10) / 10.0);
                        m.put("zScore", Math.round((t.getVolumeLitres().doubleValue() - mean) / sd * 10) / 10.0);
                        m.put("at", t.getDispensedAt());
                        out.add(m);
                    });
                });
        return out;
    }

    /** Days of cover and predicted stock-out per tank, from the last 14 days of sales. */
    @GetMapping("/stockout")
    public List<Map<String, Object>> stockout(HttpServletRequest request) {
        Access.requireStaff(Access.session(request));
        Instant since = Instant.now().minus(Duration.ofDays(14));
        List<Map<String, Object>> out = new ArrayList<>();
        for (Tank t : tanks.findAll()) {
            BigDecimal sold = movements.findBySiteCodeAndProduct(t.getSiteCode(), t.getProduct()).stream()
                    .filter(m -> StockMovement.DISPENSE.equals(m.getKind()) && m.getAt().isAfter(since))
                    .map(m -> m.getLitres().abs()).reduce(BigDecimal.ZERO, BigDecimal::add);
            BigDecimal perDay = sold.divide(BigDecimal.valueOf(14), 2, RoundingMode.HALF_UP);
            BigDecimal book = stock.bookLitres(t);
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("siteCode", t.getSiteCode());
            m.put("product", t.getProduct());
            m.put("bookLitres", book);
            m.put("averageDailyLitres", perDay);
            if (perDay.signum() > 0) {
                BigDecimal days = book.divide(perDay, 1, RoundingMode.HALF_UP);
                m.put("daysOfCover", days);
                m.put("predictedStockout", days.compareTo(BigDecimal.valueOf(365)) > 0 ? null : LocalDate.now().plusDays(days.longValue()));
            } else {
                m.put("daysOfCover", null);
                m.put("predictedStockout", null);
            }
            boolean low = book.compareTo(t.getReorderLitres()) < 0;
            m.put("reorderNow", low);
            m.put("suggestedOrderLitres", low ? t.getCapacityLitres().multiply(new BigDecimal("0.9")).subtract(book).setScale(0, RoundingMode.DOWN) : BigDecimal.ZERO);
            out.add(m);
        }
        return out;
    }

    /** Management dashboard numbers for staff. */
    @GetMapping("/dashboard")
    public Map<String, Object> dashboard(HttpServletRequest request) {
        Access.requireStaff(Access.session(request));
        Instant startOfToday = LocalDate.now().atStartOfDay(ZoneId.systemDefault()).toInstant();
        List<FuelTransaction> todayTx = transactions.findByDispensedAtGreaterThanEqual(startOfToday);
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("litresToday", sum(todayTx.stream().map(FuelTransaction::getVolumeLitres).toList()));
        m.put("salesToday", sum(todayTx.stream().map(FuelTransaction::getAmount).toList()));
        m.put("dispensesToday", todayTx.size());
        m.put("ordersPending", orders.countByStatus(FuelOrder.Status.PENDING_APPROVAL));
        m.put("openRiskEvents", risks.countByStatus("OPEN"));
        m.put("criticalRiskEvents", risks.countBySeverityAndStatus(RiskEvent.CRITICAL, "OPEN"));
        m.put("openVarianceExceptions", exceptions.countByStatus("OPEN"));
        m.put("tanksBelowReorder", stock.levels().stream().filter(StockService.Level::belowReorder).count());
        List<Invoice> allInvoices = invoices.findAll();
        m.put("overdueInvoices", allInvoices.stream().filter(i -> "OVERDUE".equals(i.getStatus())).count());
        m.put("outstandingReceivables", sum(allInvoices.stream().map(Invoice::getBalance).toList()));
        return m;
    }

    /** Analytics look at the last 90 days, so the cost of a request does not grow with the age of the system. */
    private List<FuelTransaction> visible(AuthService.Session s) {
        Instant since = Instant.now().minus(Duration.ofDays(90));
        return Access.isCustomer(s) ? transactions.forCustomerSince(s.organization(), since)
                : transactions.findByDispensedAtGreaterThanEqual(since);
    }

    private static BigDecimal sum(List<BigDecimal> xs) {
        return xs.stream().reduce(BigDecimal.ZERO, BigDecimal::add);
    }
}
