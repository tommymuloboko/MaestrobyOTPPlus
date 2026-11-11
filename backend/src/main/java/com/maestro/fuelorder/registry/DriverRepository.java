package com.maestro.fuelorder.registry;

import org.springframework.data.jpa.repository.JpaRepository;
import java.util.Optional;
import java.util.UUID;

public interface DriverRepository extends JpaRepository<Driver, UUID> {
    Optional<Driver> findByOrganizationAndNameIgnoreCaseAndActiveTrue(String organization, String name);
    boolean existsByOrganizationAndNameIgnoreCase(String organization, String name);
    java.util.List<Driver> findByOrganizationAndActiveTrue(String organization);
}
