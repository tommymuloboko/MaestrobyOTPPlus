package com.maestro.fuelorder.dispense;

import jakarta.persistence.*;
import java.math.BigDecimal;
import java.time.Instant;
import java.util.UUID;

@Entity
@Table(name = "otp_authorizations")
public class OtpAuthorization {

    public enum Status { ACTIVE, REDEEMED, EXPIRED, REVOKED }

    @Id
    private UUID id = UUID.randomUUID();

    @Column(nullable = false)
    private UUID orderId;

    /** SHA-256 of the OTP — plaintext is never stored. */
    @Column(nullable = false, unique = true)
    private String codeHash;

    @Column(nullable = false)
    private BigDecimal maxVolumeLitres;

    @Column(nullable = false)
    private String vehicleReg;

    @Column(nullable = false)
    private String driverName;

    @Column(nullable = false)
    private String siteName;

    @Column(nullable = false)
    private String fuelProduct;

    @Column(nullable = false)
    private Instant expiresAt;

    @Enumerated(EnumType.STRING)
    @Column(nullable = false)
    private Status status = Status.ACTIVE;

    private Instant redeemedAt;

    @Version
    private long version;

    protected OtpAuthorization() {}

    public OtpAuthorization(UUID orderId, String codeHash, BigDecimal maxVolumeLitres,
                            String vehicleReg, String driverName, String siteName,
                            String fuelProduct, Instant expiresAt) {
        this.orderId = orderId;
        this.codeHash = codeHash;
        this.maxVolumeLitres = maxVolumeLitres;
        this.vehicleReg = vehicleReg;
        this.driverName = driverName;
        this.siteName = siteName;
        this.fuelProduct = fuelProduct;
        this.expiresAt = expiresAt;
    }

    public UUID getId() { return id; }
    public UUID getOrderId() { return orderId; }
    public String getCodeHash() { return codeHash; }
    public BigDecimal getMaxVolumeLitres() { return maxVolumeLitres; }
    public String getVehicleReg() { return vehicleReg; }
    public String getDriverName() { return driverName; }
    public String getSiteName() { return siteName; }
    public String getFuelProduct() { return fuelProduct; }
    public Instant getExpiresAt() { return expiresAt; }
    public Status getStatus() { return status; }
    public Instant getRedeemedAt() { return redeemedAt; }

    public boolean isExpired(Instant now) {
        return now.isAfter(expiresAt);
    }

    /** Single-use: flips ACTIVE -> REDEEMED exactly once; optimistic lock blocks races. */
    public void redeem(Instant now) {
        if (status != Status.ACTIVE) {
            throw new IllegalStateException("OTP is " + status + " and can never be reused");
        }
        if (isExpired(now)) {
            this.status = Status.EXPIRED;
            throw new IllegalStateException("OTP expired at " + expiresAt);
        }
        this.status = Status.REDEEMED;
        this.redeemedAt = now;
    }

    public void expire() {
        if (status == Status.ACTIVE) {
            this.status = Status.EXPIRED;
        }
    }

    /**
     * Replaces the code with a fresh one (same order, limits and driver) after a loss or an expiry. The old code stops
     * working because its hash is gone. A redeemed authorization is never reissued: fuel was already drawn on it.
     */
    public void reissue(String newCodeHash, Instant newExpiry) {
        if (status == Status.REDEEMED) {
            throw new IllegalStateException("This authorization was already redeemed and can never be reissued");
        }
        this.codeHash = newCodeHash;
        this.expiresAt = newExpiry;
        this.status = Status.ACTIVE;
    }

    /** Sentinel blocking action: the code can no longer be redeemed. */
    public void revoke() {
        if (status == Status.ACTIVE) {
            this.status = Status.REVOKED;
        }
    }
}
