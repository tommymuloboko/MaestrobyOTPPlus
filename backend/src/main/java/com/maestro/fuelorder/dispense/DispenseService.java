package com.maestro.fuelorder.dispense;

import com.maestro.fuelorder.finance.FinanceService;
import com.maestro.fuelorder.order.FuelOrder;
import com.maestro.fuelorder.order.FuelOrderRepository;
import com.maestro.fuelorder.order.OrderService;
import com.maestro.fuelorder.registry.Driver;
import com.maestro.fuelorder.registry.DriverRepository;
import com.maestro.fuelorder.sentinel.RiskEvent;
import com.maestro.fuelorder.sentinel.SentinelService;
import com.maestro.fuelorder.stock.StockMovement;
import com.maestro.fuelorder.stock.StockService;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.server.ResponseStatusException;

import java.math.BigDecimal;
import java.time.Duration;
import java.time.Instant;
import java.util.Map;

@Service
public class DispenseService {

    private static final Logger log = LoggerFactory.getLogger(DispenseService.class);
    private static final int MAX_BAD_OTPS = 5;
    private static final int MAX_BAD_PINS = 3;

    private final OtpAuthorizationRepository authorizations;
    private final FuelTransactionRepository transactions;
    private final FuelOrderRepository orders;
    private final DriverRepository drivers;
    private final OtpAttemptLog attemptLog;
    private final OtpAttemptRepository attempts;
    private final StockService stock;
    private final FinanceService finance;
    private final SentinelService sentinel;

    public DispenseService(OtpAuthorizationRepository authorizations, FuelTransactionRepository transactions,
                           FuelOrderRepository orders, DriverRepository drivers, OtpAttemptLog attemptLog,
                           OtpAttemptRepository attempts, StockService stock, FinanceService finance,
                           SentinelService sentinel) {
        this.authorizations = authorizations;
        this.transactions = transactions;
        this.orders = orders;
        this.drivers = drivers;
        this.attemptLog = attemptLog;
        this.attempts = attempts;
        this.stock = stock;
        this.finance = finance;
        this.sentinel = sentinel;
    }

    public record ValidationResult(OtpAuthorization authorization, FuelOrder order) {}

    /** Attendant validates the OTP and the driver's PIN. Nothing is redeemed yet. */
    @Transactional(noRollbackFor = ResponseStatusException.class)
    public ValidationResult validate(String otp, String pin, String attendant) {
        ValidationResult r = authorize(otp, pin, attendant);
        attemptLog.record(attendant, OtpAttempt.VALIDATED, r.authorization().getId(), r.order().getId(), "OTP and PIN accepted");
        return r;
    }

    /** Completes the dispense: redeems the OTP (single-use) and records the immutable transaction. */
    @Transactional(noRollbackFor = ResponseStatusException.class)
    public FuelTransaction complete(String otp, String pin, String attendant, BigDecimal volumeLitres) {
        ValidationResult r = authorize(otp, pin, attendant);
        OtpAuthorization auth = r.authorization();
        FuelOrder order = r.order();
        if (volumeLitres.compareTo(auth.getMaxVolumeLitres()) > 0) {
            String msg = "Dispensed volume %s L exceeds authorized limit %s L - the pump stops at the approved limit"
                    .formatted(volumeLitres, auth.getMaxVolumeLitres());
            attemptLog.record(attendant, OtpAttempt.OVER_LIMIT, auth.getId(), order.getId(), msg);
            sentinel.raise("OVER_DISPENSE", RiskEvent.HIGH, order.getCustomerName(), order.getSiteCode(),
                    auth.getVehicleReg(), auth.getDriverName(), attendant, "ORDER", order.getId(),
                    "Attempt to dispense %s L against %s L authorized".formatted(volumeLitres, auth.getMaxVolumeLitres()),
                    "REFUSED", Map.of("orderNumber", order.getNumber(), "attemptedLitres", volumeLitres));
            throw new ResponseStatusException(HttpStatus.CONFLICT, msg);
        }
        auth.redeem(Instant.now());
        order.markFulfilled();
        FuelTransaction tx = transactions.save(new FuelTransaction(auth.getId(), order.getId(),
                auth.getSiteName(), auth.getVehicleReg(), auth.getDriverName(),
                attendant, volumeLitres, order.getUnitPriceSnapshot()));
        stock.record(order.getSiteCode(), order.getFuelProduct(), StockMovement.DISPENSE,
                volumeLitres.negate(), "TRANSACTION", tx.getId());
        finance.postDispense(tx, order.getCustomerName());
        attemptLog.record(attendant, OtpAttempt.COMPLETED, auth.getId(), order.getId(), volumeLitres + " L dispensed");
        try {
            sentinel.onDispense(tx, order);
        } catch (RuntimeException e) {
            // a fraud-check failure must never undo a dispense that already happened at the pump
            log.warn("Sentinel post-dispense check failed: {}", e.getMessage());
        }
        return tx;
    }

