package com.maestro.fuelorder.order;

import com.maestro.fuelorder.dispense.OtpAuthorization;
import com.maestro.fuelorder.dispense.OtpAuthorizationRepository;
import com.maestro.fuelorder.notify.NotificationService;
import com.maestro.fuelorder.org.CreditService;
import com.maestro.fuelorder.pricing.PricingService;
import com.maestro.fuelorder.registry.DriverRepository;
import com.maestro.fuelorder.registry.Vehicle;
import com.maestro.fuelorder.registry.VehicleRepository;
import com.maestro.fuelorder.site.Site;
import com.maestro.fuelorder.site.SiteCatalog;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.server.ResponseStatusException;

import java.math.BigDecimal;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.HashSet;
import java.util.HexFormat;
import java.util.List;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicLong;

@Service
public class OrderService {

    /** The supplier that owns every demo station; its policy governs approvals. */
    public static final String SUPPLIER_ORG = "Maestro Fuel Depots";
    public static final String SYSTEM = "system";

    private final FuelOrderRepository orders;
    private final OtpAuthorizationRepository authorizations;
    private final VehicleRepository vehicles;
    private final DriverRepository drivers;
    private final OrderStatusHistoryRepository history;
    private final ApprovalPolicyRepository policies;
    private final CreditService credit;
    private final NotificationService notifications;
    private final PricingService pricing;
    private final SiteCatalog siteCatalog;
    private final SecureRandom random = new SecureRandom();
    private final AtomicLong orderSeq = new AtomicLong(1000);
    private final AtomicLong bulkSeq = new AtomicLong(5000);

    public OrderService(FuelOrderRepository orders, OtpAuthorizationRepository authorizations,
                        VehicleRepository vehicles, DriverRepository drivers,
                        OrderStatusHistoryRepository history, ApprovalPolicyRepository policies,
                        CreditService credit, NotificationService notifications, PricingService pricing,
                        SiteCatalog siteCatalog) {
        this.orders = orders;
        this.authorizations = authorizations;
        this.vehicles = vehicles;
        this.drivers = drivers;
        this.history = history;
        this.policies = policies;
        this.credit = credit;
        this.notifications = notifications;
        this.pricing = pricing;
        this.siteCatalog = siteCatalog;
    }

    public record OtpIssued(FuelOrder order, String otpPlaintext, Instant expiresAt) {}

    public record Allocation(String vehicleReg, String driverName, BigDecimal quantityLitres) {}

    /**
     * Creates one customer order. When {@code enforceFleet} is set (customers), the vehicle and driver must
     * be registered to that organization, the fuel must suit the vehicle and the volume must fit its tank.
     */
    @Transactional
    public FuelOrder create(String customer, boolean enforceFleet, String actor, String siteCode, String product,
                            BigDecimal qty, String vehicleReg, String driverName, String costCentre,
                            String destination) {
        FuelOrder o = createOne(customer, enforceFleet, actor, siteCode, product, qty, vehicleReg, driverName,
                costCentre, destination, null);
        autoApproveIfEligible(o);
        return o;
    }

    /** One bulk order becomes one allocation (order) per vehicle, tied together by a bulk reference. */
    @Transactional
    public List<FuelOrder> createBulk(String customer, boolean enforceFleet, String actor, String siteCode,
                                      String product, String costCentre, String destination,
                                      List<Allocation> items) {
        Set<String> seen = new HashSet<>();
        for (Allocation a : items) {
            if (!seen.add(a.vehicleReg().trim().toUpperCase())) {
                throw bad("Vehicle " + a.vehicleReg() + " appears more than once in this bulk order");
            }
        }
        String bulkRef = "BULK-" + bulkSeq.incrementAndGet();
        List<FuelOrder> made = items.stream()
                .map(a -> createOne(customer, enforceFleet, actor, siteCode, product, a.quantityLitres(),
                        a.vehicleReg(), a.driverName(), costCentre, destination, bulkRef))
                .toList();
        made.forEach(this::autoApproveIfEligible);
        return made;
    }

