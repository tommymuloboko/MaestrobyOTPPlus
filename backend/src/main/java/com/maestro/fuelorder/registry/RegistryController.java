package com.maestro.fuelorder.registry;

import com.maestro.fuelorder.auth.Access;
import com.maestro.fuelorder.auth.AuthService;
import com.maestro.fuelorder.dispense.FuelTransaction;
import com.maestro.fuelorder.dispense.FuelTransactionRepository;
import com.maestro.fuelorder.notify.NotificationService;
import com.maestro.fuelorder.org.Organization;
import com.maestro.fuelorder.org.OrganizationRepository;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.validation.Valid;
import jakarta.validation.constraints.DecimalMax;
import jakarta.validation.constraints.DecimalMin;
import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Pattern;
import jakarta.validation.constraints.Size;
import org.springframework.data.domain.PageRequest;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.server.ResponseStatusException;

import java.math.BigDecimal;
import java.util.List;
import java.util.UUID;

/** Each customer manages its own vehicles and drivers; staff roles can read all of them. */
@RestController
@RequestMapping("/api/v1")
public class RegistryController {

    public record VehicleRequest(
            @NotBlank String registration,
            String description,
            @NotBlank @Pattern(regexp = "PETROL|DIESEL") String fuelType,
            @NotNull @DecimalMin("1.0") BigDecimal tankCapacityLitres,
            /** Only used by the OMC when registering a vehicle on a customer's behalf. */
            String customerName,
            @Size(max = 40) String vehicleType,
            @Size(max = 60) String model,
            @Min(1950) @Max(2100) Integer modelYear) {}

    public record VehicleUpdate(@Size(max = 120) String description, @DecimalMin("1.0") @DecimalMax("100000") BigDecimal tankCapacityLitres,
                                @Size(max = 40) String vehicleType, @Size(max = 60) String model,
                                @Min(1950) @Max(2100) Integer modelYear) {}

    public record ReasonRequest(@NotBlank @Size(max = 200) String reason) {}

    public record DriverRequest(@NotBlank String name, String phone, String licenseNo, String vehicleReg) {}

    public record AssignRequest(String vehicleReg) {}

    /** A blank driverId clears the vehicle's driver. */
    public record AssignDriverRequest(UUID driverId) {}

    /** Returned once when a PIN is issued; the PIN is only ever stored hashed. */
    public record DriverPin(Driver driver, String pin) {}

    private final VehicleRepository vehicles;
    private final DriverRepository drivers;
    private final RegistryService registry;
    private final OrganizationRepository orgs;
    private final FuelTransactionRepository transactions;
    private final NotificationService notifications;

    public RegistryController(VehicleRepository vehicles, DriverRepository drivers, RegistryService registry,
                              OrganizationRepository orgs, FuelTransactionRepository transactions,
                              NotificationService notifications) {
        this.vehicles = vehicles;
        this.drivers = drivers;
        this.registry = registry;
        this.orgs = orgs;
        this.transactions = transactions;
        this.notifications = notifications;
    }

    @GetMapping("/vehicles")
    public List<Vehicle> listVehicles(HttpServletRequest request) {
        AuthService.Session s = Access.session(request);
        return vehicles.findAll().stream()
                .filter(v -> !Access.isCustomer(s) || v.getOrganization().equals(s.organization()))
                .sorted((a, b) -> a.getRegistration().compareToIgnoreCase(b.getRegistration()))
                .toList();
    }

    /** A customer registers its own fleet; the OMC may register a vehicle for a customer by name. */
    @PostMapping("/vehicles")
    @ResponseStatus(HttpStatus.CREATED)
    public Vehicle addVehicle(@RequestBody @Valid VehicleRequest req, HttpServletRequest request) {
        AuthService.Session s = Access.session(request);
        String owner = Access.isCustomer(s) ? s.organization() : customerForStaff(s, req.customerName());
        String reg = req.registration().trim().toUpperCase();
        if (vehicles.existsByOrganizationAndRegistrationIgnoreCase(owner, reg)) {
            throw new IllegalStateException("Vehicle " + reg + " is already registered");
        }
        Vehicle v = new Vehicle(owner, reg, req.description(), req.fuelType(), req.tankCapacityLitres());
        v.identify(req.vehicleType(), req.model(), req.modelYear());
        return vehicles.save(v);
    }

    /** Edits the description and tank capacity. Orders above the new capacity are refused from then on. */
    @PatchMapping("/vehicles/{id}")
    public Vehicle updateVehicle(@PathVariable UUID id, @RequestBody @Valid VehicleUpdate req, HttpServletRequest request) {
        AuthService.Session s = Access.session(request);
        Vehicle v = ownVehicleOrStaff(id, s);
        v.update(req.description(), req.tankCapacityLitres(), req.vehicleType(), req.model(), req.modelYear());
        return vehicles.save(v);
    }

