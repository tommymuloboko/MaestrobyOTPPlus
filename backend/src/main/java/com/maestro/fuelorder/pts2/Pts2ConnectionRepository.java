package com.maestro.fuelorder.pts2;

import org.springframework.data.jpa.repository.JpaRepository;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

public interface Pts2ConnectionRepository extends JpaRepository<Pts2Connection, UUID> {
    Optional<Pts2Connection> findBySiteCode(String siteCode);
    List<Pts2Connection> findAllByOrderBySiteCodeAsc();
}
