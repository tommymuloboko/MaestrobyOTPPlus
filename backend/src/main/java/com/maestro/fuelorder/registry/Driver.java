package com.maestro.fuelorder.registry;

import jakarta.persistence.*;
import java.time.Instant;
import java.util.UUID;

@Entity
@Table(name = "drivers", uniqueConstraints = @UniqueConstraint(columnNames = {"organization", "name"}))
public class Driver {

    @Id
    private UUID id = UUID.randomUUID();

    @Column(nullable = false)
    private String organization;

    @Column(nullable = false)
    private String name;

    private String phone;

    private String licenseNo;

    /** Registration of the vehicle this driver normally drives; pre-fills the order forms. */
    private String vehicleReg;

    /** Hash of the 4-digit identity PIN the attendant checks at the pump; deliberately has no getter. */
    private String pinHash;

    @Column(nullable = false)
    private boolean active = true;

    /** Identity check done by the OMC (licence and ID seen); informational, does not block ordering by itself. */
    @Column(nullable = false)
    private boolean verified = false;

    private String verifiedBy;

    private Instant verifiedAt;

    /** A suspended driver cannot be ordered for and cannot redeem a fuel code, until restored. */
    @Column(nullable = false)
    private boolean accessSuspended = false;

    private String suspendedReason;

    protected Driver() {}

    public Driver(String organization, String name, String phone, String licenseNo, String vehicleReg) {
        this.organization = organization;
        this.name = name;
        this.phone = phone;
        this.licenseNo = licenseNo;
        this.vehicleReg = vehicleReg;
    }

    public UUID getId() { return id; }
    public String getOrganization() { return organization; }
    public String getName() { return name; }
    public String getPhone() { return phone; }
    public String getLicenseNo() { return licenseNo; }
    public String getVehicleReg() { return vehicleReg; }
    public boolean isActive() { return active; }
    public boolean isVerified() { return verified; }
    public String getVerifiedBy() { return verifiedBy; }
    public Instant getVerifiedAt() { return verifiedAt; }
    public boolean isAccessSuspended() { return accessSuspended; }
    public String getSuspendedReason() { return suspendedReason; }

    public void assignVehicle(String vehicleReg) { this.vehicleReg = vehicleReg; }
    public void deactivate() { this.active = false; }

    public void verify(String by) {
        this.verified = true;
        this.verifiedBy = by;
        this.verifiedAt = Instant.now();
    }

    public void unverify() {
        this.verified = false;
        this.verifiedBy = null;
        this.verifiedAt = null;
    }

    public void suspend(String reason) {
        this.accessSuspended = true;
        this.suspendedReason = reason;
    }

    public void restore() {
        this.accessSuspended = false;
        this.suspendedReason = null;
    }

    public void setPin(String pin) { this.pinHash = hashPin(pin); }

    public boolean hasPin() { return pinHash != null; }

    public boolean pinMatches(String pin) {
        return pinHash != null && pin != null && java.security.MessageDigest.isEqual(
                hashPin(pin).getBytes(java.nio.charset.StandardCharsets.UTF_8),
                pinHash.getBytes(java.nio.charset.StandardCharsets.UTF_8));
    }

    private String hashPin(String pin) {
        try {
            var md = java.security.MessageDigest.getInstance("SHA-256");
            return java.util.HexFormat.of().formatHex(
                    md.digest((id + ":" + pin).getBytes(java.nio.charset.StandardCharsets.UTF_8)));
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }
}
