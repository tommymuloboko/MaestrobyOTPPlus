package com.maestro.fuelorder.erp;

import org.springframework.data.jpa.repository.JpaRepository;

import java.util.List;
import java.util.Optional;
import java.util.UUID;

public interface FxRateRepository extends JpaRepository<FxRate, UUID> {
    Optional<FxRate> findByFromCurrencyAndToCurrency(String from, String to);

    List<FxRate> findAllByOrderByFromCurrencyAscToCurrencyAsc();
}
