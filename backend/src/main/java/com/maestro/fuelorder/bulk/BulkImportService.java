package com.maestro.fuelorder.bulk;

import com.maestro.fuelorder.bulk.ExcelTemplates.Prefill;
import com.maestro.fuelorder.bulk.SheetReader.DataRow;
import com.maestro.fuelorder.bulk.SheetReader.Parsed;
import com.maestro.fuelorder.order.OrderService;
import com.maestro.fuelorder.registry.Driver;
import com.maestro.fuelorder.registry.DriverRepository;
import com.maestro.fuelorder.registry.RegistryService;
import com.maestro.fuelorder.registry.Vehicle;
import com.maestro.fuelorder.registry.VehicleRepository;
import org.springframework.dao.DataAccessException;
import org.springframework.stereotype.Service;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;
import org.springframework.web.server.ResponseStatusException;

import java.io.ByteArrayInputStream;
import java.math.BigDecimal;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.regex.Pattern;

/**
 * Bulk registration of vehicles and drivers, and bulk allocation lines for orders, from Excel.
 * Every row is checked before anything is saved: one bad row means nothing is imported, so a customer never ends up
 * with half a fleet loaded and has to work out which half.
 */
@Service
public class BulkImportService {

    public static final long MAX_BYTES = 2L * 1024 * 1024;

    private static final Pattern REGISTRATION = Pattern.compile("[A-Z0-9][A-Z0-9 \\-]{1,19}");
    private static final Pattern PHONE = Pattern.compile("[+0-9][0-9 ()\\-]{5,29}");
    private static final Pattern PRODUCT = Pattern.compile("[A-Z0-9_]{3,20}");
    private static final BigDecimal MAX_LITRES = BigDecimal.valueOf(100_000);

    public record RowResult(int row, String status, String message, Map<String, String> values) {}

    /** The plain PIN is only ever returned here, once, right after the import. */
    public record IssuedPin(int row, String name, String phone, String pin) {}

    public record Allocation(String vehicleReg, String driverName, BigDecimal quantityLitres) {}

    public record Result(String kind, boolean dryRun, boolean imported, int total, int valid, int invalid, int skipped,
                         String error, List<RowResult> rows, List<IssuedPin> pins, List<Allocation> allocations) {}

    private final VehicleRepository vehicles;
    private final DriverRepository drivers;
    private final RegistryService registry;
    private final OrderService orders;
    private final TransactionTemplate tx;

    public BulkImportService(VehicleRepository vehicles, DriverRepository drivers, RegistryService registry,
                             OrderService orders, PlatformTransactionManager transactionManager) {
        this.vehicles = vehicles;
        this.drivers = drivers;
        this.registry = registry;
        this.orders = orders;
        this.tx = new TransactionTemplate(transactionManager);
    }

    /* ── vehicles ─────────────────────────────────────────── */

    public Result vehicles(String org, byte[] file, boolean dryRun) {
        Parsed parsed = SheetReader.read(new ByteArrayInputStream(file), ExcelTemplates.VEHICLES);
        if (parsed.fatal() != null) {
            return failed("vehicles", dryRun, parsed.fatal());
        }
        Set<String> seen = new HashSet<>();
        List<RowResult> results = new ArrayList<>();
        List<Vehicle> toSave = new ArrayList<>();
        for (DataRow r : parsed.rows()) {
            List<String> problems = new ArrayList<>(r.problems());
            String reg = r.values().get("registration").toUpperCase(Locale.ROOT).replaceAll("\\s+", " ");
            if (reg.isEmpty()) {
                problems.add("Registration is required");
            } else if (!REGISTRATION.matcher(reg).matches()) {
                problems.add("Registration must be 2-20 letters, numbers, spaces or hyphens");
            } else if (!seen.add(reg)) {
                problems.add("Registration " + reg + " appears more than once in this file");
            } else if (vehicles.existsByOrganizationAndRegistrationIgnoreCase(org, reg)) {
                problems.add("Vehicle " + reg + " is already registered");
            }
            String description = r.values().get("description");
            if (description.length() > 120) {
                problems.add("Description is longer than 120 characters");
            }
            String fuel = r.values().get("fuelType").toUpperCase(Locale.ROOT);
            if (!fuel.equals("PETROL") && !fuel.equals("DIESEL")) {
                problems.add("Fuel type must be PETROL or DIESEL");
            }
            BigDecimal capacity = number(r.values().get("capacity"), "Tank capacity", BigDecimal.ONE, MAX_LITRES, problems);
            String vehicleType = r.values().get("vehicleType");
            if (vehicleType.length() > 40) {
                problems.add("Vehicle type is longer than 40 characters");
            }
            String model = r.values().get("model");
            if (model.length() > 60) {
                problems.add("Model is longer than 60 characters");
            }
            String yearText = r.values().get("modelYear");
            Integer year = null;
            if (!yearText.isEmpty()) {
                BigDecimal y = number(yearText, "Year", BigDecimal.valueOf(1950), BigDecimal.valueOf(2100), problems);
                if (y != null && y.stripTrailingZeros().scale() > 0) {
                    problems.add("Year must be a whole number, not \"" + yearText + "\"");
                } else if (y != null) {
                    year = y.intValue();
                }
            }

            results.add(row(r, problems, shown("registration", reg, "description", description,
                    "fuelType", fuel, "capacity", r.values().get("capacity"),
                    "vehicleType", vehicleType, "model", model, "modelYear", yearText)));
            if (problems.isEmpty()) {
                Vehicle v = new Vehicle(org, reg, description.isEmpty() ? null : description, fuel, capacity);
                v.identify(vehicleType, model, year);
                toSave.add(v);
            }
        }
        Result preview = summarize("vehicles", dryRun, results, List.of(), List.of());
        if (dryRun || preview.invalid() > 0) {
            return preview;
        }
        try {
            tx.executeWithoutResult(s -> vehicles.saveAll(toSave));
        } catch (DataAccessException e) {
            return conflict("vehicles", results);
        }
        return withImported(preview, List.of());
    }