    /** The most recent dispenses for one vehicle, newest first. */
    @GetMapping("/vehicles/{id}/fuelling")
    public List<FuelTransaction> fuelling(@PathVariable UUID id, HttpServletRequest request) {
        AuthService.Session s = Access.session(request);
        Vehicle v = Access.isCustomer(s) ? ownVehicleOrStaff(id, s)
                : vehicles.findById(id).orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND, "Vehicle not found"));
        if (!Access.isCustomer(s)) {
            Access.requireStaff(s);
        }
        return transactions.forVehicle(v.getOrganization(), v.getRegistration(), PageRequest.of(0, 100));
    }

    private Vehicle ownVehicleOrStaff(UUID id, AuthService.Session s) {
        Vehicle v = vehicles.findById(id)
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND, "Vehicle not found"));
        if (Access.isCustomer(s)) {
            if (!v.getOrganization().equals(s.organization())) {
                throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Vehicle not found");
            }
        } else {
            Access.requireSupplier(s);
        }
        return v;
    }

    private String customerForStaff(AuthService.Session s, String requested) {
        Access.requireSupplier(s);
        if (requested == null || requested.isBlank()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "customerName is required");
        }
        return orgs.findByNameIgnoreCase(requested.trim())
                .filter(o -> Organization.CUSTOMER.equals(o.getType()))
                .map(Organization::getName)
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.BAD_REQUEST, "Unknown customer " + requested));
    }

    @DeleteMapping("/vehicles/{id}")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    public void removeVehicle(@PathVariable UUID id, HttpServletRequest request) {
        AuthService.Session s = Access.session(request);
        Access.requireCustomer(s);
        Vehicle v = vehicles.findById(id)
                .filter(x -> x.getOrganization().equals(s.organization()))
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND, "Vehicle not found"));
        v.deactivate();
        vehicles.save(v);
        // drivers assigned to a removed vehicle simply lose the assignment
        drivers.findAll().stream()
                .filter(d -> d.getOrganization().equals(s.organization())
                        && v.getRegistration().equalsIgnoreCase(d.getVehicleReg()))
                .forEach(d -> { d.assignVehicle(null); drivers.save(d); });
    }

    @GetMapping("/drivers")
    public List<Driver> listDrivers(HttpServletRequest request) {
        AuthService.Session s = Access.session(request);
        return drivers.findAll().stream()
                .filter(d -> !Access.isCustomer(s) || d.getOrganization().equals(s.organization()))
                .sorted((a, b) -> a.getName().compareToIgnoreCase(b.getName()))
                .toList();
    }

    @PostMapping("/drivers")
    @ResponseStatus(HttpStatus.CREATED)
    public DriverPin addDriver(@RequestBody @Valid DriverRequest req, HttpServletRequest request) {
        AuthService.Session s = Access.session(request);
        Access.requireCustomer(s);
        String name = req.name().trim();
        if (drivers.existsByOrganizationAndNameIgnoreCase(s.organization(), name)) {
            throw new IllegalStateException("Driver " + name + " is already registered");
        }
        Driver d = new Driver(s.organization(), name, req.phone(), req.licenseNo(),
                resolveVehicle(s.organization(), req.vehicleReg()));
        String pin = registry.issuePin(d);
        Driver saved = drivers.save(d);
        notifications.inApp(s.organization(), "DRIVER", saved.getVehicleReg() == null
                ? "Driver %s was created.".formatted(saved.getName())
                : "Driver %s was created and assigned to vehicle %s.".formatted(saved.getName(), saved.getVehicleReg()),
                saved.getId().toString());
        return new DriverPin(saved, pin);
    }

    @PostMapping("/drivers/{id}/reset-pin")
    public DriverPin resetPin(@PathVariable UUID id, HttpServletRequest request) {
        AuthService.Session s = Access.session(request);
        Access.requireCustomer(s);
        Driver d = drivers.findById(id)
                .filter(x -> x.getOrganization().equals(s.organization()))
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND, "Driver not found"));
        String pin = registry.issuePin(d);
        return new DriverPin(drivers.save(d), pin);
    }

    /** OMC identity check: the driver's licence and ID have been seen. */
    @PostMapping("/drivers/{id}/verify")
    public Driver verifyDriver(@PathVariable UUID id, HttpServletRequest request) {
        AuthService.Session s = Access.session(request);
        Access.requireSupplier(s);
        Driver d = anyDriver(id);
        d.verify(s.name());
        return drivers.save(d);
    }

    @PostMapping("/drivers/{id}/unverify")
    public Driver unverifyDriver(@PathVariable UUID id, HttpServletRequest request) {
        Access.requireSupplier(Access.session(request));
        Driver d = anyDriver(id);
        d.unverify();
        return drivers.save(d);
    }

    /** Stops the driver redeeming fuel codes and blocks new orders for them, until restored. */
    @PostMapping("/drivers/{id}/suspend")
    public Driver suspendDriver(@PathVariable UUID id, @RequestBody @Valid ReasonRequest req, HttpServletRequest request) {
        Access.requireSupplier(Access.session(request));
        Driver d = anyDriver(id);
        d.suspend(req.reason().trim());
        return drivers.save(d);
    }

    @PostMapping("/drivers/{id}/restore")
    public Driver restoreDriver(@PathVariable UUID id, HttpServletRequest request) {
        Access.requireSupplier(Access.session(request));
        Driver d = anyDriver(id);
        d.restore();
        return drivers.save(d);
    }

    private Driver anyDriver(UUID id) {
        return drivers.findById(id).orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND, "Driver not found"));
    }

    @PatchMapping("/drivers/{id}/vehicle")
    public Driver assignVehicle(@PathVariable UUID id, @RequestBody AssignRequest req,
                                HttpServletRequest request) {
        AuthService.Session s = Access.session(request);
        Access.requireCustomer(s);
        Driver d = drivers.findById(id)
                .filter(x -> x.getOrganization().equals(s.organization()))
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND, "Driver not found"));
        d.assignVehicle(resolveVehicle(s.organization(), req.vehicleReg()));
        Driver saved = drivers.save(d);
        notifyAssignment(s.organization(), saved);
        return saved;
    }

    /** The same assignment seen from the vehicle: it takes effect at once and replaces the vehicle's other drivers. */
    @PatchMapping("/vehicles/{id}/driver")
    public ResponseEntity<Driver> assignDriver(@PathVariable UUID id, @RequestBody AssignDriverRequest req, HttpServletRequest request) {
        AuthService.Session s = Access.session(request);
        Access.requireCustomer(s);
        Vehicle v = ownVehicleOrStaff(id, s);
        Driver chosen = req.driverId() == null ? null : drivers.findById(req.driverId())
                .filter(x -> x.getOrganization().equals(s.organization()) && x.isActive())
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND, "Driver not found"));
        drivers.findAll().stream()
                .filter(d -> d.getOrganization().equals(s.organization())
                        && v.getRegistration().equalsIgnoreCase(d.getVehicleReg())
                        && (chosen == null || !d.getId().equals(chosen.getId())))
                .forEach(d -> { d.assignVehicle(null); drivers.save(d); });
        if (chosen == null) {
            notifications.inApp(s.organization(), "DRIVER",
                    "Vehicle %s no longer has an assigned driver.".formatted(v.getRegistration()), v.getId().toString());
            return ResponseEntity.noContent().build();
        }
        chosen.assignVehicle(v.getRegistration());
        Driver saved = drivers.save(chosen);
        notifyAssignment(s.organization(), saved);
        return ResponseEntity.ok(saved);
    }

    private void notifyAssignment(String organization, Driver d) {
        notifications.inApp(organization, "DRIVER", d.getVehicleReg() == null
                ? "Driver %s was unassigned from their vehicle.".formatted(d.getName())
                : "Driver %s was assigned to vehicle %s.".formatted(d.getName(), d.getVehicleReg()),
                d.getId().toString());
    }

    /** Blank clears the assignment; otherwise the vehicle must be an active one of the same fleet. */
    private String resolveVehicle(String organization, String vehicleReg) {
        if (vehicleReg == null || vehicleReg.isBlank()) {
            return null;
        }
        return vehicles.findByOrganizationAndRegistrationIgnoreCaseAndActiveTrue(organization, vehicleReg.trim())
                .map(Vehicle::getRegistration)
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.BAD_REQUEST,
                        "Vehicle " + vehicleReg + " is not in your fleet"));
    }

    @DeleteMapping("/drivers/{id}")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    public void removeDriver(@PathVariable UUID id, HttpServletRequest request) {
        AuthService.Session s = Access.session(request);
        Access.requireCustomer(s);
        Driver d = drivers.findById(id)
                .filter(x -> x.getOrganization().equals(s.organization()))
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND, "Driver not found"));
        d.deactivate();
        drivers.save(d);
    }
}