    /** The supplier proposes fuel to a customer; nothing is authorized until the customer accepts. */
    @Transactional
    public FuelOrder proposeToCustomer(String customer, String actor, String siteCode, String product,
                                       BigDecimal qty, String vehicleReg, String driverName,
                                       String costCentre, String destination) {
        FuelOrder o = createOne(customer, true, actor, siteCode, product, qty, vehicleReg, driverName,
                costCentre, destination, null);
        FuelOrder.Status before = o.getStatus();
        o.proposedBySupplier();
        log(o, before, actor, "Proposed to " + customer + " by the supplier");
        notifications.inApp(customer, "ORDER_STATUS", "%s proposed %s: %s L for %s. Accept it to release the fuel code."
                .formatted(SUPPLIER_ORG, o.getNumber(), o.getQuantityLitres().stripTrailingZeros().toPlainString(),
                        o.getVehicleReg()), o.getNumber());
        return o;
    }

    private FuelOrder createOne(String customer, boolean enforceFleet, String actor, String siteCode, String product,
                                BigDecimal qty, String vehicleReg, String driverName, String costCentre,
                                String destination, String bulkRef) {
        Site site = siteCatalog.find(siteCode)
                .orElseThrow(() -> bad("Unknown station site: " + siteCode));
        if (enforceFleet) {
            checkFleet(customer, product, qty, vehicleReg, driverName);
        }
        PricingService.Price price = pricing.resolve(customer, product, site.getCode(), qty, null);
        String number = "FO-" + orderSeq.incrementAndGet();
        FuelOrder o = new FuelOrder(number, customer, site.getName(), site.getCode(), product, qty,
                vehicleReg.trim(), driverName.trim(), costCentre, blankToNull(destination), bulkRef,
                price.unitPrice());
        o.priceFrom(price.source());
        o = orders.save(o);
        log(o, null, actor, "Order placed");
        return o;
    }

    /** Checks one vehicle/driver/litres combination against the customer's fleet without creating anything. */
    public void validateAllocation(String customer, String product, BigDecimal qty, String vehicleReg,
                                   String driverName) {
        checkFleet(customer, product, qty, vehicleReg, driverName);
    }

    private void checkFleet(String customer, String product, BigDecimal qty, String vehicleReg, String driverName) {
        Vehicle vehicle = vehicles
                .findByOrganizationAndRegistrationIgnoreCaseAndActiveTrue(customer, vehicleReg.trim())
                .orElseThrow(() -> bad("Vehicle " + vehicleReg + " is not registered to your fleet"));
        drivers.findByOrganizationAndNameIgnoreCaseAndActiveTrue(customer, driverName.trim())
                .filter(d -> {
                    if (d.isAccessSuspended()) {
                        throw bad("Driver " + d.getName() + "'s fuel access is suspended: " + d.getSuspendedReason());
                    }
                    return true;
                })
                .orElseThrow(() -> bad("Driver " + driverName + " is not registered to your fleet"));
        boolean petrolProduct = product.startsWith("ULP");
        if (petrolProduct != "PETROL".equals(vehicle.getFuelType())) {
            throw bad(vehicle.getRegistration() + " takes " + vehicle.getFuelType().toLowerCase()
                    + ", not " + (petrolProduct ? "petrol" : "diesel"));
        }
        if (qty.compareTo(vehicle.getTankCapacityLitres()) > 0) {
            throw bad("%s L exceeds the %s L tank of %s".formatted(
                    qty.stripTrailingZeros().toPlainString(),
                    vehicle.getTankCapacityLitres().stripTrailingZeros().toPlainString(),
                    vehicle.getRegistration()));
        }
    }

    public ApprovalPolicy policy() {
        return policies.findByOrganization(SUPPLIER_ORG)
                .orElseGet(() -> policies.save(new ApprovalPolicy(SUPPLIER_ORG, BigDecimal.ZERO, true)));
    }

    @Transactional
    public ApprovalPolicy updatePolicy(BigDecimal autoApproveMaxLitres, boolean enforceCreditLimit) {
        ApprovalPolicy p = policy();
        p.update(autoApproveMaxLitres, enforceCreditLimit);
        return policies.save(p);
    }

    /** Small orders within credit skip manual review; anything else stays pending for the supplier. */
    private void autoApproveIfEligible(FuelOrder o) {
        ApprovalPolicy p = policy();
        if (p.getAutoApproveMaxLitres().signum() <= 0
                || o.getQuantityLitres().compareTo(p.getAutoApproveMaxLitres()) > 0) {
            return;
        }
        try {
            issue(o, SYSTEM, "Auto-approved: within the " + p.getAutoApproveMaxLitres().stripTrailingZeros().toPlainString()
                    + " L auto-approval limit");
        } catch (ResponseStatusException e) {
            log(o, o.getStatus(), SYSTEM, "Auto-approval skipped: " + e.getReason());
        }
    }

