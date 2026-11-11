package com.maestro.fuelorder.audit;

import jakarta.persistence.*;
import java.time.Instant;
import java.util.UUID;

/** Append-only: there are no setters and no update/delete endpoints. */
@Entity
@Table(name = "audit_logs")
public class AuditLog {

    @Id
    private UUID id = UUID.randomUUID();

    @Column(nullable = false)
    private Instant at = Instant.now();

    private String actorEmail;
    private String actorRole;
    private String organization;

    @Column(nullable = false)
    private String method;

    @Column(nullable = false, length = 500)
    private String path;

    @Column(nullable = false)
    private int status;

    private String ip;

    protected AuditLog() {}

    public AuditLog(String actorEmail, String actorRole, String organization,
                    String method, String path, int status, String ip) {
        this.actorEmail = actorEmail;
        this.actorRole = actorRole;
        this.organization = organization;
        this.method = method;
        this.path = path;
        this.status = status;
        this.ip = ip;
    }

    public UUID getId() { return id; }
    public Instant getAt() { return at; }
    public String getActorEmail() { return actorEmail; }
    public String getActorRole() { return actorRole; }
    public String getOrganization() { return organization; }
    public String getMethod() { return method; }
    public String getPath() { return path; }
    public int getStatus() { return status; }
    public String getIp() { return ip; }
}
