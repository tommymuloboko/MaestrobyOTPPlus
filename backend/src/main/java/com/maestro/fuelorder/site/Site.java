package com.maestro.fuelorder.site;

import jakarta.persistence.*;

import java.time.Instant;
import java.util.UUID;

/**
 * A station, depot or fuel depot. It is identified on the platform by its code and, on the forecourt, by the unique
 * ID of its PTS-2 controller: telemetry sent under that ID is attributed to this site.
 */
@Entity
@Table(name = "sites")
public class Site {

    public static final String STATION = "STATION";
    public static final String DEPOT = "DEPOT";
    public static final String FUEL_DEPOT = "FUEL_DEPOT";

    @Id
    private UUID id = UUID.randomUUID();

    @Column(nullable = false, unique = true)
    private String code;

    @Column(nullable = false)
    private String name;

    @Column(nullable = false)
    private String kind;

    /** Normalised to upper case without spaces. */
    @Column(nullable = false, unique = true)
    private String pts2Id;

    /** Used to confirm that a delivery truck has arrived. */
    @Column(nullable = false)
    private double latitude;

    @Column(nullable = false)
    private double longitude;

    @Column(nullable = false)
    private Instant createdAt;

    protected Site() {}

    public Site(String code, String name, String kind, String pts2Id, double latitude, double longitude, Instant createdAt) {
        this.code = code;
        this.name = name;
        this.kind = kind;
        this.pts2Id = pts2Id;
        this.latitude = latitude;
        this.longitude = longitude;
        this.createdAt = createdAt;
    }

    public UUID getId() { return id; }
    public String getCode() { return code; }
    public String getName() { return name; }
    public String getKind() { return kind; }
    public String getPts2Id() { return pts2Id; }
    public double getLatitude() { return latitude; }
    public double getLongitude() { return longitude; }
    public Instant getCreatedAt() { return createdAt; }
}
