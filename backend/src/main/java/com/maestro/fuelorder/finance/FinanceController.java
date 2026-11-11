package com.maestro.fuelorder.finance;

import com.maestro.fuelorder.auth.Access;
import com.maestro.fuelorder.auth.AuthService;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.validation.Valid;
import jakarta.validation.constraints.DecimalMin;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Pattern;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.server.ResponseStatusException;

import java.math.BigDecimal;
import java.util.List;
import java.util.Map;
import java.util.UUID;

@RestController
@RequestMapping("/api/v1/finance")
public class FinanceController {

    public record PayRequest(@NotNull @DecimalMin("0.01") BigDecimal amount,
                             @NotBlank @Pattern(regexp = "CARD|EFT|CASH") String method,
                             String reference) {}

    public record InvoiceView(Invoice invoice, String status, BigDecimal balance, List<InvoiceLine> lines) {}

    private final FinanceService finance;
    private final InvoiceRepository invoices;
    private final InvoiceLineRepository lines;
    private final PaymentRepository payments;
    private final LedgerEntryRepository ledger;

    public FinanceController(FinanceService finance, InvoiceRepository invoices, InvoiceLineRepository lines,
                             PaymentRepository payments, LedgerEntryRepository ledger) {
        this.finance = finance;
        this.invoices = invoices;
        this.lines = lines;
        this.payments = payments;
        this.ledger = ledger;
    }

    @GetMapping("/invoices")
    public List<InvoiceView> invoices(HttpServletRequest request) {
        AuthService.Session s = Access.session(request);
        List<Invoice> all = Access.isCustomer(s) ? invoices.findByOrganization(s.organization()) : invoices.findAll();
        return all.stream().sorted((a, b) -> b.getCreatedAt().compareTo(a.getCreatedAt()))
                .map(i -> new InvoiceView(i, i.getStatus(), i.getBalance(), lines.findByInvoiceId(i.getId()))).toList();
    }

    @PostMapping("/billing-run")
    public FinanceService.BillingResult billingRun(HttpServletRequest request) {
        Access.requireFinance(Access.session(request));
        return finance.runBilling();
    }

    @GetMapping("/unbilled")
    public Map<String, BigDecimal> unbilled(HttpServletRequest request) {
        Access.requireFinance(Access.session(request));
        Map<String, BigDecimal> out = new java.util.TreeMap<>();
        finance.unbilledByCustomer().forEach((org, txs) -> out.put(org,
                txs.stream().map(t -> t.getAmount()).reduce(BigDecimal.ZERO, BigDecimal::add)));
        return out;
    }

    /** Customers pay their own invoices by card; Finance records EFT and cash for anyone. */
    @PostMapping("/invoices/{id}/pay")
    public Payment pay(@PathVariable UUID id, @RequestBody @Valid PayRequest req, HttpServletRequest request) {
        AuthService.Session s = Access.session(request);
        Invoice inv = invoices.findById(id)
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND, "Invoice not found"));
        if (Access.isCustomer(s)) {
            if (!inv.getOrganization().equals(s.organization())) {
                throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Invoice not found");
            }
            if (!"CARD".equals(req.method())) {
                throw new ResponseStatusException(HttpStatus.FORBIDDEN, "Customers pay by card; EFT is recorded by Finance");
            }
        } else {
            Access.requireFinance(s);
        }
        return finance.pay(id, req.amount(), req.method(), req.reference());
    }

    @GetMapping("/payments")
    public List<Payment> payments(HttpServletRequest request) {
        AuthService.Session s = Access.session(request);
        return (Access.isCustomer(s) ? payments.findByOrganization(s.organization()) : payments.findAll()).stream()
                .sorted((a, b) -> b.getReceivedAt().compareTo(a.getReceivedAt())).toList();
    }

    @GetMapping("/statement")
    public List<FinanceService.StatementLine> statement(@RequestParam(required = false) String customer,
                                                        HttpServletRequest request) {
        AuthService.Session s = Access.session(request);
        if (Access.isCustomer(s)) {
            return finance.statement(s.organization());
        }
        Access.requireFinance(s);
        if (customer == null) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "customer is required");
        }
        return finance.statement(customer);
    }

    @GetMapping("/ledger")
    public List<LedgerEntry> ledger(HttpServletRequest request) {
        Access.requireFinance(Access.session(request));
        return ledger.findTop300ByOrderByAtDesc();
    }

    @GetMapping("/trial-balance")
    public Map<String, Object> trialBalance(HttpServletRequest request) {
        Access.requireFinance(Access.session(request));
        return finance.trialBalance();
    }
}
