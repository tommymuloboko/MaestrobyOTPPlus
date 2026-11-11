package com.maestro.fuelorder.org;

import org.springframework.data.jpa.repository.JpaRepository;
import java.util.Optional;
import java.util.UUID;

public interface CreditAccountRepository extends JpaRepository<CreditAccount, UUID> {
    Optional<CreditAccount> findByOrganization(String organization);
}
