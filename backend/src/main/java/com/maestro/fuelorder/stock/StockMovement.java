package com.maestro.fuelorder.stock;

import jakarta.persistence.*;
import java.math.BigDecimal;
import java.time.Instant;
import java.util.UUID;

/** Append-only book-stock ledger: negative litres leave the tank, positive litres enter it. */
@Entity
@Table(name = "stock_movements")
public class StockMovement {

    public static final String DISPENSE = "DISPENSE";
    public static final String DELIVERY_IN = "DELIVERY_IN";
    public static final String DELIVERY_OUT = "DELIVERY_OUT";
    public static final String ADJUSTMENT = "ADJUSTMENT";

    @Id
    private UUID id = UUID.randomUUID();

    @Column(nullable = false)
    private String siteCode;

    @Column(nullable = false)
    private String product;

    @Column(nullable = false)
    private String kind;

    @Column(nullable = false)
    private BigDecimal litres;

    private String refType;
    private UUID refId;

    @Column(nullable = false)
    private Instant at = Instant.now();

    protected StockMovement() {}

    public StockMovement(String siteCode, String product, String kind, BigDecimal litres,
                         String refType, UUID refId) {
        this.siteCode = siteCode;
        this.product = product;
        this.kind = kind;
        this.litres = litres;
        this.refType = refType;
        this.refId = refId;
    }

    public UUID getId() { return id; }
    public String getSiteCode() { return siteCode; }
    public String getProduct() { return product; }
    public String getKind() { return kind; }
    public BigDecimal getLitres() { return litres; }
    public String getRefType() { return refType; }
    public UUID getRefId() { return refId; }
    public Instant getAt() { return at; }
}
