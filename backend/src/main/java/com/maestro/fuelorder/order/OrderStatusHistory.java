package com.maestro.fuelorder.order;

import jakarta.persistence.*;
import java.time.Instant;
import java.util.UUID;

/** Append-only timeline of every status an order has been through, with who moved it and why. */
@Entity
@Table(name = "order_status_history")
public class OrderStatusHistory {

    @Id
    private UUID id = UUID.randomUUID();

    @Column(nullable = false)
    private UUID orderId;

    private String fromStatus;

    @Column(nullable = false)
    private String toStatus;

    @Column(nullable = false)
    private String actor;

    @Column(length = 500)
    private String reason;

    @Column(nullable = false)
    private Instant at = Instant.now();

    protected OrderStatusHistory() {}

    public OrderStatusHistory(UUID orderId, String fromStatus, String toStatus, String actor, String reason) {
        this.orderId = orderId;
        this.fromStatus = fromStatus;
        this.toStatus = toStatus;
        this.actor = actor;
        this.reason = reason;
    }

    public UUID getId() { return id; }
    public UUID getOrderId() { return orderId; }
    public String getFromStatus() { return fromStatus; }
    public String getToStatus() { return toStatus; }
    public String getActor() { return actor; }
    public String getReason() { return reason; }
    public Instant getAt() { return at; }
}