    /* ── drivers ──────────────────────────────────────────── */

    public Result drivers(String org, byte[] file, boolean dryRun) {
        Parsed parsed = SheetReader.read(new ByteArrayInputStream(file), ExcelTemplates.DRIVERS);
        if (parsed.fatal() != null) {
            return failed("drivers", dryRun, parsed.fatal());
        }
        Map<String, String> fleet = new HashMap<>();
        for (Vehicle v : vehicles.findByOrganizationAndActiveTrueOrderByRegistration(org)) {
            fleet.put(v.getRegistration().toUpperCase(Locale.ROOT), v.getRegistration());
        }
        Set<String> seen = new HashSet<>();
        List<RowResult> results = new ArrayList<>();
        List<Driver> toSave = new ArrayList<>();
        List<Integer> rowOf = new ArrayList<>();
        for (DataRow r : parsed.rows()) {
            List<String> problems = new ArrayList<>(r.problems());
            String name = r.values().get("name").replaceAll("\\s+", " ");
            if (name.isEmpty()) {
                problems.add("Full name is required");
            } else if (name.length() > 100) {
                problems.add("Full name is longer than 100 characters");
            } else if (!seen.add(name.toLowerCase(Locale.ROOT))) {
                problems.add("Driver " + name + " appears more than once in this file");
            } else if (this.drivers.existsByOrganizationAndNameIgnoreCase(org, name)) {
                problems.add("Driver " + name + " is already registered");
            }
            String phone = r.values().get("phone");
            if (!phone.isEmpty() && !PHONE.matcher(phone).matches()) {
                problems.add("Phone must look like +27 82 555 0100");
            }
            String licence = r.values().get("licenseNo");
            if (licence.length() > 40) {
                problems.add("Licence number is longer than 40 characters");
            }
            String requested = r.values().get("vehicleReg");
            String vehicle = null;
            if (!requested.isEmpty()) {
                vehicle = fleet.get(requested.toUpperCase(Locale.ROOT).replaceAll("\\s+", " "));
                if (vehicle == null) {
                    problems.add("Vehicle " + requested + " is not in your fleet. Import the vehicles first");
                }
            }
            results.add(row(r, problems, shown("name", name, "phone", phone, "licenseNo", licence,
                    "vehicleReg", vehicle == null ? "" : vehicle)));
            if (problems.isEmpty()) {
                toSave.add(new Driver(org, name, phone.isEmpty() ? null : phone, licence.isEmpty() ? null : licence, vehicle));
                rowOf.add(r.number());
            }
        }
        Result preview = summarize("drivers", dryRun, results, List.of(), List.of());
        if (dryRun || preview.invalid() > 0) {
            return preview;
        }
        List<String> pins = new ArrayList<>();
        for (Driver d : toSave) {
            pins.add(registry.newPin(d));
        }
        try {
            tx.executeWithoutResult(s -> this.drivers.saveAll(toSave));
        } catch (DataAccessException e) {
            return conflict("drivers", results);
        }
        // texts go out only once the drivers are safely stored, so a failed import never sends a PIN that does not work
        List<IssuedPin> issued = new ArrayList<>();
        for (int i = 0; i < toSave.size(); i++) {
            registry.sendPin(toSave.get(i), pins.get(i));
            issued.add(new IssuedPin(rowOf.get(i), toSave.get(i).getName(), toSave.get(i).getPhone(), pins.get(i)));
        }
        return withImported(preview, issued);
    }

