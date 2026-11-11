package com.maestro.fuelorder.registry;

import org.springframework.data.jpa.repository.JpaRepository;
import java.util.Optional;
import java.util.UUID;

public interface VehicleRepository extends JpaRepository<Vehicle, UUID> {
    Optional<Vehicle> findByOrganizationAndRegistrationIgnoreCaseAndActiveTrue(String organization, String registration);
    boolean existsByOrganizationAndRegistrationIgnoreCase(String organization, String registration);
    java.util.List<Vehicle> findByOrganizationAndActiveTrueOrderByRegistration(String organization);
}
