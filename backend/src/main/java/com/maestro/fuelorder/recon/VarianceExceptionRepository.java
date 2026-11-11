package com.maestro.fuelorder.recon;

import org.springframework.data.jpa.repository.JpaRepository;
import java.util.List;
import java.util.UUID;

public interface VarianceExceptionRepository extends JpaRepository<VarianceException, UUID> {
    List<VarianceException> findAllByOrderByCreatedAtDesc();
    long countByStatus(String status);
}
