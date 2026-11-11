package com.maestro.fuelorder.sentinel;

import org.springframework.data.jpa.repository.JpaRepository;
import java.time.Instant;
import java.util.List;
import java.util.UUID;

public interface RiskEventRepository extends JpaRepository<RiskEvent, UUID> {
    List<RiskEvent> findTop200ByOrderByCreatedAtDesc();
    List<RiskEvent> findTop200ByOrganizationOrderByCreatedAtDesc(String organization);
    List<RiskEvent> findByCreatedAtAfter(Instant after);
    long countByStatus(String status);
    long countBySeverityAndStatus(String severity, String status);
}
