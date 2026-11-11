package com.maestro.fuelorder.dispense;

import org.springframework.data.jpa.repository.JpaRepository;
import java.time.Instant;
import java.util.List;
import java.util.UUID;

public interface OtpAttemptRepository extends JpaRepository<OtpAttempt, UUID> {
    long countByAttendantAndOutcomeAndAtAfter(String attendant, String outcome, Instant after);
    long countByAuthorizationIdAndOutcome(UUID authorizationId, String outcome);
    List<OtpAttempt> findTop100ByOrderByAtDesc();
}
