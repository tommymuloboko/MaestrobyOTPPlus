package com.maestro.fuelorder.finance;

import jakarta.persistence.*;
import java.math.BigDecimal;
import java.time.Instant;
import java.util.UUID;

@Entity
@Table(name = "payments")
public class Payment {

    @Id
    private UUID id = UUID.randomUUID();

    @Column(nullable = false)
    private String organization;

    @Column(nullable = false)
    private UUID invoiceId;

    @Column(nullable = false)
    private BigDecimal amount;

    /** CARD (through the payment gateway), EFT or CASH. */
    @Column(nullable = false)
    private String method;

    private String reference;

    @Column(nullable = false)
    private Instant receivedAt = Instant.now();

    protected Payment() {}

    public Payment(String organization, UUID invoiceId, BigDecimal amount, String method, String reference) {
        this.organization = organization;
        this.invoiceId = invoiceId;
        this.amount = amount;
        this.method = method;
        this.reference = reference;
    }

    public UUID getId() { return id; }
    public String getOrganization() { return organization; }
    public UUID getInvoiceId() { return invoiceId; }
    public BigDecimal getAmount() { return amount; }
    public String getMethod() { return method; }
    public String getReference() { return reference; }
    public Instant getReceivedAt() { return receivedAt; }
}
