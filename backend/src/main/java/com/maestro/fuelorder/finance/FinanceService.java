package com.maestro.fuelorder.finance;

import com.maestro.fuelorder.dispense.FuelTransaction;
import com.maestro.fuelorder.dispense.FuelTransactionRepository;
import com.maestro.fuelorder.notify.NotificationService;
import com.maestro.fuelorder.order.FuelOrder;
import com.maestro.fuelorder.order.FuelOrderRepository;
import com.maestro.fuelorder.order.OrderService;
import com.maestro.fuelorder.org.CreditAccountRepository;
import com.maestro.fuelorder.org.Organization;
import com.maestro.fuelorder.org.OrganizationRepository;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.server.ResponseStatusException;

import java.math.BigDecimal;
import java.math.RoundingMode;
import java.time.LocalDate;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.function.Function;
import java.util.stream.Collectors;

@Service
public class FinanceService {

    /** Seam for a real card gateway (Stripe, Peach, PayFast...). */
    public interface PaymentGateway {
        /** @return a gateway reference when the charge succeeds. */
        String charge(String organization, BigDecimal amount, String currency);
    }

    public record StatementLine(java.time.Instant at, String kind, String reference, BigDecimal debit,
                                BigDecimal credit, BigDecimal balance) {}

    public record BillingResult(int invoices, BigDecimal billed, List<String> numbers) {}

    private final LedgerEntryRepository ledger;
    private final TaxRateRepository taxRates;
    private final InvoiceRepository invoices;
    private final InvoiceLineRepository lines;
    private final PaymentRepository payments;
    private final FuelTransactionRepository transactions;
    private final FuelOrderRepository orders;
    private final OrganizationRepository orgs;
    private final CreditAccountRepository credit;
    private final NotificationService notifications;

    private final PaymentGateway gateway = (org, amount, currency) -> "SIMGW-" + UUID.randomUUID().toString().substring(0, 8).toUpperCase();

    public FinanceService(LedgerEntryRepository ledger, TaxRateRepository taxRates, InvoiceRepository invoices,
                          InvoiceLineRepository lines, PaymentRepository payments,
                          FuelTransactionRepository transactions, FuelOrderRepository orders,
                          OrganizationRepository orgs, CreditAccountRepository credit,
                          NotificationService notifications) {
        this.ledger = ledger;
        this.taxRates = taxRates;
        this.invoices = invoices;
        this.lines = lines;
        this.payments = payments;
        this.transactions = transactions;
        this.orders = orders;
        this.orgs = orgs;
        this.credit = credit;
        this.notifications = notifications;
    }

    /** A completed dispense is revenue: debit what the customer owes, credit fuel sales. */
    @Transactional
    public void postDispense(FuelTransaction tx, String customer) {
        post(customer, LedgerEntry.AR, tx.getAmount(), BigDecimal.ZERO, "TRANSACTION", tx.getId(),
                "Fuel dispensed " + tx.getVolumeLitres() + " L to " + tx.getVehicleReg());
        post(OrderService.SUPPLIER_ORG, LedgerEntry.SALES, BigDecimal.ZERO, tx.getAmount(), "TRANSACTION", tx.getId(),
                "Fuel sale to " + customer);
    }

    private void post(String org, String account, BigDecimal debit, BigDecimal creditAmt, String refType,
                      UUID refId, String memo) {
        ledger.save(new LedgerEntry(org, account, debit, creditAmt, refType, refId, memo));
    }

    /** Dispenses not yet on any invoice, grouped by the customer who owes them. */
    public Map<String, List<FuelTransaction>> unbilledByCustomer() {
        Set<UUID> billed = lines.findAll().stream().map(InvoiceLine::getTransactionId).collect(Collectors.toSet());
        Map<UUID, FuelOrder> orderById = orders.findAll().stream().collect(Collectors.toMap(FuelOrder::getId, Function.identity()));
        return transactions.findAll().stream()
                .filter(t -> !billed.contains(t.getId()) && orderById.containsKey(t.getOrderId()))
                .collect(Collectors.groupingBy(t -> orderById.get(t.getOrderId()).getCustomerName()));
    }

    public BigDecimal unbilledAmount(String customer) {
        return transactions.unbilledAmount(customer);
    }

    public BigDecimal openInvoiceBalance(String customer) {
        return invoices.findByOrganization(customer).stream()
                .map(Invoice::getBalance).reduce(BigDecimal.ZERO, BigDecimal::add);
    }

    public BigDecimal taxRateFor(String country) {
        return taxRates.findByCountryOrderByValidFromDesc(country == null ? "ZA" : country).stream()
                .filter(r -> !r.getValidFrom().isAfter(LocalDate.now())).findFirst()
                .map(TaxRate::getRatePercent).orElse(BigDecimal.ZERO);
    }

    /** Invoices every customer's unbilled fuel. A dispense can only ever be invoiced once. */
    @Transactional
    public BillingResult runBilling() {
        List<String> numbers = new ArrayList<>();
        BigDecimal billed = BigDecimal.ZERO;
        for (Map.Entry<String, List<FuelTransaction>> e : unbilledByCustomer().entrySet()) {
            Invoice inv = invoice(e.getKey(), e.getValue());
            numbers.add(inv.getNumber());
            billed = billed.add(inv.getTotal());
        }
        return new BillingResult(numbers.size(), billed, numbers);
    }

