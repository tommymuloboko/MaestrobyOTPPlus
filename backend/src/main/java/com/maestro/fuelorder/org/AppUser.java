package com.maestro.fuelorder.org;

import jakarta.persistence.*;
import java.util.UUID;

@Entity
@Table(name = "app_users")
public class AppUser {

    @Id
    private UUID id = UUID.randomUUID();

    @Column(nullable = false, unique = true)
    private String email;

    @Column(nullable = false)
    private String name;

    /** Fleet Manager (customer), Station Manager, Attendant, Finance, Platform Admin. */
    @Column(nullable = false)
    private String role;

    @Column(nullable = false)
    private String organization;

    private String branchCode;

    @Column(nullable = false)
    private String passwordHash;

    @Column(nullable = false)
    private boolean active = true;

    protected AppUser() {}

    public AppUser(String email, String name, String role, String organization, String branchCode, String passwordHash) {
        this.email = email.trim().toLowerCase();
        this.name = name;
        this.role = role;
        this.organization = organization;
        this.branchCode = branchCode;
        this.passwordHash = passwordHash;
    }

    public UUID getId() { return id; }
    public String getEmail() { return email; }
    public String getName() { return name; }
    public String getRole() { return role; }
    public String getOrganization() { return organization; }
    public String getBranchCode() { return branchCode; }
    public boolean isActive() { return active; }

    public void update(String name, String role, String organization, String branchCode) {
        this.name = name;
        this.role = role;
        this.organization = organization;
        this.branchCode = branchCode;
    }

    public void setActive(boolean active) { this.active = active; }

    public void setPasswordHash(String passwordHash) { this.passwordHash = passwordHash; }

    /** Not exposed in JSON: there is deliberately no getter. */
    public boolean passwordMatches(String candidateHash) {
        return java.security.MessageDigest.isEqual(
                candidateHash.getBytes(java.nio.charset.StandardCharsets.UTF_8),
                passwordHash.getBytes(java.nio.charset.StandardCharsets.UTF_8));
    }
}
