package com.maestro.fuelorder.erp;

import com.maestro.fuelorder.finance.Invoice;
import com.maestro.fuelorder.finance.InvoiceLine;
import com.maestro.fuelorder.finance.InvoiceLineRepository;
import com.maestro.fuelorder.finance.InvoiceRepository;
import com.maestro.fuelorder.finance.LedgerEntry;
import com.maestro.fuelorder.finance.LedgerEntryRepository;
import com.maestro.fuelorder.order.OrderService;
import jakarta.persistence.EntityManager;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.server.ResponseStatusException;

import java.math.BigDecimal;
import java.math.RoundingMode;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.Set;
import java.util.UUID;
import java.util.stream.Collectors;

/**
 * The Central adapter: moves finance data to the customer's ERP or accounting system, converts between
 * currencies and settles what the platform owes suppliers. Real ERP vendors and payout rails plug in
 * behind the webhook URL and the settlement status; none is connected in the skeleton.
 */
@Service
public class ErpService {

    private final InvoiceRepository invoices;
    private final InvoiceLineRepository lines;
    private final LedgerEntryRepository ledger;
    private final OutboundEventRepository outbound;
    private final FxRateRepository fx;
    private final SettlementRunRepository settlementRuns;
    private final String webhookUrl;
    private final BigDecimal feePercent;
    private final HttpClient http = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(3)).build();

    public ErpService(InvoiceRepository invoices, InvoiceLineRepository lines, LedgerEntryRepository ledger,
                      OutboundEventRepository outbound, FxRateRepository fx, SettlementRunRepository settlementRuns,
                      @Value("${maestro.erp.webhook-url:}") String webhookUrl,
                      @Value("${maestro.settlement.fee-percent:1.5}") BigDecimal feePercent) {
        this.invoices = invoices;
        this.lines = lines;
        this.ledger = ledger;
        this.outbound = outbound;
        this.fx = fx;
        this.settlementRuns = settlementRuns;
        this.webhookUrl = webhookUrl;
        this.feePercent = feePercent;
    }

    public String invoicesCsv() {
        StringBuilder sb = new StringBuilder("invoice,customer,issue_date,due_date,currency,subtotal,tax,total,paid,status,fiscal_ref\r\n");
        for (Invoice i : invoices.findAll()) {
            sb.append(String.join(",", i.getNumber(), q(i.getOrganization()), i.getIssueDate().toString(),
                    i.getDueDate().toString(), i.getCurrency(), i.getSubtotal().toPlainString(), i.getTax().toPlainString(),
                    i.getTotal().toPlainString(), i.getPaid().toPlainString(), i.getStatus(), String.valueOf(i.getFiscalRef())))
                    .append("\r\n");
        }
        return sb.toString();
    }

    private static String q(String s) {
        return "\"" + s.replace("\"", "\"\"") + "\"";
    }

    /** Pushes every invoice not yet delivered to the configured webhook, logging each outcome. */
    @Transactional
    public List<OutboundEvent> pushInvoices() {
        Set<String> sent = outbound.findByKindAndStatus("invoice.issued", "SENT").stream()
                .map(e -> e.reference).collect(Collectors.toSet());
        List<OutboundEvent> out = new java.util.ArrayList<>();
        for (Invoice i : invoices.findAll()) {
            if (sent.contains(i.getNumber())) {
                continue;
            }
            OutboundEvent ev;
            if (webhookUrl.isBlank()) {
                ev = new OutboundEvent("erp-webhook", "invoice.issued", i.getNumber(), "SKIPPED", "No maestro.erp.webhook-url configured");
            } else {
                ev = deliver(i);
            }
            outbound.save(ev);
            out.add(ev);
        }
        return out;
    }

    private OutboundEvent deliver(Invoice i) {
        try {
            List<InvoiceLine> ls = lines.findByInvoiceId(i.getId());
            String body = "{\"event\":\"invoice.issued\",\"number\":\"%s\",\"customer\":\"%s\",\"currency\":\"%s\",\"subtotal\":%s,\"tax\":%s,\"total\":%s,\"lines\":%d}"
                    .formatted(i.getNumber(), i.getOrganization().replace("\"", "'"), i.getCurrency(),
                            i.getSubtotal(), i.getTax(), i.getTotal(), ls.size());
            HttpResponse<String> r = http.send(HttpRequest.newBuilder(URI.create(webhookUrl)).timeout(Duration.ofSeconds(5))
                    .header("Content-Type", "application/json").POST(HttpRequest.BodyPublishers.ofString(body)).build(),
                    HttpResponse.BodyHandlers.ofString());
            boolean ok = r.statusCode() / 100 == 2;
            return new OutboundEvent("erp-webhook", "invoice.issued", i.getNumber(), ok ? "SENT" : "FAILED", "HTTP " + r.statusCode());
        } catch (Exception e) {
            return new OutboundEvent("erp-webhook", "invoice.issued", i.getNumber(), "FAILED", String.valueOf(e.getMessage()));
        }
    }

    public List<OutboundEvent> events() {
        return outbound.findTop200ByOrderByAtDesc();
    }

    @Transactional
    public FxRate setRate(String from, String to, BigDecimal rate) {
        FxRate r = fx.findByFromCurrencyAndToCurrency(from, to).orElseGet(() -> new FxRate(from, to, rate));
        r.rate = rate;
        r.at = Instant.now();
        return fx.save(r);
    }

    public List<FxRate> rates() {
        return fx.findAllByOrderByFromCurrencyAscToCurrencyAsc();
    }

    /** Converts directly, via the inverse rate, or returns the amount unchanged for the same currency. */
    public BigDecimal convert(BigDecimal amount, String from, String to) {
        if (from.equalsIgnoreCase(to)) {
            return amount;
        }
        for (FxRate r : rates()) {
            if (r.fromCurrency.equalsIgnoreCase(from) && r.toCurrency.equalsIgnoreCase(to)) {
                return amount.multiply(r.rate).setScale(2, RoundingMode.HALF_UP);
            }
            if (r.fromCurrency.equalsIgnoreCase(to) && r.toCurrency.equalsIgnoreCase(from)) {
                return amount.divide(r.rate, 2, RoundingMode.HALF_UP);
            }
        }
        throw new ResponseStatusException(HttpStatus.NOT_FOUND, "No exchange rate between " + from + " and " + to);
    }

    /** Settles all supplier sales since the last settlement, so no sale is ever paid out twice. */
    @Transactional
    public SettlementRun settle() {
        Instant from = settlementRuns.findFirstByOrderByPeriodToDesc().map(s -> s.periodTo).orElse(Instant.EPOCH);
        Instant to = Instant.now();
        BigDecimal gross = ledger.findByOrganization(OrderService.SUPPLIER_ORG).stream()
                .filter(e -> LedgerEntry.SALES.equals(e.getAccount()) && e.getAt().isAfter(from) && !e.getAt().isAfter(to))
                .map(LedgerEntry::getCredit).reduce(BigDecimal.ZERO, BigDecimal::add);
        if (gross.signum() == 0) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, "Nothing new to settle");
        }
        BigDecimal fee = gross.multiply(feePercent).divide(BigDecimal.valueOf(100), 2, RoundingMode.HALF_UP);
        SettlementRun run = new SettlementRun(OrderService.SUPPLIER_ORG, gross, feePercent, fee, gross.subtract(fee), from, to);
        return settlementRuns.save(run);
    }

    @Transactional
    public SettlementRun markPaid(UUID id) {
        SettlementRun s = settlementRuns.findById(id)
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND, "Settlement not found"));
        s.status = "PAID";
        return settlementRuns.save(s);
    }

    public List<SettlementRun> settlements() {
        return settlementRuns.findAllByOrderByAtDesc();
    }
}
