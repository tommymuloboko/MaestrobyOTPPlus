package com.maestro.fuelorder.org;

import com.maestro.fuelorder.dispense.FuelTransactionRepository;
import com.maestro.fuelorder.finance.FinanceService;
import com.maestro.fuelorder.order.FuelOrder;
import com.maestro.fuelorder.order.FuelOrderRepository;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.web.server.ResponseStatusException;

import java.math.BigDecimal;
import java.time.Instant;
import java.time.LocalDate;
import java.time.ZoneId;

/** A customer's credit position: what they owe plus what they have already committed to buy. */
@Service
public class CreditService {

    public record Standing(String organization, BigDecimal creditLimit, String terms, BigDecimal monthlyBudget,
                           BigDecimal used, BigDecimal committed, BigDecimal available, BigDecimal monthSpend) {}

    private final CreditAccountRepository accounts;
    private final FuelOrderRepository orders;
    private final FuelTransactionRepository transactions;
    private final FinanceService finance;

    public CreditService(CreditAccountRepository accounts, FuelOrderRepository orders,
                         FuelTransactionRepository transactions, FinanceService finance) {
        this.accounts = accounts;
        this.orders = orders;
        this.transactions = transactions;
        this.finance = finance;
    }

    public Standing standing(String organization) {
        CreditAccount acct = accounts.findByOrganization(organization).orElse(null);
        // owed = fuel not yet invoiced + the unpaid part of invoices already issued
        BigDecimal used = finance.unbilledAmount(organization).add(finance.openInvoiceBalance(organization));
        BigDecimal committed = orders.findByCustomerNameAndStatus(organization, FuelOrder.Status.AUTHORIZED).stream()
                .map(o -> o.getQuantityLitres().multiply(o.getUnitPriceSnapshot()))
                .reduce(BigDecimal.ZERO, BigDecimal::add);
        Instant monthStart = LocalDate.now().withDayOfMonth(1).atStartOfDay(ZoneId.systemDefault()).toInstant();
        BigDecimal month = transactions.spendSince(organization, monthStart);
        BigDecimal limit = acct == null ? BigDecimal.ZERO : acct.getCreditLimit();
        return new Standing(organization, limit, acct == null ? "PREPAID" : acct.getTerms(),
                acct == null ? BigDecimal.ZERO : acct.getMonthlyBudget(), used, committed,
                limit.subtract(used).subtract(committed).max(BigDecimal.ZERO), month);
    }

    /** Throws 409 when taking on {@code orderValue} would push the customer past their credit limit. */
    public void assertWithinLimit(String organization, BigDecimal orderValue) {
        CreditAccount acct = accounts.findByOrganization(organization).orElse(null);
        if (acct == null || "PREPAID".equals(acct.getTerms())) {
            return;
        }
        Standing s = standing(organization);
        if (orderValue.compareTo(s.available()) > 0) {
            throw new ResponseStatusException(HttpStatus.CONFLICT,
                    "Credit limit exceeded: this order is R %s but %s only has R %s available of R %s"
                            .formatted(orderValue.setScale(2, java.math.RoundingMode.HALF_UP),
                                    organization, s.available().setScale(2, java.math.RoundingMode.HALF_UP),
                                    s.creditLimit().setScale(2, java.math.RoundingMode.HALF_UP)));
        }
    }
}
