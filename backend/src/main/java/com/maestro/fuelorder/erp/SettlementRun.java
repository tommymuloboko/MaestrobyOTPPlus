package com.maestro.fuelorder.erp;

import jakarta.persistence.*;
import java.math.BigDecimal;
import java.time.Instant;
import java.util.UUID;

/** What the platform owes the supplier for a period: sales less the platform fee. */
@Entity
@Table(name = "settlement_runs")
public class SettlementRun {
    @Id public UUID id = UUID.randomUUID();
    @Column(nullable = false) public String supplier;
    @Column(nullable = false) public BigDecimal gross;
    @Column(nullable = false) public BigDecimal feePercent;
    @Column(nullable = false) public BigDecimal fee;
    @Column(nullable = false) public BigDecimal net;
    @Column(nullable = false) public Instant periodFrom;
    @Column(nullable = false) public Instant periodTo;
    /** DRAFT until Finance records the payout, then PAID. */
    @Column(nullable = false) public String status = "DRAFT";
    @Column(nullable = false) public Instant at = Instant.now();

    protected SettlementRun() {}

    public SettlementRun(String supplier, BigDecimal gross, BigDecimal feePercent, BigDecimal fee,
                         BigDecimal net, Instant from, Instant to) {
        this.supplier = supplier;
        this.gross = gross;
        this.feePercent = feePercent;
        this.fee = fee;
        this.net = net;
        this.periodFrom = from;
        this.periodTo = to;
    }
}
