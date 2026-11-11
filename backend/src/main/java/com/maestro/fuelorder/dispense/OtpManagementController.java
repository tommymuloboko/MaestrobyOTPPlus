package com.maestro.fuelorder.dispense;

import com.maestro.fuelorder.auth.Access;
import com.maestro.fuelorder.auth.AuthService;
import com.maestro.fuelorder.order.FuelOrder;
import com.maestro.fuelorder.order.FuelOrderRepository;
import com.maestro.fuelorder.order.OrderController;
import com.maestro.fuelorder.order.OrderService;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.math.BigDecimal;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.function.Function;
import java.util.stream.Collectors;

/**
 * OTP management for the OMC: watch every fuel code, revoke a live one, or issue a replacement.
 * The code itself is never listed: only its hash is stored, and a replacement is shown once (demo) or texted.
 */
@RestController
@RequestMapping("/api/v1/otp")
public class OtpManagementController {

    /** {@code status} is the effective one: an active code past its expiry shows as EXPIRED. */
    public record OtpView(UUID id, UUID orderId, String orderNumber, String customer, String vehicleReg,
                          String driverName, String siteName, String fuelProduct, BigDecimal maxVolumeLitres,
                          String status, Instant expiresAt, Instant redeemedAt) {}

    public record ReasonRequest(@NotBlank @Size(max = 200) String reason) {}

    private final OtpAuthorizationRepository authorizations;
    private final FuelOrderRepository orders;
    private final OrderService service;
    private final boolean exposeOtp;

    public OtpManagementController(OtpAuthorizationRepository authorizations, FuelOrderRepository orders,
                                   OrderService service, @Value("${maestro.demo.expose-otp:true}") boolean exposeOtp) {
        this.authorizations = authorizations;
        this.orders = orders;
        this.service = service;
        this.exposeOtp = exposeOtp;
    }

    @GetMapping
    public List<OtpView> list(HttpServletRequest request) {
        Access.requireSupplier(Access.session(request));
        List<OtpAuthorization> recent = authorizations.findTop200ByOrderByExpiresAtDesc();
        Map<UUID, FuelOrder> byId = orders.findAllById(recent.stream().map(OtpAuthorization::getOrderId).toList()).stream()
                .collect(Collectors.toMap(FuelOrder::getId, Function.identity()));
        Instant now = Instant.now();
        return recent.stream().map(a -> {
            FuelOrder o = byId.get(a.getOrderId());
            String status = a.getStatus() == OtpAuthorization.Status.ACTIVE && a.isExpired(now) ? "EXPIRED" : a.getStatus().name();
            return new OtpView(a.getId(), a.getOrderId(), o == null ? "—" : o.getNumber(), o == null ? "—" : o.getCustomerName(),
                    a.getVehicleReg(), a.getDriverName(), a.getSiteName(), a.getFuelProduct(), a.getMaxVolumeLitres(),
                    status, a.getExpiresAt(), a.getRedeemedAt());
        }).toList();
    }

    @PostMapping("/{id}/revoke")
    public OtpView revoke(@PathVariable UUID id, @RequestBody @Valid ReasonRequest req, HttpServletRequest request) {
        AuthService.Session s = Access.session(request);
        Access.requireSupplier(s);
        OtpAuthorization a = service.revokeOtp(id, req.reason().trim(), s.name());
        return view(a);
    }

    @PostMapping("/{id}/regenerate")
    public OrderController.OtpResponse regenerate(@PathVariable UUID id, @RequestBody @Valid ReasonRequest req,
                                                  HttpServletRequest request) {
        AuthService.Session s = Access.session(request);
        Access.requireSupplier(s);
        OrderService.OtpIssued issued = service.regenerateOtp(id, req.reason().trim(), s.name());
        return new OrderController.OtpResponse(issued.order().getId(), issued.order().getNumber(),
                exposeOtp ? issued.otpPlaintext() : null, issued.expiresAt(),
                exposeOtp ? "Demo only: in production the new code is sent to the driver by SMS"
                        : "The new code was sent to the driver by SMS");
    }

    private OtpView view(OtpAuthorization a) {
        FuelOrder o = orders.findById(a.getOrderId()).orElse(null);
        return new OtpView(a.getId(), a.getOrderId(), o == null ? "—" : o.getNumber(), o == null ? "—" : o.getCustomerName(),
                a.getVehicleReg(), a.getDriverName(), a.getSiteName(), a.getFuelProduct(), a.getMaxVolumeLitres(),
                a.getStatus().name(), a.getExpiresAt(), a.getRedeemedAt());
    }
}
