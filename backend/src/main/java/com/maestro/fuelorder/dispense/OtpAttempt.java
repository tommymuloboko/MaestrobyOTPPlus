package com.maestro.fuelorder.dispense;

import jakarta.persistence.*;
import java.time.Instant;
import java.util.UUID;

/** Every OTP validation attempt, successful or not. Feeds brute-force, reuse and PIN-guessing detection. */
@Entity
@Table(name = "otp_attempts")
public class OtpAttempt {

    public static final String VALIDATED = "VALIDATED";
    public static final String INVALID = "INVALID";
    public static final String REUSED = "REUSED";
    public static final String EXPIRED = "EXPIRED";
    public static final String BAD_PIN = "BAD_PIN";
    public static final String OVER_LIMIT = "OVER_LIMIT";
    public static final String COMPLETED = "COMPLETED";

    @Id
    private UUID id = UUID.randomUUID();

    @Column(nullable = false)
    private String attendant;

    @Column(nullable = false)
    private String outcome;

    private UUID authorizationId;
    private UUID orderId;

    @Column(length = 400)
    private String detail;

    @Column(nullable = false)
    private Instant at = Instant.now();

    protected OtpAttempt() {}

    public OtpAttempt(String attendant, String outcome, UUID authorizationId, UUID orderId, String detail) {
        this.attendant = attendant;
        this.outcome = outcome;
        this.authorizationId = authorizationId;
        this.orderId = orderId;
        this.detail = detail;
    }

    public UUID getId() { return id; }
    public String getAttendant() { return attendant; }
    public String getOutcome() { return outcome; }
    public UUID getAuthorizationId() { return authorizationId; }
    public UUID getOrderId() { return orderId; }
    public String getDetail() { return detail; }
    public Instant getAt() { return at; }
}
