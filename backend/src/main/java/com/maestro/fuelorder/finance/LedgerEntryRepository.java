package com.maestro.fuelorder.finance;

import org.springframework.data.jpa.repository.JpaRepository;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

public interface LedgerEntryRepository extends JpaRepository<LedgerEntry, UUID> {
    List<LedgerEntry> findTop300ByOrderByAtDesc();
    List<LedgerEntry> findByOrganization(String organization);
}
