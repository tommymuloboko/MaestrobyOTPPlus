package com.maestro.fuelorder.erp;

import org.springframework.data.jpa.repository.JpaRepository;

import java.util.List;
import java.util.Optional;
import java.util.UUID;

public interface SettlementRunRepository extends JpaRepository<SettlementRun, UUID> {
    Optional<SettlementRun> findFirstByOrderByPeriodToDesc();

    List<SettlementRun> findAllByOrderByAtDesc();
}
