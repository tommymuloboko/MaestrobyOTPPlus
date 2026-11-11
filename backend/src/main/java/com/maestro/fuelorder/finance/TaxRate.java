package com.maestro.fuelorder.finance;

import jakarta.persistence.*;
import java.math.BigDecimal;
import java.time.LocalDate;
import java.util.UUID;

/** Tax by country. The seeded rates are demo values; confirm them with a tax adviser before real use. */
@Entity
@Table(name = "tax_rates")
public class TaxRate {

    @Id
    private UUID id = UUID.randomUUID();

    @Column(nullable = false)
    private String country;

    @Column(nullable = false)
    private String name;

    @Column(nullable = false)
    private BigDecimal ratePercent;

    @Column(nullable = false)
    private LocalDate validFrom;

    protected TaxRate() {}

    public TaxRate(String country, String name, BigDecimal ratePercent, LocalDate validFrom) {
        this.country = country;
        this.name = name;
        this.ratePercent = ratePercent;
        this.validFrom = validFrom;
    }

    public UUID getId() { return id; }
    public String getCountry() { return country; }
    public String getName() { return name; }
    public BigDecimal getRatePercent() { return ratePercent; }
    public LocalDate getValidFrom() { return validFrom; }
}
