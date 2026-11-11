package com.maestro.fuelorder.pricing;

import org.springframework.data.jpa.repository.JpaRepository;
import java.util.List;
import java.util.UUID;

public interface PriceRuleRepository extends JpaRepository<PriceRule, UUID> {
    List<PriceRule> findByOrganizationAndProductAndStatus(String organization, String product, String status);
    List<PriceRule> findByOrganization(String organization);
}