    /* ── bulk order allocations ───────────────────────────── */

    /**
     * Reads vehicle/driver/litres rows for a bulk order and validates them against the customer's fleet.
     * Nothing is created: the portal loads the valid rows into the bulk order form for the user to review and submit.
     */
    public Result orderAllocations(String customer, boolean enforceFleet, String product, byte[] file) {
        if (product == null || !PRODUCT.matcher(product).matches()) {
            return failed("orders", true, "Choose the fuel type before importing allocations.");
        }
        Parsed parsed = SheetReader.read(new ByteArrayInputStream(file), ExcelTemplates.ORDERS);
        if (parsed.fatal() != null) {
            return failed("orders", true, parsed.fatal());
        }
        Map<String, String> fleet = new HashMap<>();
        Map<String, String> usualDriver = new HashMap<>();
        Map<String, String> driverNames = new HashMap<>();
        if (enforceFleet) {
            for (Vehicle v : vehicles.findByOrganizationAndActiveTrueOrderByRegistration(customer)) {
                fleet.put(v.getRegistration().toUpperCase(Locale.ROOT), v.getRegistration());
            }
            for (Driver d : drivers.findByOrganizationAndActiveTrue(customer)) {
                driverNames.put(d.getName().toLowerCase(Locale.ROOT), d.getName());
                if (d.getVehicleReg() != null) {
                    usualDriver.putIfAbsent(d.getVehicleReg().toUpperCase(Locale.ROOT), d.getName());
                }
            }
        }

        Set<String> seen = new HashSet<>();
        List<RowResult> results = new ArrayList<>();
        List<Allocation> allocations = new ArrayList<>();
        int skipped = 0;
        for (DataRow r : parsed.rows()) {
            List<String> problems = new ArrayList<>(r.problems());
            String typedReg = r.values().get("vehicleReg").replaceAll("\\s+", " ");
            String litresText = r.values().get("litres");
            if (litresText.isEmpty() && problems.isEmpty() && !typedReg.isEmpty()) {
                skipped++;
                results.add(new RowResult(r.number(), "SKIPPED", "No litres entered, so this vehicle is left out",
                        Map.of("vehicleReg", typedReg)));
                continue;
            }
            String reg = typedReg.toUpperCase(Locale.ROOT);
            String canonicalReg = typedReg;
            if (typedReg.isEmpty()) {
                problems.add("Vehicle registration is required");
            } else if (enforceFleet && !fleet.containsKey(reg)) {
                problems.add("Vehicle " + typedReg + " is not registered to your fleet");
            } else {
                canonicalReg = enforceFleet ? fleet.get(reg) : typedReg;
                if (!seen.add(reg)) {
                    problems.add("Vehicle " + typedReg + " appears more than once in this file");
                }
            }
            BigDecimal litres = number(litresText, "Litres", BigDecimal.ONE, MAX_LITRES, problems);

            String typedDriver = r.values().get("driverName").replaceAll("\\s+", " ");
            String driver = typedDriver;
            if (enforceFleet && !typedReg.isEmpty()) {
                if (typedDriver.isEmpty()) {
                    driver = usualDriver.get(reg);
                    if (driver == null) {
                        problems.add("No driver given and " + canonicalReg + " has no assigned driver");
                    }
                } else if (driverNames.containsKey(typedDriver.toLowerCase(Locale.ROOT))) {
                    driver = driverNames.get(typedDriver.toLowerCase(Locale.ROOT));
                } else {
                    problems.add("Driver " + typedDriver + " is not registered to your fleet");
                }
            } else if (!enforceFleet && typedDriver.isEmpty()) {
                problems.add("Driver name is required");
            }

            if (problems.isEmpty() && enforceFleet) {
                try {
                    orders.validateAllocation(customer, product, litres, canonicalReg, driver);
                } catch (ResponseStatusException e) {
                    problems.add(e.getReason());
                }
            }
            Map<String, String> shown = new LinkedHashMap<>();
            shown.put("vehicleReg", canonicalReg);
            shown.put("driverName", driver == null ? "" : driver);
            shown.put("litres", litresText);
            results.add(row(r, problems, shown));
            if (problems.isEmpty()) {
                allocations.add(new Allocation(canonicalReg, driver, litres));
            }
        }
        Result preview = summarize("orders", true, results, List.of(), List.of());
        if (preview.invalid() > 0) {
            return withSkipped(preview, skipped, List.of());
        }
        if (allocations.isEmpty()) {
            return failed("orders", true, "No row has litres entered, so there is nothing to order.");
        }
        return withSkipped(preview, skipped, allocations);
    }

