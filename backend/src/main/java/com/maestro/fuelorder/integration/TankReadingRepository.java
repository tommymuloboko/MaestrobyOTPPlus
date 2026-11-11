package com.maestro.fuelorder.integration;

import org.springframework.data.jpa.repository.JpaRepository;
import java.time.Instant;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

public interface TankReadingRepository extends JpaRepository<TankReading, UUID> {
    boolean existsBySiteCodeAndProductAndAt(String siteCode, String product, Instant at);
    Optional<TankReading> findFirstBySiteCodeAndProductAndAtBeforeOrderByAtDesc(String siteCode, String product, Instant before);
    List<TankReading> findTop300ByOrderByAtDesc();
    List<TankReading> findBySiteCodeAndProductOrderByAtAsc(String siteCode, String product);
}
