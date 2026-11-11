package com.maestro.fuelorder.integration;

import jakarta.persistence.*;
import java.time.Instant;
import java.util.UUID;

/** Last-seen state of a field device, used to detect a controller that has gone quiet. */
@Entity
@Table(name = "device_status")
public class DeviceStatus {
    @Id public UUID id = UUID.randomUUID();
    @Column(nullable = false, unique = true) public String deviceId;
    @Column(nullable = false) public String siteCode;
    /** ATG, PUMP or FLOW_METER. */
    @Column(nullable = false) public String kind;
    @Column(nullable = false) public Instant lastSeen = Instant.now();
    @Column(nullable = false) public boolean online = true;

    protected DeviceStatus() {}

    public DeviceStatus(String deviceId, String siteCode, String kind) {
        this.deviceId = deviceId;
        this.siteCode = siteCode;
        this.kind = kind;
    }
}
