package com.maestro.fuelorder.order;

import org.springframework.data.jpa.repository.JpaRepository;
import java.util.Optional;
import java.util.UUID;

public interface ApprovalPolicyRepository extends JpaRepository<ApprovalPolicy, UUID> {
    Optional<ApprovalPolicy> findByOrganization(String organization);
}
