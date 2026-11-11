package com.maestro.fuelorder.bootstrap;

import com.maestro.fuelorder.auth.Access;
import com.maestro.fuelorder.auth.AuthService;
import com.maestro.fuelorder.finance.TaxRate;
import com.maestro.fuelorder.finance.TaxRateRepository;
import com.maestro.fuelorder.order.ApprovalPolicy;
import com.maestro.fuelorder.order.ApprovalPolicyRepository;
import com.maestro.fuelorder.order.OrderService;
import com.maestro.fuelorder.org.*;
import com.maestro.fuelorder.pricing.*;
import com.maestro.fuelorder.registry.Driver;
import com.maestro.fuelorder.registry.DriverRepository;
import com.maestro.fuelorder.registry.Vehicle;
import com.maestro.fuelorder.registry.VehicleRepository;
import com.maestro.fuelorder.stock.Tank;
import com.maestro.fuelorder.stock.TankRepository;
import org.springframework.boot.CommandLineRunner;
import org.springframework.stereotype.Component;

import java.math.BigDecimal;
import java.time.LocalDate;
import java.util.List;

/** Demo data for the in-memory database. Nothing here is a real credential or customer. */
@Component
public class DemoData implements CommandLineRunner {

    static final String PASSWORD = "Maestro#2026";
    static final String DRIVER_PIN = "1234";

    private final OrganizationRepository orgs;
    private final AppUserRepository users;
    private final CreditAccountRepository credit;
    private final BranchRepository branches;
    private final VehicleRepository vehicles;
    private final DriverRepository drivers;
    private final TankRepository tanks;
    private final ListPriceRepository listPrices;
    private final PriceRuleRepository rules;
    private final PriceHistoryRepository history;
    private final TaxRateRepository taxRates;
    private final ApprovalPolicyRepository policies;

    public DemoData(OrganizationRepository orgs, AppUserRepository users, CreditAccountRepository credit,
                    BranchRepository branches, VehicleRepository vehicles, DriverRepository drivers,
                    TankRepository tanks, ListPriceRepository listPrices, PriceRuleRepository rules,
                    PriceHistoryRepository history, TaxRateRepository taxRates, ApprovalPolicyRepository policies) {
        this.orgs = orgs;
        this.users = users;
        this.credit = credit;
        this.branches = branches;
        this.vehicles = vehicles;
        this.drivers = drivers;
        this.tanks = tanks;
        this.listPrices = listPrices;
        this.rules = rules;
        this.history = history;
        this.taxRates = taxRates;
        this.policies = policies;
    }

