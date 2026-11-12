package com.maestro.fuelorder.pts2;

import jakarta.persistence.*;
import java.math.BigDecimal;
import java.time.Instant;
import java.time.LocalDateTime;
import java.util.UUID;

/**
 * Append-only record of a pump price sent to a site's PTS-2: applied immediately, scheduled on the controller's
 * prices scheduler, or a scheduled change that was cancelled. Times on the controller are its local time.
 */
@Entity
@Table(name = "pts2_price_changes")
public class Pts2PriceChange {

    public static final String IMMEDIATE = "IMMEDIATE";
    public static final String SCHEDULED = "SCHEDULED";
    public static final String CANCELLED = "CANCELLED";

    @Id
    private UUID id = UUID.randomUUID();

    @Column(nullable = false)
    private String siteCode;

    @Column(nullable = false)
    private int fuelGradeId;

    private String fuelGradeName;

    /** The grade's price on the controller when the change was made. */
    @Column(precision = 38, scale = 3)
    private BigDecimal previousPrice;

    @Column(nullable = false, precision = 38, scale = 3)
    private BigDecimal newPrice;

    @Column(nullable = false)
    private String mode;

    /** Controller local time the price takes effect; for an immediate change, when it was sent. */
    @Column(nullable = false)
    private LocalDateTime effectiveAt;

    /** Slot on the controller's prices scheduler, for scheduled and cancelled changes. */
    private Integer scheduleId;

    @Column(nullable = false)
    private String changedBy;

    @Column(nullable = false)
    private Instant at = Instant.now();

    protected Pts2PriceChange() {}

    public Pts2PriceChange(String siteCode, int fuelGradeId, String fuelGradeName, BigDecimal previousPrice,
                           BigDecimal newPrice, String mode, LocalDateTime effectiveAt, Integer scheduleId,
                           String changedBy) {
        this.siteCode = siteCode;
        this.fuelGradeId = fuelGradeId;
        this.fuelGradeName = fuelGradeName;
        this.previousPrice = previousPrice;
        this.newPrice = newPrice;
        this.mode = mode;
        this.effectiveAt = effectiveAt;
        this.scheduleId = scheduleId;
        this.changedBy = changedBy;
    }

    public UUID getId() { return id; }
    public String getSiteCode() { return siteCode; }
    public int getFuelGradeId() { return fuelGradeId; }
    public String getFuelGradeName() { return fuelGradeName; }
    public BigDecimal getPreviousPrice() { return previousPrice; }
    public BigDecimal getNewPrice() { return newPrice; }
    public String getMode() { return mode; }
    public LocalDateTime getEffectiveAt() { return effectiveAt; }
    public Integer getScheduleId() { return scheduleId; }
    public String getChangedBy() { return changedBy; }
    public Instant getAt() { return at; }
}