    private Invoice invoice(String customer, List<FuelTransaction> txs) {
        Organization org = orgs.findByNameIgnoreCase(customer)
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND, "Unknown customer " + customer));
        BigDecimal subtotal = txs.stream().map(FuelTransaction::getAmount).reduce(BigDecimal.ZERO, BigDecimal::add);
        BigDecimal rate = taxRateFor(org.getCountry());
        BigDecimal tax = subtotal.multiply(rate).divide(BigDecimal.valueOf(100), 2, RoundingMode.HALF_UP);
        int days = credit.findByOrganization(customer).map(c -> c.termsDays()).orElse(0);
        LocalDate today = LocalDate.now();
        String number = "INV-%d-%04d".formatted(today.getYear(), invoices.count() + 1);
        Invoice inv = invoices.save(new Invoice(number, customer, org.getCurrency() == null ? "ZAR" : org.getCurrency(),
                today, today.plusDays(days), subtotal.setScale(2, RoundingMode.HALF_UP),
                "VAT", rate, tax, subtotal.add(tax).setScale(2, RoundingMode.HALF_UP),
                "FISCAL-SIM-" + number));
        Map<UUID, FuelOrder> orderById = orders.findAll().stream().collect(Collectors.toMap(FuelOrder::getId, Function.identity()));
        for (FuelTransaction t : txs) {
            FuelOrder o = orderById.get(t.getOrderId());
            lines.save(new InvoiceLine(inv.getId(), t.getId(), o.getNumber(),
                    o.getFuelProduct() + " for " + t.getVehicleReg(), t.getVolumeLitres(), t.getUnitPrice(), t.getAmount()));
        }
        post(customer, LedgerEntry.AR, tax, BigDecimal.ZERO, "INVOICE", inv.getId(), "Tax on " + number);
        post(OrderService.SUPPLIER_ORG, LedgerEntry.TAX, BigDecimal.ZERO, tax, "INVOICE", inv.getId(), "Tax on " + number);
        notifications.inApp(customer, "INVOICE", "Invoice %s for %s %s is ready, due %s."
                .formatted(number, inv.getCurrency(), inv.getTotal(), inv.getDueDate()), number);
        return inv;
    }

    /** Records money received against an invoice; CARD payments go through the payment gateway. */
    @Transactional
    public Payment pay(UUID invoiceId, BigDecimal amount, String method, String reference) {
        Invoice inv = invoices.findById(invoiceId)
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND, "Invoice not found"));
        if (amount.signum() <= 0) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Amount must be positive");
        }
        if (amount.compareTo(inv.getBalance()) > 0) {
            throw new ResponseStatusException(HttpStatus.CONFLICT,
                    "That is more than the %s balance of %s".formatted(inv.getNumber(), inv.getBalance()));
        }
        String ref = "CARD".equals(method) ? gateway.charge(inv.getOrganization(), amount, inv.getCurrency()) : reference;
        inv.receive(amount);
        invoices.save(inv);
        Payment p = payments.save(new Payment(inv.getOrganization(), invoiceId, amount, method, ref));
        post(OrderService.SUPPLIER_ORG, LedgerEntry.CASH, amount, BigDecimal.ZERO, "PAYMENT", p.getId(), "Payment for " + inv.getNumber());
        post(inv.getOrganization(), LedgerEntry.AR, BigDecimal.ZERO, amount, "PAYMENT", p.getId(), "Payment for " + inv.getNumber());
        return p;
    }

    public List<StatementLine> statement(String customer) {
        record Raw(java.time.Instant at, String kind, String ref, BigDecimal debit, BigDecimal credit) {}
        List<Raw> raw = new ArrayList<>();
        invoices.findByOrganization(customer).forEach(i ->
                raw.add(new Raw(i.getCreatedAt(), "INVOICE", i.getNumber(), i.getTotal(), BigDecimal.ZERO)));
        payments.findByOrganization(customer).forEach(p ->
                raw.add(new Raw(p.getReceivedAt(), "PAYMENT", p.getMethod() + " " + p.getReference(), BigDecimal.ZERO, p.getAmount())));
        raw.sort(Comparator.comparing(Raw::at));
        BigDecimal bal = BigDecimal.ZERO;
        List<StatementLine> out = new ArrayList<>();
        for (Raw r : raw) {
            bal = bal.add(r.debit()).subtract(r.credit());
            out.add(new StatementLine(r.at(), r.kind(), r.ref(), r.debit(), r.credit(), bal));
        }
        return out;
    }

    /** Debits must equal credits across the whole ledger; anything else is a posting bug. */
    public Map<String, Object> trialBalance() {
        List<LedgerEntry> all = ledger.findAll();
        BigDecimal d = all.stream().map(LedgerEntry::getDebit).reduce(BigDecimal.ZERO, BigDecimal::add);
        BigDecimal c = all.stream().map(LedgerEntry::getCredit).reduce(BigDecimal.ZERO, BigDecimal::add);
        return Map.of("debits", d, "credits", c, "balanced", d.compareTo(c) == 0, "entries", all.size());
    }
}
