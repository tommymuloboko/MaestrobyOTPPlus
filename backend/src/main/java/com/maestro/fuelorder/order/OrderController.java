package com.maestro.fuelorder.order;

import com.maestro.fuelorder.auth.Access;
import com.maestro.fuelorder.auth.AuthService;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.validation.constraints.*;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.server.ResponseStatusException;

import java.math.BigDecimal;
import java.time.Instant;
import java.util.List;
import java.util.UUID;

@RestController
@RequestMapping("/api/v1/orders")
public class OrderController {

    private final OrderService service;
    private final FuelOrderRepository orders;
    private final boolean exposeOtp;

    public OrderController(OrderService service, FuelOrderRepository orders,
                           @Value("${maestro.demo.expose-otp:true}") boolean exposeOtp) {
        this.service = service;
        this.orders = orders;
        this.exposeOtp = exposeOtp;
    }

    public record CreateOrderRequest(
            String customerName,
            @NotBlank String siteCode,
            @NotBlank String fuelProduct,
            @NotNull @DecimalMin("1.0") BigDecimal quantityLitres,
            @NotBlank String vehicleReg,
            @NotBlank String driverName,
            String costCentre,
            String destination) {}

    public record BulkItem(
            @NotBlank String vehicleReg,
            @NotBlank String driverName,
            @NotNull @DecimalMin("1.0") BigDecimal quantityLitres) {}

    public record BulkOrderRequest(
            String customerName,
            @NotBlank String siteCode,
            @NotBlank String fuelProduct,
            String costCentre,
            String destination,
            @NotEmpty @jakarta.validation.Valid List<BulkItem> items) {}

    public record RejectRequest(@NotBlank String reason) {}

    public record PolicyRequest(@NotNull @DecimalMin("0") BigDecimal autoApproveMaxLitres, boolean enforceCreditLimit) {}

    /** The OTP is only in this response while the demo flag is on; normally it goes to the driver by SMS. */
    public record OtpResponse(UUID orderId, String orderNumber, String otp, Instant expiresAt, String note) {}

    /** Most recent 200 orders; customers only ever get their own. */
    @GetMapping
    public List<FuelOrder> list(HttpServletRequest request) {
        AuthService.Session s = Access.session(request);
        return Access.isCustomer(s) ? orders.findTop200ByCustomerNameOrderByCreatedAtDesc(s.organization())
                : orders.findTop200ByOrderByCreatedAtDesc();
    }

    @PostMapping
    @ResponseStatus(HttpStatus.CREATED)
    public FuelOrder create(@RequestBody @jakarta.validation.Valid CreateOrderRequest req, HttpServletRequest request) {
        AuthService.Session s = Access.session(request);
        return service.create(customerFor(s, req.customerName()), Access.isCustomer(s), s.name(), req.siteCode(),
                req.fuelProduct(), req.quantityLitres(), req.vehicleReg(), req.driverName(),
                req.costCentre(), req.destination());
    }

    @PostMapping("/bulk")
    @ResponseStatus(HttpStatus.CREATED)
    public List<FuelOrder> createBulk(@RequestBody @jakarta.validation.Valid BulkOrderRequest req,
                                      HttpServletRequest request) {
        AuthService.Session s = Access.session(request);
        List<OrderService.Allocation> items = req.items().stream()
                .map(i -> new OrderService.Allocation(i.vehicleReg(), i.driverName(), i.quantityLitres()))
                .toList();
        return service.createBulk(customerFor(s, req.customerName()), Access.isCustomer(s), s.name(), req.siteCode(),
                req.fuelProduct(), req.costCentre(), req.destination(), items);
    }

