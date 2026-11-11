package com.maestro.fuelorder.erp;

import jakarta.persistence.*;
import java.time.Instant;
import java.util.UUID;

/** Log of everything sent to an external system, so a failed push can be retried and audited. */
@Entity
@Table(name = "outbound_events")
public class OutboundEvent {
    @Id public UUID id = UUID.randomUUID();
    @Column(nullable = false) public String target;
    @Column(nullable = false) public String kind;
    @Column(nullable = false) public String reference;
    /** SENT, FAILED or SKIPPED (no endpoint configured). */
    @Column(nullable = false) public String status;
    @Column(length = 300) public String detail;
    @Column(nullable = false) public Instant at = Instant.now();

    protected OutboundEvent() {}

    public OutboundEvent(String target, String kind, String reference, String status, String detail) {
        this.target = target;
        this.kind = kind;
        this.reference = reference;
        this.status = status;
        this.detail = detail;
    }
}
