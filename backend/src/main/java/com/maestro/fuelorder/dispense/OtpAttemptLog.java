package com.maestro.fuelorder.dispense;

import org.springframework.stereotype.Component;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;

import java.util.UUID;

/** Writes attempts in their own transaction so a failed validation still leaves its trace. */
@Component
public class OtpAttemptLog {

    private final OtpAttemptRepository repo;

    public OtpAttemptLog(OtpAttemptRepository repo) {
        this.repo = repo;
    }

    @Transactional(propagation = Propagation.REQUIRES_NEW)
    public OtpAttempt record(String attendant, String outcome, UUID authorizationId, UUID orderId, String detail) {
        return repo.save(new OtpAttempt(attendant, outcome, authorizationId, orderId, detail));
    }
}
