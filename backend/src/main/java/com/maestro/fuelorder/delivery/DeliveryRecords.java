package com.maestro.fuelorder.delivery;

import jakarta.persistence.*;
import java.math.BigDecimal;
import java.time.Instant;
import java.util.UUID;

/** Child records of a delivery, kept together to avoid a file per tiny table. */
public final class DeliveryRecords {

    private DeliveryRecords() {}

    @Entity(name = "GpsPosition")
    @Table(name = "gps_positions", indexes = @Index(columnList = "deliveryId, at"))
    public static class GpsPosition {
        @Id public UUID id = UUID.randomUUID();
        @Column(nullable = false) public UUID deliveryId;
        @Column(nullable = false) public double lat;
        @Column(nullable = false) public double lng;
        public Double speedKph;
        @Column(nullable = false) public Instant at = Instant.now();

        protected GpsPosition() {}

        public GpsPosition(UUID deliveryId, double lat, double lng, Double speedKph) {
            this.deliveryId = deliveryId;
            this.lat = lat;
            this.lng = lng;
            this.speedKph = speedKph;
        }
    }

    @Entity(name = "ProofOfDelivery")
    @Table(name = "proofs_of_delivery")
    public static class ProofOfDelivery {
        @Id public UUID id = UUID.randomUUID();
        @Column(nullable = false, unique = true) public UUID deliveryId;
        @Column(nullable = false) public String signedBy;
        /** Signature image as a small data URL or a drawn-signature reference. */
        @Lob public String signature;
        @Column(length = 500) public String notes;
        @Column(nullable = false) public BigDecimal deliveredLitres;
        @Column(nullable = false) public Instant at = Instant.now();

        protected ProofOfDelivery() {}

        public ProofOfDelivery(UUID deliveryId, String signedBy, String signature, String notes, BigDecimal deliveredLitres) {
            this.deliveryId = deliveryId;
            this.signedBy = signedBy;
            this.signature = signature;
            this.notes = notes;
            this.deliveredLitres = deliveredLitres;
        }
    }

    /** What the delivery note said against what actually went into the tank. */
    @Entity(name = "TankDelivery")
    @Table(name = "tank_deliveries")
    public static class TankDelivery {
        @Id public UUID id = UUID.randomUUID();
        @Column(nullable = false) public UUID deliveryId;
        @Column(nullable = false) public String siteCode;
        @Column(nullable = false) public String product;
        @Column(nullable = false) public BigDecimal documentedLitres;
        @Column(nullable = false) public BigDecimal measuredLitres;
        @Column(nullable = false) public BigDecimal varianceLitres;
        @Column(nullable = false) public Instant at = Instant.now();

        protected TankDelivery() {}

        public TankDelivery(UUID deliveryId, String siteCode, String product, BigDecimal documented, BigDecimal measured) {
            this.deliveryId = deliveryId;
            this.siteCode = siteCode;
            this.product = product;
            this.documentedLitres = documented;
            this.measuredLitres = measured;
            this.varianceLitres = measured.subtract(documented);
        }
    }
}
