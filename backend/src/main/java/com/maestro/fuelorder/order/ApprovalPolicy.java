package com.maestro.fuelorder.order;

import jakarta.persistence.*;
import java.math.BigDecimal;
import java.util.UUID;

/** A supplier's configurable approval rule: small orders from customers in good standing skip manual review. */
@Entity
@Table(name = "approval_policies")
public class ApprovalPolicy {

    @Id
    private UUID id = UUID.randomUUID();

    @Column(nullable = false, unique = true)
    private String organization;

    /** Orders up to this many litres are approved automatically; 0 switches auto-approval off. */
    @Column(nullable = false)
    private BigDecimal autoApproveMaxLitres;

    /** When set, approval (manual or automatic) is blocked if the customer would exceed their credit limit. */
    @Column(nullable = false)
    private boolean enforceCreditLimit = true;

    protected ApprovalPolicy() {}

    public ApprovalPolicy(String organization, BigDecimal autoApproveMaxLitres, boolean enforceCreditLimit) {
        this.organization = organization;
        this.autoApproveMaxLitres = autoApproveMaxLitres;
        this.enforceCreditLimit = enforceCreditLimit;
    }

    public UUID getId() { return id; }
    public String getOrganization() { return organization; }
    public BigDecimal getAutoApproveMaxLitres() { return autoApproveMaxLitres; }
    public boolean isEnforceCreditLimit() { return enforceCreditLimit; }

    public void update(BigDecimal autoApproveMaxLitres, boolean enforceCreditLimit) {
        this.autoApproveMaxLitres = autoApproveMaxLitres;
        this.enforceCreditLimit = enforceCreditLimit;
    }
}