    private ValidationResult authorize(String otp, String pin, String attendant) {
        Instant window = Instant.now().minus(Duration.ofMinutes(10));
        if (attempts.countByAttendantAndOutcomeAndAtAfter(attendant, OtpAttempt.INVALID, window) >= MAX_BAD_OTPS) {
            throw new ResponseStatusException(HttpStatus.TOO_MANY_REQUESTS,
                    "Too many wrong codes. This terminal is locked for a few minutes.");
        }
        OtpAuthorization auth = authorizations.findByCodeHash(OrderService.sha256(otp)).orElse(null);
        if (auth == null) {
            attemptLog.record(attendant, OtpAttempt.INVALID, null, null, "No matching code");
            if (attempts.countByAttendantAndOutcomeAndAtAfter(attendant, OtpAttempt.INVALID, window) == MAX_BAD_OTPS) {
                sentinel.raise("OTP_BRUTE_FORCE", RiskEvent.HIGH, null, null, null, null, attendant, "ATTENDANT", null,
                        attendant + " entered " + MAX_BAD_OTPS + " wrong codes in 10 minutes", "LOCKOUT",
                        Map.of("attendant", attendant));
            }
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Invalid OTP");
        }
        FuelOrder order = orders.findById(auth.getOrderId()).orElseThrow();
        if (auth.getStatus() == OtpAuthorization.Status.REDEEMED) {
            attemptLog.record(attendant, OtpAttempt.REUSED, auth.getId(), order.getId(), "Redeemed code presented again");
            sentinel.raise("OTP_REUSE", RiskEvent.CRITICAL, order.getCustomerName(), order.getSiteCode(),
                    auth.getVehicleReg(), auth.getDriverName(), attendant, "ORDER", order.getId(),
                    "A redeemed OTP for " + order.getNumber() + " was presented again", "BLOCKED",
                    Map.of("orderNumber", order.getNumber(), "redeemedAt", String.valueOf(auth.getRedeemedAt())));
            throw new ResponseStatusException(HttpStatus.CONFLICT, "OTP already redeemed - a redeemed OTP is never reusable");
        }
        if (auth.getStatus() == OtpAuthorization.Status.REVOKED) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, "This code was revoked after a security alert");
        }
        if (auth.getStatus() != OtpAuthorization.Status.ACTIVE || auth.isExpired(Instant.now())) {
            attemptLog.record(attendant, OtpAttempt.EXPIRED, auth.getId(), order.getId(), "Expired code presented");
            throw new ResponseStatusException(HttpStatus.CONFLICT, "OTP is not active (status: " + auth.getStatus() + ")");
        }
        checkPin(auth, order, pin, attendant);
        return new ValidationResult(auth, order);
    }

    /** Identity check: the attendant types the PIN the driver tells them. Three misses revoke the code. */
    private void checkPin(OtpAuthorization auth, FuelOrder order, String pin, String attendant) {
        Driver driver = drivers.findByOrganizationAndNameIgnoreCaseAndActiveTrue(order.getCustomerName(), auth.getDriverName())
                .orElse(null);
        if (driver == null || !driver.hasPin()) {
            throw new ResponseStatusException(HttpStatus.FORBIDDEN,
                    "This driver has no PIN set. Ask the customer to reset it.");
        }
        if (driver.isAccessSuspended()) {
            throw new ResponseStatusException(HttpStatus.FORBIDDEN,
                    "This driver's fuel access is suspended: " + driver.getSuspendedReason());
        }
        if (driver.pinMatches(pin)) {
            return;
        }
        attemptLog.record(attendant, OtpAttempt.BAD_PIN, auth.getId(), order.getId(), "Wrong driver PIN");
        long misses = attempts.countByAuthorizationIdAndOutcome(auth.getId(), OtpAttempt.BAD_PIN);
        boolean block = misses >= MAX_BAD_PINS;
        if (block) {
            sentinel.blockAuthorization(auth.getId());
        }
        sentinel.raise("WRONG_DRIVER_PIN", block ? RiskEvent.HIGH : RiskEvent.MEDIUM, order.getCustomerName(),
                order.getSiteCode(), auth.getVehicleReg(), auth.getDriverName(), attendant, "ORDER", order.getId(),
                "Wrong PIN for %s (%d of %d)".formatted(auth.getDriverName(), misses, MAX_BAD_PINS),
                block ? "BLOCK_AUTH" : "NONE", Map.of("orderNumber", order.getNumber(), "misses", misses));
        throw new ResponseStatusException(HttpStatus.FORBIDDEN, block
                ? "PIN wrong " + MAX_BAD_PINS + " times. This fuel code has been revoked."
                : "Driver PIN is incorrect (" + (MAX_BAD_PINS - misses) + " attempts left).");
    }
}
