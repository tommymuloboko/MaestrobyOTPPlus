package com.maestro.fuelorder.sentinel;

import org.springframework.data.jpa.repository.JpaRepository;
import java.util.Optional;
import java.util.UUID;

public interface FraudCaseRepository extends JpaRepository<FraudCase, UUID> {
    Optional<FraudCase> findByRiskEventId(UUID riskEventId);
}
