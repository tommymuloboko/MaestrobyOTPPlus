package com.maestro.fuelorder.stock;

import org.springframework.data.jpa.repository.JpaRepository;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

public interface TankRepository extends JpaRepository<Tank, UUID> {
    Optional<Tank> findBySiteCodeAndProduct(String siteCode, String product);
}
