package com.maestro.fuelorder.integration;

import jakarta.persistence.*;
import java.math.BigDecimal;
import java.time.Instant;
import java.util.UUID;

/** Pump or flow-meter event: totalizer readings, nozzle up/down, flow, errors. */
@Entity
@Table(name = "pump_events", indexes = @Index(columnList = "siteCode, pumpId, at"))
public class PumpEvent {
    @Id public UUID id = UUID.randomUUID();
    @Column(nullable = false) public String siteCode;
    @Column(nullable = false) public String pumpId;
    /** TOTALIZER, NOZZLE_UP, NOZZLE_DOWN, FLOW, ERROR. */
    @Column(nullable = false) public String kind;
    @Column(name = "reading_value") public BigDecimal value;
    @Column(nullable = false) public Instant at;

    protected PumpEvent() {}

    public PumpEvent(String siteCode, String pumpId, String kind, BigDecimal value, Instant at) {
        this.siteCode = siteCode;
        this.pumpId = pumpId;
        this.kind = kind;
        this.value = value;
        this.at = at;
    }
}