    /** Supplier review: approving issues the OTP. Rejected orders never reach this path. */
    @Transactional
    public OtpIssued approve(UUID orderId, String actor) {
        return issue(get(orderId), actor, "Approved by supplier");
    }

    /** The customer accepts a supplier proposal, which releases the fuel code. */
    @Transactional
    public OtpIssued accept(UUID orderId, String customer, String actor) {
        FuelOrder o = ownedBy(orderId, customer);
        FuelOrder.Status before = o.getStatus();
        o.acceptByCustomer();
        log(o, before, actor, "Accepted by customer");
        return issue(o, actor, "Issued after customer acceptance");
    }

    private OtpIssued issue(FuelOrder order, String actor, String reason) {
        if (policy().isEnforceCreditLimit()) {
            credit.assertWithinLimit(order.getCustomerName(),
                    order.getQuantityLitres().multiply(order.getUnitPriceSnapshot()));
        }
        FuelOrder.Status before = order.getStatus();
        order.approve();
        log(order, before, actor, reason);
        String otp = "%06d".formatted(random.nextInt(1_000_000));
        Instant expiresAt = Instant.now().plus(24, ChronoUnit.HOURS);
        authorizations.save(new OtpAuthorization(order.getId(), sha256(otp),
                order.getQuantityLitres(), order.getVehicleReg(), order.getDriverName(),
                order.getSiteName(), order.getFuelProduct(), expiresAt));
        before = order.getStatus();
        order.markAuthorized();
        log(order, before, SYSTEM, "OTP issued, valid 24 hours");
        drivers.findByOrganizationAndNameIgnoreCaseAndActiveTrue(order.getCustomerName(), order.getDriverName())
                .ifPresent(d -> notifications.sms(order.getCustomerName(), d.getName(), d.getPhone(), "OTP",
                        "Maestro: fuel code %s for %s, up to %s L at %s. Valid 24 hours. Bring your PIN."
                                .formatted(otp, order.getVehicleReg(),
                                        order.getQuantityLitres().stripTrailingZeros().toPlainString(),
                                        order.getSiteName()), order.getNumber()));
        notifications.inApp(order.getCustomerName(), "ORDER_STATUS",
                order.getNumber() + " approved; the driver has been sent the fuel code.", order.getNumber());
        return new OtpIssued(order, otp, expiresAt);
    }

    @Transactional
    public FuelOrder reject(UUID orderId, String reason, String actor) {
        FuelOrder order = get(orderId);
        FuelOrder.Status before = order.getStatus();
        order.reject(reason);
        log(order, before, actor, reason);
        notifications.inApp(order.getCustomerName(), "ORDER_STATUS",
                order.getNumber() + " was rejected: " + reason, order.getNumber());
        return order;
    }

    @Transactional
    public FuelOrder decline(UUID orderId, String customer, String reason, String actor) {
        FuelOrder order = ownedBy(orderId, customer);
        FuelOrder.Status before = order.getStatus();
        order.declineByCustomer(reason);
        log(order, before, actor, reason);
        return order;
    }

    public List<OrderStatusHistory> historyOf(UUID orderId) {
        return history.findByOrderIdOrderByAtAsc(orderId);
    }

    /** Withdraws an order that has not been fuelled. An authorized order has its code revoked at the same time. */
    @Transactional
    public FuelOrder cancel(UUID orderId, String reason, String actor) {
        FuelOrder order = get(orderId);
        FuelOrder.Status before = order.getStatus();
        if (before == FuelOrder.Status.AUTHORIZED) {
            authorizations.findByOrderId(orderId).ifPresent(a -> {
                a.revoke();
                authorizations.save(a);
            });
        }
        order.cancel(reason);
        log(order, before, actor, "Cancelled: " + reason);
        notifications.inApp(order.getCustomerName(), "ORDER_STATUS",
                order.getNumber() + " was cancelled: " + reason, order.getNumber());
        return order;
    }

