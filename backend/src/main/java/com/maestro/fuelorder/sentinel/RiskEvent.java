package com.maestro.fuelorder.sentinel;

import jakarta.persistence.*;
import java.time.Instant;
import java.util.UUID;

@Entity
@Table(name = "risk_events")
public class RiskEvent {

    public static final String LOW = "LOW";
    public static final String MEDIUM = "MEDIUM";
    public static final String HIGH = "HIGH";
    public static final String CRITICAL = "CRITICAL";

    @Id
    private UUID id = UUID.randomUUID();

    @Column(nullable = false)
    private String rule;

    @Column(nullable = false)
    private String severity;

    @Column(nullable = false)
    private int score;

    /** OPEN, INVESTIGATING, CONFIRMED, DISMISSED. */
    @Column(nullable = false)
    private String status = "OPEN";

    /** The customer organization the event concerns, when there is one. */
    private String organization;
    private String siteCode;
    private String vehicleReg;
    private String driverName;
    private String attendantName;
    private String refType;
    private UUID refId;

    @Column(nullable = false, length = 800)
    private String details;

    /** What Sentinel did about it automatically, e.g. BLOCK_AUTH or NONE. */
    @Column(nullable = false)
    private String autoAction = "NONE";

    @Column(nullable = false)
    private Instant createdAt = Instant.now();

    protected RiskEvent() {}

    public RiskEvent(String rule, String severity, int score, String organization, String siteCode,
                     String vehicleReg, String driverName, String attendantName, String refType,
                     UUID refId, String details, String autoAction) {
        this.rule = rule;
        this.severity = severity;
        this.score = score;
        this.organization = organization;
        this.siteCode = siteCode;
        this.vehicleReg = vehicleReg;
        this.driverName = driverName;
        this.attendantName = attendantName;
        this.refType = refType;
        this.refId = refId;
        this.details = details;
        this.autoAction = autoAction;
    }

    public UUID getId() { return id; }
    public String getRule() { return rule; }
    public String getSeverity() { return severity; }
    public int getScore() { return score; }
    public String getStatus() { return status; }
    public String getOrganization() { return organization; }
    public String getSiteCode() { return siteCode; }
    public String getVehicleReg() { return vehicleReg; }
    public String getDriverName() { return driverName; }
    public String getAttendantName() { return attendantName; }
    public String getRefType() { return refType; }
    public UUID getRefId() { return refId; }
    public String getDetails() { return details; }
    public String getAutoAction() { return autoAction; }
    public Instant getCreatedAt() { return createdAt; }

    public void setStatus(String status) { this.status = status; }
}
