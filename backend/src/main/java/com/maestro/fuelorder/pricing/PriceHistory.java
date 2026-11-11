package com.maestro.fuelorder.pricing;

import jakarta.persistence.*;
import java.math.BigDecimal;
import java.time.Instant;
import java.time.LocalDate;
import java.util.UUID;

/** Append-only record of every approved price change: previous price, new price, who and when. */
@Entity
@Table(name = "price_history")
public class PriceHistory {

    @Id
    private UUID id = UUID.randomUUID();

    @Column(nullable = false)
    private UUID ruleId;

    @Column(nullable = false)
    private String organization;

    @Column(nullable = false)
    private String product;

    private String siteCode;

    private BigDecimal previousPrice;

    @Column(nullable = false)
    private BigDecimal newPrice;

    @Column(nullable = false)
    private String proposedBy;

    @Column(nullable = false)
    private String approvedBy;

    @Column(nullable = false)
    private LocalDate effectiveDate;

    @Column(nullable = false)
    private Instant at = Instant.now();

    protected PriceHistory() {}

    public PriceHistory(UUID ruleId, String organization, String product, String siteCode,
                        BigDecimal previousPrice, BigDecimal newPrice, String proposedBy,
                        String approvedBy, LocalDate effectiveDate) {
        this.ruleId = ruleId;
        this.organization = organization;
        this.product = product;
        this.siteCode = siteCode;
        this.previousPrice = previousPrice;
        this.newPrice = newPrice;
        this.proposedBy = proposedBy;
        this.approvedBy = approvedBy;
        this.effectiveDate = effectiveDate;
    }

    public UUID getId() { return id; }
    public UUID getRuleId() { return ruleId; }
    public String getOrganization() { return organization; }
    public String getProduct() { return product; }
    public String getSiteCode() { return siteCode; }
    public BigDecimal getPreviousPrice() { return previousPrice; }
    public BigDecimal getNewPrice() { return newPrice; }
    public String getProposedBy() { return proposedBy; }
    public String getApprovedBy() { return approvedBy; }
    public LocalDate getEffectiveDate() { return effectiveDate; }
    public Instant getAt() { return at; }
}