    /** Supplier-initiated order: the depot proposes fuel; the customer must accept before a code is issued. */
    @PostMapping("/supplier")
    @ResponseStatus(HttpStatus.CREATED)
    public FuelOrder propose(@RequestBody @jakarta.validation.Valid CreateOrderRequest req, HttpServletRequest request) {
        AuthService.Session s = Access.session(request);
        Access.requireSupplier(s);
        if (req.customerName() == null || req.customerName().isBlank()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "customerName is required");
        }
        return service.proposeToCustomer(req.customerName(), s.name(), req.siteCode(), req.fuelProduct(),
                req.quantityLitres(), req.vehicleReg(), req.driverName(), req.costCentre(), req.destination());
    }

    @PostMapping("/{id}/accept")
    public FuelOrder accept(@PathVariable UUID id, HttpServletRequest request) {
        AuthService.Session s = Access.session(request);
        Access.requireCustomer(s);
        return service.accept(id, s.organization(), s.name()).order();
    }

    @PostMapping("/{id}/decline")
    public FuelOrder decline(@PathVariable UUID id, @RequestBody @jakarta.validation.Valid RejectRequest req,
                             HttpServletRequest request) {
        AuthService.Session s = Access.session(request);
        Access.requireCustomer(s);
        return service.decline(id, s.organization(), req.reason(), s.name());
    }

    @PostMapping("/{id}/approve")
    public OtpResponse approve(@PathVariable UUID id, HttpServletRequest request) {
        AuthService.Session s = Access.session(request);
        Access.requireSupplier(s);
        OrderService.OtpIssued issued = service.approve(id, s.name());
        return new OtpResponse(issued.order().getId(), issued.order().getNumber(),
                exposeOtp ? issued.otpPlaintext() : null, issued.expiresAt(),
                exposeOtp ? "Demo only: in production the OTP is sent to the driver by SMS"
                        : "The OTP was sent to the driver by SMS");
    }

    @PostMapping("/{id}/reject")
    public FuelOrder reject(@PathVariable UUID id, @RequestBody @jakarta.validation.Valid RejectRequest req,
                            HttpServletRequest request) {
        AuthService.Session s = Access.session(request);
        Access.requireSupplier(s);
        return service.reject(id, req.reason(), s.name());
    }

    /** Withdraws an order before any fuel is drawn; a live fuel code is revoked with it. */
    @PostMapping("/{id}/cancel")
    public FuelOrder cancel(@PathVariable UUID id, @RequestBody @jakarta.validation.Valid RejectRequest req,
                            HttpServletRequest request) {
        AuthService.Session s = Access.session(request);
        Access.requireSupplier(s);
        return service.cancel(id, req.reason(), s.name());
    }

    public record AmendRequest(@jakarta.validation.constraints.DecimalMin("1.0") BigDecimal quantityLitres,
                               @jakarta.validation.constraints.Size(max = 200) String destination,
                               @jakarta.validation.constraints.Size(max = 60) String costCentre) {}

    @PatchMapping("/{id}")
    public FuelOrder amend(@PathVariable UUID id, @RequestBody @jakarta.validation.Valid AmendRequest req,
                           HttpServletRequest request) {
        AuthService.Session s = Access.session(request);
        Access.requireSupplier(s);
        if (req.quantityLitres() == null && req.destination() == null && req.costCentre() == null) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Nothing to amend");
        }
        return service.amend(id, req.quantityLitres(), req.destination(), req.costCentre(), s.name());
    }

    @GetMapping("/{id}/history")
    public List<OrderStatusHistory> history(@PathVariable UUID id, HttpServletRequest request) {
        AuthService.Session s = Access.session(request);
        FuelOrder o = service.get(id);
        if (Access.isCustomer(s) && !o.getCustomerName().equals(s.organization())) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Order not found");
        }
        return service.historyOf(id);
    }

    @GetMapping("/policy")
    public ApprovalPolicy policy(HttpServletRequest request) {
        Access.requireStaff(Access.session(request));
        return service.policy();
    }

    @PutMapping("/policy")
    public ApprovalPolicy updatePolicy(@RequestBody @jakarta.validation.Valid PolicyRequest req,
                                       HttpServletRequest request) {
        Access.requireSupplier(Access.session(request));
        return service.updatePolicy(req.autoApproveMaxLitres(), req.enforceCreditLimit());
    }

    /** A customer can only order on behalf of their own organization. */
    private static String customerFor(AuthService.Session s, String requested) {
        if (Access.isCustomer(s)) {
            return s.organization();
        }
        if (requested == null || requested.isBlank()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "customerName is required");
        }
        return requested;
    }
}
