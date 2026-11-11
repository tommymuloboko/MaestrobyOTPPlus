package com.maestro.fuelorder.dispense;

import org.springframework.data.jpa.repository.JpaRepository;
import java.util.Optional;
import java.util.UUID;

public interface OtpAuthorizationRepository extends JpaRepository<OtpAuthorization, UUID> {
    Optional<OtpAuthorization> findByCodeHash(String codeHash);
    Optional<OtpAuthorization> findByOrderId(UUID orderId);
    /** Expiry is always 24 hours after issue, so ordering by it is ordering by age. */
    java.util.List<OtpAuthorization> findTop200ByOrderByExpiresAtDesc();
}