    @Override
    public void run(String... args) {
        String acme = "Acme Logistics";
        String buildco = "BuildCo Mining";
        String supplier = OrderService.SUPPLIER_ORG;
        String platform = "Maestro Platform";

        orgs.saveAll(List.of(
                new Organization(acme, Organization.CUSTOMER, "ZA", "ZAR", "fleet@acme.test", "+27 82 555 0100", "2011/123456/07"),
                new Organization(buildco, Organization.CUSTOMER, "ZA", "ZAR", "fleet@buildco.test", "+27 83 555 0200", "2015/654321/07"),
                new Organization(supplier, Organization.SUPPLIER, "ZA", "ZAR", "supplier@mainline.test", "+27 11 555 0300", "2009/777888/07"),
                new Organization(platform, Organization.PLATFORM, "ZA", "ZAR", "admin@maestro.test", null, null)));

        String seedPassword = System.getenv("MAESTRO_SEED_PASSWORD");
        String pw = AuthService.hashPassword(seedPassword == null || seedPassword.isBlank() ? PASSWORD : seedPassword);
        users.saveAll(List.of(
                new AppUser("fleet@acme.test", "Sipho Dlamini", "Fleet Manager", acme, "JHB", pw),
                new AppUser("fleet@buildco.test", "Lerato Khumalo", "Fleet Manager", buildco, "MINE1", pw),
                new AppUser("supplier@mainline.test", "Thandi Nkosi", "Station Manager", supplier, null, pw),
                new AppUser("omc@mainline.test", "Zodwa Ndlovu", Access.OMC, supplier, null, pw),
                new AppUser("attendant@mainline.test", "A. Mokoena", "Attendant", supplier, null, pw),
                new AppUser("finance@maestro.test", "Naledi Finance", "Finance", platform, null, pw),
                new AppUser("admin@maestro.test", "Maestro Admin", "Platform Admin", platform, null, pw)));

        credit.saveAll(List.of(
                new CreditAccount(acme, new BigDecimal("250000"), "NET_30", new BigDecimal("80000")),
                new CreditAccount(buildco, new BigDecimal("500000"), "NET_7", new BigDecimal("200000"))));
        branches.saveAll(List.of(
                new Branch(acme, "JHB", "Johannesburg Yard", "Johannesburg"),
                new Branch(acme, "CPT", "Cape Town Yard", "Cape Town"),
                new Branch(buildco, "MINE1", "Mine Site 1", "Rustenburg")));

        List<Vehicle> fleet = List.of(
                new Vehicle(acme, "CA 123-456", "Isuzu FTR 850 truck", "DIESEL", new BigDecimal("200")),
                new Vehicle(acme, "CA 456-789", "Toyota Hilux", "DIESEL", new BigDecimal("80")),
                new Vehicle(acme, "CA 789-012", "VW Polo delivery car", "PETROL", new BigDecimal("45")),
                new Vehicle(buildco, "GP 777-888", "Volvo FMX tipper", "DIESEL", new BigDecimal("400")),
                new Vehicle(buildco, "GP 321-654", "Toyota Land Cruiser", "DIESEL", new BigDecimal("90")));
        fleet.get(0).identify("Truck", "FTR 850", 2021);
        fleet.get(1).identify("Pickup", "Hilux", 2020);
        fleet.get(2).identify("Car", "Polo", 2019);
        fleet.get(3).identify("Tipper", "FMX", 2022);
        fleet.get(4).identify("SUV", "Land Cruiser", 2018);
        vehicles.saveAll(fleet);
        List<Driver> ds = List.of(
                new Driver(acme, "S. Dlamini", "+27 82 555 0101", "DL-AC-1001", "CA 123-456"),
                new Driver(acme, "T. Mahlangu", "+27 82 555 0102", "DL-AC-1002", "CA 456-789"),
                new Driver(acme, "R. Naidoo", "+27 82 555 0103", "DL-AC-1003", "CA 789-012"),
                new Driver(buildco, "T. Nkosi", "+27 83 555 0201", "DL-BC-2001", "GP 777-888"),
                new Driver(buildco, "L. Botha", "+27 83 555 0202", "DL-BC-2002", "GP 321-654"));
        ds.forEach(d -> d.setPin(DRIVER_PIN));
        // the first four are verified; R. Naidoo is left unverified so the verification workflow has something to show
        ds.stream().filter(d -> !d.getName().equals("R. Naidoo")).forEach(d -> d.verify("Seed data"));
        drivers.saveAll(ds);

        for (String site : List.of("SITE-JHB-001", "SITE-CPT-002", "SITE-DBN-003")) {
            tanks.save(new Tank(site, "DIESEL_50", new BigDecimal("60000"), new BigDecimal("42000"), new BigDecimal("12000")));
            tanks.save(new Tank(site, "ULP_95", new BigDecimal("30000"), new BigDecimal("18000"), new BigDecimal("6000")));
        }

        LocalDate start = LocalDate.now().minusDays(30);
        listPrices.saveAll(List.of(
                new ListPrice("DIESEL_50", new BigDecimal("22.30"), "ZAR", start),
                new ListPrice("ULP_93", new BigDecimal("22.80"), "ZAR", start),
                new ListPrice("ULP_95", new BigDecimal("23.10"), "ZAR", start)));
        seedRule(acme, "DIESEL_50", PriceRule.FIXED, "21.45", "0", start);
        seedRule(acme, "DIESEL_50", PriceRule.FIXED, "21.10", "1000", start);
        seedRule(acme, "ULP_95", PriceRule.DISCOUNT_PCT, "3", "0", start);
        seedRule(buildco, "DIESEL_50", PriceRule.FIXED, "20.90", "0", start);
        seedRule(buildco, "ULP_95", PriceRule.DISCOUNT_PCT, "4", "0", start);

        taxRates.saveAll(List.of(
                new TaxRate("ZA", "VAT", new BigDecimal("15"), start),
                new TaxRate("ZW", "VAT", new BigDecimal("15"), start),
                new TaxRate("ZM", "VAT", new BigDecimal("16"), start)));

        // auto-approval is off by default so the manual supplier review stays the demo path
        policies.save(new ApprovalPolicy(supplier, BigDecimal.ZERO, true));
    }

    private void seedRule(String org, String product, String mode, String value, String minLitres, LocalDate from) {
        PriceRule r = new PriceRule(org, product, null, mode, new BigDecimal(value), new BigDecimal(minLitres),
                from, null, "seed");
        r.decide(PriceRule.ACTIVE, "seed approval");
        rules.save(r);
    }
}
