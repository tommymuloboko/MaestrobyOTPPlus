package com.maestro.fuelorder.org;

import jakarta.persistence.*;
import java.util.UUID;

@Entity
@Table(name = "branches", uniqueConstraints = @UniqueConstraint(columnNames = {"organization", "code"}))
public class Branch {

    @Id
    private UUID id = UUID.randomUUID();

    @Column(nullable = false)
    private String organization;

    @Column(nullable = false)
    private String code;

    @Column(nullable = false)
    private String name;

    private String city;

    protected Branch() {}

    public Branch(String organization, String code, String name, String city) {
        this.organization = organization;
        this.code = code;
        this.name = name;
        this.city = city;
    }

    public UUID getId() { return id; }
    public String getOrganization() { return organization; }
    public String getCode() { return code; }
    public String getName() { return name; }
    public String getCity() { return city; }
}
