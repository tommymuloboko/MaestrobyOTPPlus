package com.maestro.fuelorder.site;

import org.springframework.data.jpa.repository.JpaRepository;

import java.util.List;
import java.util.Optional;
import java.util.UUID;

public interface SiteRepository extends JpaRepository<Site, UUID> {
    Optional<Site> findByCodeIgnoreCase(String code);
    Optional<Site> findByPts2Id(String pts2Id);
    boolean existsByCodeIgnoreCase(String code);
    boolean existsByPts2Id(String pts2Id);
    List<Site> findAllByOrderByCreatedAtAscCodeAsc();
}