    /** Changes the litres, destination or cost centre of an order that is still awaiting approval, and reprices it. */
    @Transactional
    public FuelOrder amend(UUID orderId, BigDecimal qty, String destination, String costCentre, String actor) {
        FuelOrder order = get(orderId);
        BigDecimal newQty = qty == null ? order.getQuantityLitres() : qty;
        if (qty != null) {
            // the same fleet rules as when the order was placed: the new volume must still fit the tank
            validateAllocation(order.getCustomerName(), order.getFuelProduct(), newQty, order.getVehicleReg(), order.getDriverName());
        }
        PricingService.Price price = pricing.resolve(order.getCustomerName(), order.getFuelProduct(),
                order.getSiteCode(), newQty, null);
        BigDecimal oldQty = order.getQuantityLitres();
        String note = oldQty.compareTo(newQty) == 0
                ? "Amended: destination or cost centre changed"
                : "Amended: %s L -> %s L".formatted(oldQty.stripTrailingZeros().toPlainString(),
                        newQty.stripTrailingZeros().toPlainString());
        FuelOrder.Status status = order.getStatus();
        order.amend(newQty, price.unitPrice(), price.source(),
                destination == null ? order.getDestination() : blankToNull(destination),
                costCentre == null ? order.getCostCentre() : blankToNull(costCentre));
        log(order, status, actor, note);
        notifications.inApp(order.getCustomerName(), "ORDER_STATUS",
                order.getNumber() + " was amended by the supplier (" + note.substring("Amended: ".length()) + ").",
                order.getNumber());
        return order;
    }

    /** Takes a live code out of use without cancelling the order, e.g. when a driver reports it lost. */
    @Transactional
    public OtpAuthorization revokeOtp(UUID authorizationId, String reason, String actor) {
        OtpAuthorization a = authorization(authorizationId);
        if (a.getStatus() != OtpAuthorization.Status.ACTIVE) {
            throw new IllegalStateException("Only an active code can be revoked (this one is " + a.getStatus() + ")");
        }
        a.revoke();
        FuelOrder order = get(a.getOrderId());
        log(order, order.getStatus(), actor, "OTP revoked: " + reason);
        notifications.inApp(order.getCustomerName(), "ORDER_STATUS",
                "The fuel code for " + order.getNumber() + " was revoked: " + reason + ".", order.getNumber());
        return authorizations.save(a);
    }

    /** Issues a new code for an authorized order. The old code, active or not, stops working. */
    @Transactional
    public OtpIssued regenerateOtp(UUID authorizationId, String reason, String actor) {
        OtpAuthorization a = authorization(authorizationId);
        FuelOrder order = get(a.getOrderId());
        if (order.getStatus() != FuelOrder.Status.AUTHORIZED) {
            throw new IllegalStateException("A new code can only be issued for an authorized order (this one is "
                    + order.getStatus() + ")");
        }
        String otp = "%06d".formatted(random.nextInt(1_000_000));
        Instant expiresAt = Instant.now().plus(24, ChronoUnit.HOURS);
        a.reissue(sha256(otp), expiresAt);
        authorizations.save(a);
        log(order, order.getStatus(), actor, "OTP regenerated: " + reason);
        drivers.findByOrganizationAndNameIgnoreCaseAndActiveTrue(order.getCustomerName(), order.getDriverName())
                .ifPresent(d -> notifications.sms(order.getCustomerName(), d.getName(), d.getPhone(), "OTP",
                        "Maestro: new fuel code %s for %s, up to %s L at %s. Valid 24 hours. Bring your PIN."
                                .formatted(otp, order.getVehicleReg(),
                                        order.getQuantityLitres().stripTrailingZeros().toPlainString(),
                                        order.getSiteName()), order.getNumber()));
        notifications.inApp(order.getCustomerName(), "ORDER_STATUS",
                "A new fuel code was issued for " + order.getNumber() + ".", order.getNumber());
        return new OtpIssued(order, otp, expiresAt);
    }

    private OtpAuthorization authorization(UUID id) {
        return authorizations.findById(id)
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND, "Authorization not found"));
    }

    public FuelOrder get(UUID id) {
        return orders.findById(id)
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND, "Order not found"));
    }

    private FuelOrder ownedBy(UUID id, String customer) {
        FuelOrder o = get(id);
        if (!o.getCustomerName().equals(customer)) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Order not found");
        }
        return o;
    }

    private void log(FuelOrder o, FuelOrder.Status from, String actor, String reason) {
        history.save(new OrderStatusHistory(o.getId(), from == null ? null : from.name(),
                o.getStatus().name(), actor, reason));
    }

    private static ResponseStatusException bad(String message) {
        return new ResponseStatusException(HttpStatus.BAD_REQUEST, message);
    }

    private static String blankToNull(String s) {
        return s == null || s.isBlank() ? null : s.trim();
    }

    public static String sha256(String value) {
        try {
            MessageDigest md = MessageDigest.getInstance("SHA-256");
            return HexFormat.of().formatHex(md.digest(value.getBytes(StandardCharsets.UTF_8)));
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }
}
