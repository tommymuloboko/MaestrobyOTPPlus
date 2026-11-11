package com.maestro.fuelorder.dispense;

import jakarta.persistence.*;
import java.math.BigDecimal;
import java.time.Instant;
import java.util.UUID;

@Entity
@Table(name = "fuel_transactions")
public class FuelTransaction {

    @Id
    private UUID id = UUID.randomUUID();

    @Column(nullable = false)
    private UUID authorizationId;

    @Column(nullable = false)
    private UUID orderId;

    @Column(nullable = false)
    private String siteName;

    @Column(nullable = false)
    private String vehicleReg;

    @Column(nullable = false)
    private String driverName;

    @Column(nullable = false)
    private String attendantName;

    @Column(nullable = false)
    private BigDecimal volumeLitres;

    @Column(nullable = false)
    private BigDecimal unitPrice;

    @Column(nullable = false)
    private BigDecimal amount;

    @Column(nullable = false)
    private Instant dispensedAt = Instant.now();

    protected FuelTransaction() {}

    public FuelTransaction(UUID authorizationId, UUID orderId, String siteName, String vehicleReg,
                           String driverName, String attendantName, BigDecimal volumeLitres,
                           BigDecimal unitPrice) {
        this.authorizationId = authorizationId;
        this.orderId = orderId;
        this.siteName = siteName;
        this.vehicleReg = vehicleReg;
        this.driverName = driverName;
        this.attendantName = attendantName;
        this.volumeLitres = volumeLitres;
        this.unitPrice = unitPrice;
        this.amount = unitPrice.multiply(volumeLitres);
    }

    public UUID getId() { return id; }
    public UUID getAuthorizationId() { return authorizationId; }
    public UUID getOrderId() { return orderId; }
    public String getSiteName() { return siteName; }
    public String getVehicleReg() { return vehicleReg; }
    public String getDriverName() { return driverName; }
    public String getAttendantName() { return attendantName; }
    public BigDecimal getVolumeLitres() { return volumeLitres; }
    public BigDecimal getUnitPrice() { return unitPrice; }
    public BigDecimal getAmount() { return amount; }
    public Instant getDispensedAt() { return dispensedAt; }
}