    /** Lines for the orders template: the customer's active vehicles that take the fuel, with their usual driver. */
    public List<Prefill> fleetPrefill(String customer, String fuelType) {
        Map<String, String> usualDriver = new HashMap<>();
        for (Driver d : drivers.findByOrganizationAndActiveTrue(customer)) {
            if (d.getVehicleReg() != null) {
                usualDriver.putIfAbsent(d.getVehicleReg().toUpperCase(Locale.ROOT), d.getName());
            }
        }
        List<Prefill> out = new ArrayList<>();
        for (Vehicle v : vehicles.findByOrganizationAndActiveTrueOrderByRegistration(customer)) {
            if (fuelType == null || fuelType.equalsIgnoreCase(v.getFuelType())) {
                out.add(new Prefill(v.getRegistration(), usualDriver.get(v.getRegistration().toUpperCase(Locale.ROOT))));
            }
        }
        return out;
    }

    /* ── helpers ──────────────────────────────────────────── */

    private static BigDecimal number(String text, String label, BigDecimal min, BigDecimal max, List<String> problems) {
        if (text.isEmpty()) {
            problems.add(label + " is required");
            return null;
        }
        try {
            BigDecimal n = new BigDecimal(text.replace(" ", ""));
            if (n.compareTo(min) < 0 || n.compareTo(max) > 0) {
                problems.add(label + " must be between " + min.toPlainString() + " and " + max.toPlainString());
                return null;
            }
            return n;
        } catch (NumberFormatException e) {
            problems.add(label + " must be a number, not \"" + text + "\"");
            return null;
        }
    }

    /** Key/value pairs in the order given, so the portal can show the columns in a sensible order. */
    private static Map<String, String> shown(String... keysAndValues) {
        Map<String, String> m = new LinkedHashMap<>();
        for (int i = 0; i < keysAndValues.length; i += 2) {
            m.put(keysAndValues[i], keysAndValues[i + 1]);
        }
        return m;
    }

    private static RowResult row(DataRow r, List<String> problems, Map<String, String> shown) {
        return problems.isEmpty()
                ? new RowResult(r.number(), "OK", null, shown)
                : new RowResult(r.number(), "ERROR", String.join("; ", problems), shown);
    }

    private static Result summarize(String kind, boolean dryRun, List<RowResult> rows, List<IssuedPin> pins,
                                    List<Allocation> allocations) {
        int valid = (int) rows.stream().filter(r -> r.status().equals("OK")).count();
        int invalid = (int) rows.stream().filter(r -> r.status().equals("ERROR")).count();
        return new Result(kind, dryRun, false, rows.size(), valid, invalid, 0, null, rows, pins, allocations);
    }

    private static Result withImported(Result r, List<IssuedPin> pins) {
        return new Result(r.kind(), false, true, r.total(), r.valid(), r.invalid(), r.skipped(), null, r.rows(), pins,
                r.allocations());
    }

    private static Result withSkipped(Result r, int skipped, List<Allocation> allocations) {
        return new Result(r.kind(), r.dryRun(), false, r.total(), r.valid(), r.invalid(), skipped, null, r.rows(),
                r.pins(), allocations);
    }

    private static Result failed(String kind, boolean dryRun, String message) {
        return new Result(kind, dryRun, false, 0, 0, 0, 0, message, List.of(), List.of(), List.of());
    }

    private static Result conflict(String kind, List<RowResult> rows) {
        int valid = (int) rows.stream().filter(r -> r.status().equals("OK")).count();
        return new Result(kind, false, false, rows.size(), valid, 0, 0,
                "Something changed while the file was being imported (for example someone else registered the same record). "
                        + "Nothing was imported. Upload the file again.", rows, List.of(), List.of());
    }
}
