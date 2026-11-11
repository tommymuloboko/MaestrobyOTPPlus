package com.maestro.fuelorder.finance;

import jakarta.persistence.*;
import java.math.BigDecimal;
import java.util.UUID;

@Entity
@Table(name = "invoice_lines")
public class InvoiceLine {

    @Id
    private UUID id = UUID.randomUUID();

    @Column(nullable = false)
    private UUID invoiceId;

    /** A transaction can appear on exactly one invoice line, which is how double-billing is prevented. */
    @Column(nullable = false, unique = true)
    private UUID transactionId;

    private String orderNumber;
    private String description;

    @Column(nullable = false)
    private BigDecimal litres;

    @Column(nullable = false)
    private BigDecimal unitPrice;

    @Column(nullable = false)
    private BigDecimal amount;

    protected InvoiceLine() {}

    public InvoiceLine(UUID invoiceId, UUID transactionId, String orderNumber, String description,
                       BigDecimal litres, BigDecimal unitPrice, BigDecimal amount) {
        this.invoiceId = invoiceId;
        this.transactionId = transactionId;
        this.orderNumber = orderNumber;
        this.description = description;
        this.litres = litres;
        this.unitPrice = unitPrice;
        this.amount = amount;
    }

    public UUID getId() { return id; }
    public UUID getInvoiceId() { return invoiceId; }
    public UUID getTransactionId() { return transactionId; }
    public String getOrderNumber() { return orderNumber; }
    public String getDescription() { return description; }
    public BigDecimal getLitres() { return litres; }
    public BigDecimal getUnitPrice() { return unitPrice; }
    public BigDecimal getAmount() { return amount; }
}
