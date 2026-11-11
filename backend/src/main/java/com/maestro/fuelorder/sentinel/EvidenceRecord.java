package com.maestro.fuelorder.sentinel;

import jakarta.persistence.*;
import java.time.Instant;
import java.util.UUID;

/**
 * Protected evidence for a high-risk event. Append-only and hash-chained: each record's hash covers the
 * previous record's hash, so altering or removing any record breaks every later one.
 */
@Entity
@Table(name = "evidence_records")
public class EvidenceRecord {

    @Id
    private UUID id = UUID.randomUUID();

    @Column(nullable = false)
    private UUID riskEventId;

    /** Transaction data, pump readings, driver identity, site/GPS and any CCTV clip reference, as JSON. */
    @Lob
    @Column(nullable = false)
    private String content;

    @Column(nullable = false)
    private String prevHash;

    @Column(nullable = false)
    private String contentHash;

    @Column(nullable = false)
    private Instant createdAt = Instant.now();

    protected EvidenceRecord() {}

    public EvidenceRecord(UUID riskEventId, String content, String prevHash, String contentHash) {
        this.riskEventId = riskEventId;
        this.content = content;
        this.prevHash = prevHash;
        this.contentHash = contentHash;
    }

    public UUID getId() { return id; }
    public UUID getRiskEventId() { return riskEventId; }
    public String getContent() { return content; }
    public String getPrevHash() { return prevHash; }
    public String getContentHash() { return contentHash; }
    public Instant getCreatedAt() { return createdAt; }
}
