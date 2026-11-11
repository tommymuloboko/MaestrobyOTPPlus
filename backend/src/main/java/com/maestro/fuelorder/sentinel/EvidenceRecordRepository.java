package com.maestro.fuelorder.sentinel;

import org.springframework.data.jpa.repository.JpaRepository;
import java.util.List;
import java.util.UUID;

public interface EvidenceRecordRepository extends JpaRepository<EvidenceRecord, UUID> {
    List<EvidenceRecord> findAllByOrderByCreatedAtAsc();
    List<EvidenceRecord> findByRiskEventId(UUID riskEventId);
}
