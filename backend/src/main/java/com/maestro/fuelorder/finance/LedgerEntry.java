package com.maestro.fuelorder.finance;

import jakarta.persistence.*;
import java.math.BigDecimal;
import java.time.Instant;
import java.util.UUID;

/** Append-only double-entry line. Every posting writes a matching debit and credit. */
@Entity
@Table(name = "ledger_entries")
public class LedgerEntry {

    public static final String AR = "ACCOUNTS_RECEIVABLE";
    public static final String SALES = "FUEL_SALES";
    public static final String TAX = "TAX_PAYABLE";
    public static final String CASH = "CASH";

    @Id
    private UUID id = UUID.randomUUID();

    @Column(nullable = false)
    private String organization;

    @Column(nullable = false)
    private String account;

    @Column(nullable = false)
    private BigDecimal debit = BigDecimal.ZERO;

    @Column(nullable = false)
    private BigDecimal credit = BigDecimal.ZERO;

    private String refType;
    private UUID refId;

    @Column(length = 300)
    private String memo;

    @Column(nullable = false)
    private Instant at = Instant.now();

    protected LedgerEntry() {}

    public LedgerEntry(String organization, String account, BigDecimal debit, BigDecimal credit,
                       String refType, UUID refId, String memo) {
        this.organization = organization;
        this.account = account;
        this.debit = debit;
        this.credit = credit;
        this.refType = refType;
        this.refId = refId;
        this.memo = memo;
    }

    public UUID getId() { return id; }
    public String getOrganization() { return organization; }
    public String getAccount() { return account; }
    public BigDecimal getDebit() { return debit; }
    public BigDecimal getCredit() { return credit; }
    public String getRefType() { return refType; }
    public UUID getRefId() { return refId; }
    public String getMemo() { return memo; }
    public Instant getAt() { return at; }
}
