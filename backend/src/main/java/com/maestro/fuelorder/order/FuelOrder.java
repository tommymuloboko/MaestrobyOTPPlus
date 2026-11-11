package com.maestro.fuelorder.order;

import jakarta.persistence.*;
import java.math.BigDecimal;
import java.time.Instant;
import java.util.UUID;

@Entity
@Table(name = "fuel_orders")
public class FuelOrder {

    public enum Status { DRAFT, PENDING_CUSTOMER_APPROVAL, PENDING_APPROVAL, APPROVED, AUTHORIZED, FULFILLED, REJECTED, CANCELLED, EXPIRED }

    @Id
    private UUID id = UUID.randomUUID();

    @Column(unique = true, nullable = false)
    private String number;

    @Column(nullable = false)
    private String customerName;

    @Column(nullable = false)
    private String siteName;

    @Column(nullable = false)
    private String fuelProduct;

    @Column(nullable = false)
    private BigDecimal quantityLitres;

    @Column(nullable = false)
    private String vehicleReg;

    @Column(nullable = false)
    private String driverName;

    private String costCentre;

    private String siteCode;

    private String destination;

    /** Shared by every allocation created from one bulk order. */
    private String bulkRef;

    /** CUSTOMER (the fleet asked for fuel) or SUPPLIER (the depot proposed a delivery). */
    @Column(nullable = false)
    private String initiatedBy = "CUSTOMER";

    /** How the price was resolved, e.g. "contract rule 3f2a..." or "list price". */
    private String priceSource;

    @Column(nullable = false)
    private BigDecimal unitPriceSnapshot;

    @Enumerated(EnumType.STRING)
    @Column(nullable = false)
    private Status status = Status.PENDING_APPROVAL;

    private String rejectionReason;

    @Column(nullable = false)
    private Instant createdAt = Instant.now();

    protected FuelOrder() {}

    public FuelOrder(String number, String customerName, String siteName, String siteCode,
                     String fuelProduct, BigDecimal quantityLitres, String vehicleReg,
                     String driverName, String costCentre, String destination, String bulkRef,
                     BigDecimal unitPriceSnapshot) {
        this.number = number;
        this.customerName = customerName;
        this.siteName = siteName;
        this.siteCode = siteCode;
        this.fuelProduct = fuelProduct;
        this.quantityLitres = quantityLitres;
        this.vehicleReg = vehicleReg;
        this.driverName = driverName;
        this.costCentre = costCentre;
        this.destination = destination;
        this.bulkRef = bulkRef;
        this.unitPriceSnapshot = unitPriceSnapshot;
    }

    public UUID getId() { return id; }
    public String getNumber() { return number; }
    public String getCustomerName() { return customerName; }
    public String getSiteName() { return siteName; }
    public String getSiteCode() { return siteCode; }
    public String getDestination() { return destination; }
    public String getBulkRef() { return bulkRef; }
    public String getInitiatedBy() { return initiatedBy; }
    public String getPriceSource() { return priceSource; }

    public void proposedBySupplier() {
        this.initiatedBy = "SUPPLIER";
        this.status = Status.PENDING_CUSTOMER_APPROVAL;
    }

    public void priceFrom(String source) { this.priceSource = source; }

    /** The customer accepted a supplier-proposed order; it now only needs issuing. */
    public void acceptByCustomer() {
        requireStatus(Status.PENDING_CUSTOMER_APPROVAL, "accept");
        this.status = Status.PENDING_APPROVAL;
    }

    public void declineByCustomer(String reason) {
        requireStatus(Status.PENDING_CUSTOMER_APPROVAL, "decline");
        this.status = Status.REJECTED;
        this.rejectionReason = reason;
    }
    public String getFuelProduct() { return fuelProduct; }
    public BigDecimal getQuantityLitres() { return quantityLitres; }
    public String getVehicleReg() { return vehicleReg; }
    public String getDriverName() { return driverName; }
    public String getCostCentre() { return costCentre; }
    public BigDecimal getUnitPriceSnapshot() { return unitPriceSnapshot; }
    public Status getStatus() { return status; }
    public String getRejectionReason() { return rejectionReason; }
    public Instant getCreatedAt() { return createdAt; }

    public void approve() {
        requireStatus(Status.PENDING_APPROVAL, "approve");
        this.status = Status.APPROVED;
    }

    public void reject(String reason) {
        requireStatus(Status.PENDING_APPROVAL, "reject");
        this.status = Status.REJECTED;
        this.rejectionReason = reason;
    }

    public void markAuthorized() {
        requireStatus(Status.APPROVED, "authorize");
        this.status = Status.AUTHORIZED;
    }

    public void markFulfilled() {
        requireStatus(Status.AUTHORIZED, "fulfil");
        this.status = Status.FULFILLED;
    }

    /** Nothing has been dispensed in any of these states, so the order can still be withdrawn. */
    public void cancel(String reason) {
        if (status != Status.PENDING_CUSTOMER_APPROVAL && status != Status.PENDING_APPROVAL && status != Status.AUTHORIZED) {
            throw new IllegalStateException("Cannot cancel order " + number + " in status " + status);
        }
        this.status = Status.CANCELLED;
        this.rejectionReason = reason;
    }

    /** Only an order that has not been authorized can change; once a code is out, cancel and re-order instead. */
    public void amend(BigDecimal quantityLitres, BigDecimal unitPrice, String priceSource, String destination, String costCentre) {
        if (status != Status.PENDING_CUSTOMER_APPROVAL && status != Status.PENDING_APPROVAL) {
            throw new IllegalStateException("Cannot amend order " + number + " in status " + status
                    + ". Only orders that are still awaiting approval can be amended");
        }
        this.quantityLitres = quantityLitres;
        this.unitPriceSnapshot = unitPrice;
        this.priceSource = priceSource;
        this.destination = destination;
        this.costCentre = costCentre;
    }

    private void requireStatus(Status expected, String action) {
        if (this.status != expected) {
            throw new IllegalStateException(
                "Cannot " + action + " order " + number + " in status " + status);
        }
    }
}
