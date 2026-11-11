package com.maestro.fuelorder.stock;

import jakarta.persistence.*;
import java.math.BigDecimal;
import java.util.UUID;

@Entity
@Table(name = "tanks", uniqueConstraints = @UniqueConstraint(columnNames = {"siteCode", "product"}))
public class Tank {

    @Id
    private UUID id = UUID.randomUUID();

    @Column(nullable = false)
    private String siteCode;

    @Column(nullable = false)
    private String product;

    @Column(nullable = false)
    private BigDecimal capacityLitres;

    /** Book stock at the start of the ledger; every later change is a StockMovement. */
    @Column(nullable = false)
    private BigDecimal openingLitres;

    @Column(nullable = false)
    private BigDecimal reorderLitres;

    protected Tank() {}

    public Tank(String siteCode, String product, BigDecimal capacityLitres,
                BigDecimal openingLitres, BigDecimal reorderLitres) {
        this.siteCode = siteCode;
        this.product = product;
        this.capacityLitres = capacityLitres;
        this.openingLitres = openingLitres;
        this.reorderLitres = reorderLitres;
    }

    public UUID getId() { return id; }
    public String getSiteCode() { return siteCode; }
    public String getProduct() { return product; }
    public BigDecimal getCapacityLitres() { return capacityLitres; }
    public BigDecimal getOpeningLitres() { return openingLitres; }
    public BigDecimal getReorderLitres() { return reorderLitres; }
}
