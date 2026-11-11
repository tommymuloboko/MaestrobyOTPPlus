package com.maestro.fuelorder.integration;

import org.springframework.data.jpa.repository.JpaRepository;
import java.time.Instant;
import java.util.List;
import java.util.UUID;

public interface PumpEventRepository extends JpaRepository<PumpEvent, UUID> {
    List<PumpEvent> findBySiteCodeAndKindAndAtBetweenOrderByAtAsc(String siteCode, String kind, Instant from, Instant to);
    boolean existsBySiteCodeAndPumpIdAndKindAndAt(String siteCode, String pumpId, String kind, Instant at);
    List<PumpEvent> findTop200ByOrderByAtDesc();
}
