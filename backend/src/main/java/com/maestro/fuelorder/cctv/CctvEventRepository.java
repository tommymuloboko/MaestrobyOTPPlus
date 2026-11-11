package com.maestro.fuelorder.cctv;

import org.springframework.data.jpa.repository.JpaRepository;
import java.util.List;
import java.util.UUID;

public interface CctvEventRepository extends JpaRepository<CctvEvent, UUID> {
    List<CctvEvent> findTop200ByOrderByAtDesc();
}
