package com.maestro.fuelorder.sentinel;

import jakarta.persistence.*;
import java.time.Instant;
import java.util.UUID;

@Entity
@Table(name = "fraud_cases")
public class FraudCase {

    @Id
    private UUID id = UUID.randomUUID();

    @Column(nullable = false, unique = true)
    private UUID riskEventId;

    /** OPEN, INVESTIGATING, CLOSED. */
    @Column(nullable = false)
    private String status = "OPEN";

    private String assignedTo;

    /** CONFIRMED_FRAUD, FALSE_POSITIVE, NO_ACTION once closed. */
    private String outcome;

    @Column(length = 2000)
    private String notes = "";

    @Column(nullable = false)
    private Instant openedAt = Instant.now();

    private Instant closedAt;

    protected FraudCase() {}

    public FraudCase(UUID riskEventId) {
        this.riskEventId = riskEventId;
    }

    public UUID getId() { return id; }
    public UUID getRiskEventId() { return riskEventId; }
    public String getStatus() { return status; }
    public String getAssignedTo() { return assignedTo; }
    public String getOutcome() { return outcome; }
    public String getNotes() { return notes; }
    public Instant getOpenedAt() { return openedAt; }
    public Instant getClosedAt() { return closedAt; }

    public void assign(String user) {
        this.assignedTo = user;
        if ("OPEN".equals(status)) {
            this.status = "INVESTIGATING";
        }
    }

    public void note(String author, String text) {
        this.notes = notes + (notes.isEmpty() ? "" : "\n") + Instant.now() + " " + author + ": " + text;
    }

    public void close(String outcome) {
        this.status = "CLOSED";
        this.outcome = outcome;
        this.closedAt = Instant.now();
    }
}
