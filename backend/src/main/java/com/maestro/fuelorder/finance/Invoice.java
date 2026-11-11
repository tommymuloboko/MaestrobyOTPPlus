package com.maestro.fuelorder.finance;

import jakarta.persistence.*;
import java.math.BigDecimal;
import java.time.Instant;
import java.time.LocalDate;
import java.util.UUID;

@Entity
@Table(name = "invoices")
public class Invoice {

    @Id
    private UUID id = UUID.randomUUID();

    @Column(nullable = false, unique = true)
    private String number;

    @Column(nullable = false)
    private String organization;

    @Column(nullable = false)
    private String currency;

    @Column(nullable = false)
    private LocalDate issueDate;

    @Column(nullable = false)
    private LocalDate dueDate;

    @Column(nullable = false)
    private BigDecimal subtotal;

    @Column(nullable = false)
    private String taxName;

    @Column(nullable = false)
    private BigDecimal taxRatePercent;

    @Column(nullable = false)
    private BigDecimal tax;

    @Column(nullable = false)
    private BigDecimal total;

    @Column(nullable = false)
    private BigDecimal paid = BigDecimal.ZERO;

    /** Reference from the fiscal device; simulated until a real fiscal integration is connected. */
    private String fiscalRef;

    @Column(nullable = false)
    private Instant createdAt = Instant.now();

    protected Invoice() {}

    public Invoice(String number, String organization, String currency, LocalDate issueDate, LocalDate dueDate,
                   BigDecimal subtotal, String taxName, BigDecimal taxRatePercent, BigDecimal tax,
                   BigDecimal total, String fiscalRef) {
        this.number = number;
        this.organization = organization;
        this.currency = currency;
        this.issueDate = issueDate;
        this.dueDate = dueDate;
        this.subtotal = subtotal;
        this.taxName = taxName;
        this.taxRatePercent = taxRatePercent;
        this.tax = tax;
        this.total = total;
        this.fiscalRef = fiscalRef;
    }

    public UUID getId() { return id; }
    public String getNumber() { return number; }
    public String getOrganization() { return organization; }
    public String getCurrency() { return currency; }
    public LocalDate getIssueDate() { return issueDate; }
    public LocalDate getDueDate() { return dueDate; }
    public BigDecimal getSubtotal() { return subtotal; }
    public String getTaxName() { return taxName; }
    public BigDecimal getTaxRatePercent() { return taxRatePercent; }
    public BigDecimal getTax() { return tax; }
    public BigDecimal getTotal() { return total; }
    public BigDecimal getPaid() { return paid; }
    public String getFiscalRef() { return fiscalRef; }
    public Instant getCreatedAt() { return createdAt; }

    public BigDecimal getBalance() { return total.subtract(paid); }

    public String getStatus() {
        if (getBalance().signum() <= 0) return "PAID";
        if (LocalDate.now().isAfter(dueDate)) return "OVERDUE";
        return paid.signum() > 0 ? "PARTIALLY_PAID" : "ISSUED";
    }

    public void receive(BigDecimal amount) { this.paid = this.paid.add(amount); }
}
