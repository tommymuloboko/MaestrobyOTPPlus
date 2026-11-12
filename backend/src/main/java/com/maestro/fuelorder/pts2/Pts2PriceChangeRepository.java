package com.maestro.fuelorder.pts2;

import org.springframework.data.jpa.repository.JpaRepository;
import java.util.List;
import java.util.UUID;

public interface Pts2PriceChangeRepository extends JpaRepository<Pts2PriceChange, UUID> {
    List<Pts2PriceChange> findTop100BySiteCodeOrderByAtDesc(String siteCode);
}
