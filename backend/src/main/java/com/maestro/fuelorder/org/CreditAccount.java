package com.maestro.fuelorder.org;

import jakarta.persistence.*;
import java.math.BigDecimal;
import java.util.UUID;

@Entity
@Table(name = "credit_accounts")
public class CreditAccount {

    @Id
    private UUID id = UUID.randomUUID();

    @Column(nullable = false, unique = true)
    private String organization;

    @Column(nullable = false)
    private BigDecimal creditLimit;

    /** PREPAID, NET_7, NET_30 ... */
    @Column(nullable = false)
    private String terms;

    @Column(nullable = false)
    private BigDecimal monthlyBudget;

    protected CreditAccount() {}

    public CreditAccount(String organization, BigDecimal creditLimit, String terms, BigDecimal monthlyBudget) {
        this.organization = organization;
        this.creditLimit = creditLimit;
        this.terms = terms;
        this.monthlyBudget = monthlyBudget;
    }

    public UUID getId() { return id; }
    public String getOrganization() { return organization; }
    public BigDecimal getCreditLimit() { return creditLimit; }
    public String getTerms() { return terms; }
    public BigDecimal getMonthlyBudget() { return monthlyBudget; }

    public int termsDays() {
        return switch (terms) {
            case "NET_7" -> 7;
            case "NET_30" -> 30;
            case "NET_60" -> 60;
            default -> 0;
        };
    }

    public void update(BigDecimal creditLimit, String terms, BigDecimal monthlyBudget) {
        this.creditLimit = creditLimit;
        this.terms = terms;
        this.monthlyBudget = monthlyBudget;
    }
}
