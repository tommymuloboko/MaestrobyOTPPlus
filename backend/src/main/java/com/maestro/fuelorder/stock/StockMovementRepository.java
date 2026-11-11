package com.maestro.fuelorder.stock;

import org.springframework.data.jpa.repository.JpaRepository;
import java.time.Instant;
import java.util.List;
import java.util.UUID;

public interface StockMovementRepository extends JpaRepository<StockMovement, UUID> {
    List<StockMovement> findBySiteCodeAndProduct(String siteCode, String product);
    List<StockMovement> findBySiteCodeAndProductAndAtBetween(String siteCode, String product, Instant from, Instant to);
}
