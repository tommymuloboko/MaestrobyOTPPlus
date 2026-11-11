package com.maestro.fuelorder.pricing;

import jakarta.persistence.*;
import java.math.BigDecimal;
import java.time.LocalDate;
import java.util.UUID;

/** The supplier's published price for a product; customer rules adjust or replace it. */
@Entity
@Table(name = "list_prices")
public class ListPrice {

    @Id
    private UUID id = UUID.randomUUID();

    @Column(nullable = false, unique = true)
    private String product;

    @Column(nullable = false)
    private BigDecimal unitPrice;

    @Column(nullable = false)
    private String currency;

    @Column(nullable = false)
    private LocalDate validFrom;

    protected ListPrice() {}

    public ListPrice(String product, BigDecimal unitPrice, String currency, LocalDate validFrom) {
        this.product = product;
        this.unitPrice = unitPrice;
        this.currency = currency;
        this.validFrom = validFrom;
    }

    public UUID getId() { return id; }
    public String getProduct() { return product; }
    public BigDecimal getUnitPrice() { return unitPrice; }
    public String getCurrency() { return currency; }
    public LocalDate getValidFrom() { return validFrom; }
}
