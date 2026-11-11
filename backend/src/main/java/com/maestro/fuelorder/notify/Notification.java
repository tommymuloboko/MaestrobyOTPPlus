package com.maestro.fuelorder.notify;

import jakarta.persistence.*;
import java.time.Instant;
import java.util.UUID;

@Entity
@Table(name = "notifications")
public class Notification {

    @Id
    private UUID id = UUID.randomUUID();

    /** Organization that may read this message. */
    @Column(nullable = false)
    private String organization;

    private String recipientName;
    private String phone;

    @Column(nullable = false)
    private String channel;

    /** OTP, DRIVER_PIN, ORDER_STATUS, ALERT, INVOICE. */
    @Column(nullable = false)
    private String kind;

    @Column(nullable = false, length = 600)
    private String message;

    /** SENT_SIMULATED while no real SMS provider is configured. */
    @Column(nullable = false)
    private String status;

    private String reference;

    @Column(nullable = false)
    private Instant createdAt = Instant.now();

    protected Notification() {}

    public Notification(String organization, String recipientName, String phone, String channel,
                        String kind, String message, String status, String reference) {
        this.organization = organization;
        this.recipientName = recipientName;
        this.phone = phone;
        this.channel = channel;
        this.kind = kind;
        this.message = message;
        this.status = status;
        this.reference = reference;
    }

    public UUID getId() { return id; }
    public String getOrganization() { return organization; }
    public String getRecipientName() { return recipientName; }
    public String getPhone() { return phone; }
    public String getChannel() { return channel; }
    public String getKind() { return kind; }
    public String getMessage() { return message; }
    public String getStatus() { return status; }
    public String getReference() { return reference; }
    public Instant getCreatedAt() { return createdAt; }
}
