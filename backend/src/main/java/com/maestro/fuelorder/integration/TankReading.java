package com.maestro.fuelorder.integration;

import jakarta.persistence.*;
import java.math.BigDecimal;
import java.time.Instant;
import java.util.UUID;

/** One ATG (automatic tank gauge) reading. Skeleton convention: plain public fields, no setters. */
@Entity
@Table(name = "tank_readings", indexes = @Index(columnList = "siteCode, product, at"))
public class TankReading {
    @Id public UUID id = UUID.randomUUID();
    @Column(nullable = false) public String siteCode;
    @Column(nullable = false) public String product;
    @Column(nullable = false) public BigDecimal volumeLitres;
    public BigDecimal temperatureC;
    public BigDecimal waterMm;
    /** Volume corrected to 15 degrees C so deliveries and sales compare like for like. */
    public BigDecimal tcVolumeLitres;
    /** Device timestamp. */
    @Column(nullable = false) public Instant at;
    @Column(nullable = false) public Instant receivedAt = Instant.now();

    protected TankReading() {}

    public TankReading(String siteCode, String product, BigDecimal volumeLitres, BigDecimal temperatureC,
                       BigDecimal waterMm, BigDecimal tcVolumeLitres, Instant at) {
        this.siteCode = siteCode;
        this.product = product;
        this.volumeLitres = volumeLitres;
        this.temperatureC = temperatureC;
        this.waterMm = waterMm;
        this.tcVolumeLitres = tcVolumeLitres;
        this.at = at;
    }
}
