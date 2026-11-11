package com.maestro.fuelorder.recon;

import jakarta.persistence.*;
import java.math.BigDecimal;
import java.time.Instant;
import java.time.LocalDate;
import java.util.UUID;

@Entity
@Table(name = "reconciliation_runs")
public class ReconciliationRun {
    @Id public UUID id = UUID.randomUUID();
    @Column(nullable = false) public String siteCode;
    @Column(nullable = false) public LocalDate businessDate;
    /** OK or EXCEPTIONS. */
    @Column(nullable = false) public String status;
    public BigDecimal dispensedLitres;
    public BigDecimal totalizerLitres;
    public int exceptions;
    @Column(length = 600) public String summary;
    @Column(nullable = false) public Instant at = Instant.now();

    protected ReconciliationRun() {}

    public ReconciliationRun(String siteCode, LocalDate businessDate) {
        this.siteCode = siteCode;
        this.businessDate = businessDate;
        this.status = "OK";
    }
}
