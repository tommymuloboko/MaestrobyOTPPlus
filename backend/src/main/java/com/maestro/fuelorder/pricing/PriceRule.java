package com.maestro.fuelorder.pricing;

import jakarta.persistence.*;
import java.math.BigDecimal;
import java.time.Instant;
import java.time.LocalDate;
import java.util.UUID;

/** A negotiated price for one customer. Rules only take effect once a second person approves them. */
@Entity
@Table(name = "price_rules")
public class PriceRule {

    public static final String FIXED = "FIXED";
    public static final String DISCOUNT_PCT = "DISCOUNT_PCT";
    public static final String DISCOUNT_ABS = "DISCOUNT_ABS";

    public static final String PENDING = "PENDING_APPROVAL";
    public static final String ACTIVE = "ACTIVE";
    public static final String SUPERSEDED = "SUPERSEDED";
    public static final String REJECTED = "REJECTED";

    @Id
    private UUID id = UUID.randomUUID();

    @Column(nullable = false)
    private String organization;

    @Column(nullable = false)
    private String product;

    /** Limits the rule to one station; null means every station. */
    private String siteCode;

    @Column(nullable = false)
    private String mode;

    @Column(name = "rule_value", nullable = false)
    private BigDecimal value;

    /** Volume tier: the rule applies from this many litres per order. */
    @Column(nullable = false)
    private BigDecimal minLitres = BigDecimal.ZERO;

    @Column(nullable = false)
    private LocalDate validFrom;

    private LocalDate validTo;

    @Column(nullable = false)
    private String status = PENDING;

    @Column(nullable = false)
    private String proposedBy;

    private String decidedBy;

    @Column(nullable = false)
    private Instant proposedAt = Instant.now();

    protected PriceRule() {}

    public PriceRule(String organization, String product, String siteCode, String mode, BigDecimal value,
                     BigDecimal minLitres, LocalDate validFrom, LocalDate validTo, String proposedBy) {
        this.organization = organization;
        this.product = product;
        this.siteCode = siteCode == null || siteCode.isBlank() ? null : siteCode;
        this.mode = mode;
        this.value = value;
        this.minLitres = minLitres == null ? BigDecimal.ZERO : minLitres;
        this.validFrom = validFrom;
        this.validTo = validTo;
        this.proposedBy = proposedBy;
    }

    public UUID getId() { return id; }
    public String getOrganization() { return organization; }
    public String getProduct() { return product; }
    public String getSiteCode() { return siteCode; }
    public String getMode() { return mode; }
    public BigDecimal getValue() { return value; }
    public BigDecimal getMinLitres() { return minLitres; }
    public LocalDate getValidFrom() { return validFrom; }
    public LocalDate getValidTo() { return validTo; }
    public String getStatus() { return status; }
    public String getProposedBy() { return proposedBy; }
    public String getDecidedBy() { return decidedBy; }
    public Instant getProposedAt() { return proposedAt; }

    public void decide(String status, String by) {
        this.status = status;
        this.decidedBy = by;
    }

    public void supersede() { this.status = SUPERSEDED; }

    public boolean appliesOn(LocalDate date) {
        return !date.isBefore(validFrom) && (validTo == null || !date.isAfter(validTo));
    }
}
