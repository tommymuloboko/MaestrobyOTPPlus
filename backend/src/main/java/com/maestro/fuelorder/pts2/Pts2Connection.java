package com.maestro.fuelorder.pts2;

import jakarta.persistence.*;
import java.time.Instant;
import java.util.UUID;

/**
 * How the API reaches a site's PTS-2 controller over the network (jsonPTS over HTTP or HTTPS). One per site.
 * The password is kept because every request to the controller needs it; it is never returned by the API.
 */
@Entity
@Table(name = "pts2_connections")
public class Pts2Connection {

    @Id
    private UUID id = UUID.randomUUID();

    @Column(nullable = false, unique = true)
    private String siteCode;

    /** Full jsonPTS endpoint, such as http://192.168.1.117/jsonPTS. */
    @Column(nullable = false)
    private String url;

    @Column(nullable = false)
    private String username;

    @Column(nullable = false)
    private String password;

    @Column(nullable = false)
    private boolean enabled;

    @Column(nullable = false)
    private Instant updatedAt;

    protected Pts2Connection() {}

    public Pts2Connection(String siteCode, String url, String username, String password, boolean enabled) {
        this.siteCode = siteCode;
        update(url, username, password, enabled);
    }

    /** A null password keeps the one already stored. */
    public void update(String url, String username, String password, boolean enabled) {
        this.url = url;
        this.username = username;
        if (password != null) {
            this.password = password;
        }
        this.enabled = enabled;
        this.updatedAt = Instant.now();
    }

    public UUID getId() { return id; }
    public String getSiteCode() { return siteCode; }
    public String getUrl() { return url; }
    public String getUsername() { return username; }
    public String getPassword() { return password; }
    public boolean isEnabled() { return enabled; }
    public Instant getUpdatedAt() { return updatedAt; }
}
