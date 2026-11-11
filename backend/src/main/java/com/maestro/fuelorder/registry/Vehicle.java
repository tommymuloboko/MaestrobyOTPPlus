package com.maestro.fuelorder.registry;

import jakarta.persistence.*;
import java.math.BigDecimal;
import java.util.UUID;

@Entity
@Table(name = "vehicles", uniqueConstraints = @UniqueConstraint(columnNames = {"organization", "registration"}))
public class Vehicle {

    @Id
    private UUID id = UUID.randomUUID();

    @Column(nullable = false)
    private String organization;

    @Column(nullable = false)
    private String registration;

    private String description;

    /** Truck, pickup, van, car... free text so a customer is not boxed in by a fixed list. */
    private String vehicleType;

    private String model;

    private Integer modelYear;

    /** PETROL or DIESEL. */
    @Column(nullable = false)
    private String fuelType;

    @Column(nullable = false)
    private BigDecimal tankCapacityLitres;

    @Column(nullable = false)
    private boolean active = true;

    protected Vehicle() {}

    public Vehicle(String organization, String registration, String description,
                   String fuelType, BigDecimal tankCapacityLitres) {
        this.organization = organization;
        this.registration = registration;
        this.description = description;
        this.fuelType = fuelType;
        this.tankCapacityLitres = tankCapacityLitres;
    }

    public UUID getId() { return id; }
    public String getOrganization() { return organization; }
    public String getRegistration() { return registration; }
    public String getDescription() { return description; }
    public String getVehicleType() { return vehicleType; }
    public String getModel() { return model; }
    public Integer getModelYear() { return modelYear; }
    public String getFuelType() { return fuelType; }
    public BigDecimal getTankCapacityLitres() { return tankCapacityLitres; }
    public boolean isActive() { return active; }

    public void deactivate() { this.active = false; }

    /** Sets the type, model and year the vehicle was built; blank text clears a value. */
    public void identify(String vehicleType, String model, Integer modelYear) {
        this.vehicleType = clean(vehicleType);
        this.model = clean(model);
        this.modelYear = modelYear;
    }

    /** A null argument leaves that field as it is; blank text clears it. */
    public void update(String description, BigDecimal tankCapacityLitres, String vehicleType, String model, Integer modelYear) {
        if (description != null) {
            this.description = clean(description);
        }
        if (tankCapacityLitres != null) {
            this.tankCapacityLitres = tankCapacityLitres;
        }
        if (vehicleType != null) {
            this.vehicleType = clean(vehicleType);
        }
        if (model != null) {
            this.model = clean(model);
        }
        if (modelYear != null) {
            this.modelYear = modelYear;
        }
    }

    private static String clean(String text) {
        return text == null || text.isBlank() ? null : text.trim();
    }
}
