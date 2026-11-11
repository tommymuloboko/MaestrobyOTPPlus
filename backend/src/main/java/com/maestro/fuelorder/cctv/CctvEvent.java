package com.maestro.fuelorder.cctv;

import jakarta.persistence.*;
import java.time.Instant;
import java.util.UUID;

/** A detection from the site's CCTV/VMS. Skeleton convention: public fields. */
@Entity
@Table(name = "cctv_events")
public class CctvEvent {
    @Id public UUID id = UUID.randomUUID();
    @Column(nullable = false) public String siteCode;
    @Column(nullable = false) public String cameraId;
    /** CONTAINER_DETECTED, NOZZLE_AWAY, ATTENDANT_BEHAVIOR or ANPR. */
    @Column(nullable = false) public String kind;
    public String plate;
    @Column(nullable = false) public double confidence;
    /** Reference to the short evidence clip held by the VMS or object storage. */
    public String clipRef;
    public UUID riskEventId;
    @Column(nullable = false) public Instant at = Instant.now();

    protected CctvEvent() {}

    public CctvEvent(String siteCode, String cameraId, String kind, String plate, double confidence, String clipRef) {
        this.siteCode = siteCode;
        this.cameraId = cameraId;
        this.kind = kind;
        this.plate = plate;
        this.confidence = confidence;
        this.clipRef = clipRef;
    }
}
