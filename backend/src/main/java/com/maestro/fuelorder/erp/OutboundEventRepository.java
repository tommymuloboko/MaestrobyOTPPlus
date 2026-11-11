package com.maestro.fuelorder.erp;

import org.springframework.data.jpa.repository.JpaRepository;

import java.util.List;
import java.util.UUID;

public interface OutboundEventRepository extends JpaRepository<OutboundEvent, UUID> {
    List<OutboundEvent> findTop200ByOrderByAtDesc();

    List<OutboundEvent> findByKindAndStatus(String kind, String status);
}
