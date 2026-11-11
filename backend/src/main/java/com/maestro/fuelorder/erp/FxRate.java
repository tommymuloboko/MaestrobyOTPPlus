package com.maestro.fuelorder.erp;

import jakarta.persistence.*;
import java.math.BigDecimal;
import java.time.Instant;
import java.util.UUID;

@Entity
@Table(name = "fx_rates", uniqueConstraints = @UniqueConstraint(columnNames = {"fromCurrency", "toCurrency"}))
public class FxRate {
    @Id public UUID id = UUID.randomUUID();
    @Column(nullable = false) public String fromCurrency;
    @Column(nullable = false) public String toCurrency;
    @Column(nullable = false, precision = 18, scale = 6) public BigDecimal rate;
    @Column(nullable = false) public Instant at = Instant.now();

    protected FxRate() {}

    public FxRate(String from, String to, BigDecimal rate) {
        this.fromCurrency = from;
        this.toCurrency = to;
        this.rate = rate;
    }
}
