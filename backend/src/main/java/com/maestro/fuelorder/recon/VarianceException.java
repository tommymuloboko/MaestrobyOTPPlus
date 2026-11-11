package com.maestro.fuelorder.recon;

import jakarta.persistence.*;
import java.math.BigDecimal;
import java.time.Instant;
import java.util.UUID;

/** Something the daily close could not explain; it stays OPEN until a person resolves it with a note. */
@Entity
@Table(name = "variance_exceptions")
public class VarianceException {
    @Id public UUID id = UUID.randomUUID();
    @Column(nullable = false) public UUID runId;
    @Column(nullable = false) public String siteCode;
    public String product;
    /** TANK_VARIANCE or TOTALIZER_MISMATCH. */
    @Column(nullable = false) public String kind;
    public BigDecimal expectedLitres;
    public BigDecimal actualLitres;
    public BigDecimal varianceLitres;
    @Column(nullable = false) public String status = "OPEN";
    @Column(length = 500) public String note;
    public String resolvedBy;
    @Column(nullable = false) public Instant createdAt = Instant.now();

    protected VarianceException() {}

    public VarianceException(UUID runId, String siteCode, String product, String kind,
                             BigDecimal expected, BigDecimal actual, BigDecimal variance) {
        this.runId = runId;
        this.siteCode = siteCode;
        this.product = product;
        this.kind = kind;
        this.expectedLitres = expected;
        this.actualLitres = actual;
        this.varianceLitres = variance;
    }
}
