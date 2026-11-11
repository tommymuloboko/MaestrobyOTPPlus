package com.maestro.fuelorder.pricing;

import org.springframework.data.jpa.repository.JpaRepository;
import java.util.Optional;
import java.util.UUID;

public interface ListPriceRepository extends JpaRepository<ListPrice, UUID> {
    Optional<ListPrice> findByProduct(String product);
}
