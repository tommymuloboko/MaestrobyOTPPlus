package com.maestro.fuelorder.org;

import jakarta.persistence.*;
import java.time.Instant;
import java.util.UUID;

@Entity
@Table(name = "organizations")
public class Organization {

    public static final String CUSTOMER = "CUSTOMER";
    public static final String SUPPLIER = "SUPPLIER";
    public static final String PLATFORM = "PLATFORM";

    @Id
    private UUID id = UUID.randomUUID();

    @Column(nullable = false, unique = true)
    private String name;

    @Column(nullable = false)
    private String type;

    @Column(nullable = false)
    private String status = "ACTIVE";

    private String country;
    private String currency;
    private String contactEmail;
    private String contactPhone;
    private String registrationNo;

    /** White-label branding shown to this organization's users. */
    private String brandName;
    private String primaryColor;

    @Column(nullable = false)
    private Instant createdAt = Instant.now();

    protected Organization() {}

    public Organization(String name, String type, String country, String currency,
                        String contactEmail, String contactPhone, String registrationNo) {
        this.name = name;
        this.type = type;
        this.country = country;
        this.currency = currency;
        this.contactEmail = contactEmail;
        this.contactPhone = contactPhone;
        this.registrationNo = registrationNo;
    }

    public UUID getId() { return id; }
    public String getName() { return name; }
    public String getType() { return type; }
    public String getStatus() { return status; }
    public String getCountry() { return country; }
    public String getCurrency() { return currency; }
    public String getContactEmail() { return contactEmail; }
    public String getContactPhone() { return contactPhone; }
    public String getRegistrationNo() { return registrationNo; }
    public String getBrandName() { return brandName; }
    public String getPrimaryColor() { return primaryColor; }
    public Instant getCreatedAt() { return createdAt; }

    public void brand(String brandName, String primaryColor) {
        this.brandName = brandName;
        this.primaryColor = primaryColor;
    }
}
