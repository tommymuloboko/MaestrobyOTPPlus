package com.maestro.fuelorder.recon;

import org.springframework.data.jpa.repository.JpaRepository;
import java.util.List;
import java.util.UUID;

public interface ReconciliationRunRepository extends JpaRepository<ReconciliationRun, UUID> {
    List<ReconciliationRun> findTop100ByOrderByAtDesc();
}
