package com.maestro.fuelorder.dispense;

import com.maestro.fuelorder.auth.Access;
import com.maestro.fuelorder.auth.AuthService;
import com.maestro.fuelorder.order.FuelOrder;
import com.maestro.fuelorder.order.FuelOrderRepository;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.validation.constraints.*;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.server.ResponseStatusException;

import java.math.BigDecimal;
import java.time.Instant;
import java.util.List;
import java.util.Set;
import java.util.UUID;
import java.util.stream.Collectors;

@RestController
@RequestMapping("/api/v1/dispense")
public class DispenseController {

    private final DispenseService service;
    private final FuelTransactionRepository transactions;
    private final FuelOrderRepository orders;
    private final OtpAttemptRepository attempts;

    public DispenseController(DispenseService service, FuelTransactionRepository transactions,
                              FuelOrderRepository orders, OtpAttemptRepository attempts) {
        this.service = service;
        this.transactions = transactions;
        this.orders = orders;
        this.attempts = attempts;
    }

    public record ValidateRequest(@NotBlank @Pattern(regexp = "\\d{6}") String otp,
                                  @NotBlank @Pattern(regexp = "\\d{4}") String driverPin) {}

    public record ValidateResponse(UUID authorizationId, String orderNumber, String driverName,
                                   String vehicleReg, String siteName, String fuelProduct,
                                   BigDecimal maxVolumeLitres, Instant expiresAt) {}

    public record CompleteRequest(
            @NotBlank @Pattern(regexp = "\\d{6}") String otp,
            @NotBlank @Pattern(regexp = "\\d{4}") String driverPin,
            String attendantName,
            @NotNull @DecimalMin("0.1") BigDecimal volumeLitres) {}

    public record Receipt(String receiptNo, String orderNumber, String siteName, String vehicleReg,
                          String driverName, String attendantName, BigDecimal litres, BigDecimal unitPrice,
                          BigDecimal amount, Instant at) {}

    @PostMapping("/validate")
    public ValidateResponse validate(@RequestBody @jakarta.validation.Valid ValidateRequest req,
                                     HttpServletRequest request) {
        AuthService.Session s = Access.session(request);
        Access.requireDispensing(s);
        DispenseService.ValidationResult result = service.validate(req.otp(), req.driverPin(), s.name());
        OtpAuthorization a = result.authorization();
        return new ValidateResponse(a.getId(), result.order().getNumber(), a.getDriverName(),
                a.getVehicleReg(), a.getSiteName(), a.getFuelProduct(),
                a.getMaxVolumeLitres(), a.getExpiresAt());
    }

    @PostMapping("/complete")
    public FuelTransaction complete(@RequestBody @jakarta.validation.Valid CompleteRequest req,
                                    HttpServletRequest request) {
        AuthService.Session s = Access.session(request);
        Access.requireDispensing(s);
        // the attendant is whoever is signed in, never a name typed into the request
        return service.complete(req.otp(), req.driverPin(), s.name(), req.volumeLitres());
    }

    @GetMapping("/transactions")
    public List<FuelTransaction> transactions(HttpServletRequest request) {
        AuthService.Session s = Access.session(request);
        return Access.isCustomer(s)
                ? transactions.forCustomer(s.organization(), org.springframework.data.domain.PageRequest.of(0, 200))
                : transactions.findTop200ByOrderByDispensedAtDesc();
    }

    @GetMapping("/transactions/{id}/receipt")
    public Receipt receipt(@PathVariable UUID id, HttpServletRequest request) {
        AuthService.Session s = Access.session(request);
        FuelTransaction t = transactions.findById(id)
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND, "Transaction not found"));
        FuelOrder o = orders.findById(t.getOrderId()).orElseThrow();
        if (Access.isCustomer(s) && !o.getCustomerName().equals(s.organization())) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Transaction not found");
        }
        return new Receipt("RCPT-" + t.getId().toString().substring(0, 8).toUpperCase(), o.getNumber(),
                t.getSiteName(), t.getVehicleReg(), t.getDriverName(), t.getAttendantName(),
                t.getVolumeLitres(), t.getUnitPrice(), t.getAmount(), t.getDispensedAt());
    }

    /** Recent validation attempts, including failures, for supervisors. */
    @GetMapping("/attempts")
    public List<OtpAttempt> attempts(HttpServletRequest request) {
        Access.requireStaff(Access.session(request));
        return attempts.findTop100ByOrderByAtDesc();
    }
}
