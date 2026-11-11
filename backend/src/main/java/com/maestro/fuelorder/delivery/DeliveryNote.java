package com.maestro.fuelorder.delivery;

import jakarta.persistence.*;
import java.math.BigDecimal;
import java.time.Instant;
import java.util.UUID;

/** A bulk delivery from a depot to a station tank or a customer's own site. Skeleton convention: public fields. */
@Entity
@Table(name = "delivery_notes")
public class DeliveryNote {

    public static final String PLANNED = "PLANNED";
    public static final String LOADING = "LOADING";
    public static final String IN_TRANSIT = "IN_TRANSIT";
    public static final String ARRIVED = "ARRIVED";
    public static final String OFFLOADED = "OFFLOADED";
    public static final String COMPLETED = "COMPLETED";
    public static final String CANCELLED = "CANCELLED";

    @Id public UUID id = UUID.randomUUID();
    @Column(nullable = false, unique = true) public String number;
    @Column(nullable = false) public String originSiteCode;
    /** SITE (into a station tank) or CUSTOMER (to the customer's own storage). */
    @Column(nullable = false) public String destinationType;
    public String destinationSiteCode;
    @Column(nullable = false) public String destinationName;
    public Double destLat;
    public Double destLng;
    /** Customer organization for CUSTOMER deliveries; lets that customer see its own receipts. */
    public String customer;
    @Column(nullable = false) public String product;
    @Column(nullable = false) public BigDecimal plannedLitres;
    public BigDecimal loadedLitres;
    public BigDecimal deliveredLitres;
    public String sealNumbers;
    @Column(nullable = false) public String truckReg;
    @Column(nullable = false) public String driverName;
    /** Special delivery surcharge per litre, fixed when the delivery is planned. */
    @Column(nullable = false) public BigDecimal surchargePerLitre = BigDecimal.ZERO;
    @Column(nullable = false) public String status = PLANNED;
    @Column(nullable = false) public Instant createdAt = Instant.now();

    protected DeliveryNote() {}

    public DeliveryNote(String number, String originSiteCode, String destinationType, String destinationSiteCode,
                        String destinationName, Double destLat, Double destLng, String customer, String product,
                        BigDecimal plannedLitres, String truckReg, String driverName, BigDecimal surchargePerLitre) {
        this.number = number;
        this.originSiteCode = originSiteCode;
        this.destinationType = destinationType;
        this.destinationSiteCode = destinationSiteCode;
        this.destinationName = destinationName;
        this.destLat = destLat;
        this.destLng = destLng;
        this.customer = customer;
        this.product = product;
        this.plannedLitres = plannedLitres;
        this.truckReg = truckReg;
        this.driverName = driverName;
        this.surchargePerLitre = surchargePerLitre;
    }
}
