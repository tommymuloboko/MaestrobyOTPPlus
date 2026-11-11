package com.maestro.fuelorder.org;

import com.maestro.fuelorder.auth.Access;
import com.maestro.fuelorder.auth.AuthService;
import com.maestro.fuelorder.notify.NotificationService;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.validation.Valid;
import jakarta.validation.constraints.*;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.server.ResponseStatusException;

import java.math.BigDecimal;
import java.security.SecureRandom;
import java.util.List;

/** Registration of customers and suppliers, their credit terms, and white-label branding. */
@RestController
@RequestMapping("/api/v1")
public class OrganizationController {

    public record RegisterRequest(
            @NotBlank String name,
            @NotBlank @Pattern(regexp = "CUSTOMER|SUPPLIER") String type,
            @NotBlank String country,
            @NotBlank String currency,
            @NotBlank @Email String contactEmail,
            String contactPhone,
            String registrationNo,
            BigDecimal creditLimit,
            String terms,
            BigDecimal monthlyBudget,
            @NotBlank String adminName) {}

    /** The temporary password is shown once; a real deployment emails an invite link instead. */
    public record Registered(Organization organization, String loginEmail, String temporaryPassword) {}

    public record CreditRequest(@NotNull @DecimalMin("0") BigDecimal creditLimit,
                                @NotBlank @Pattern(regexp = "PREPAID|NET_7|NET_30|NET_60") String terms,
                                @NotNull @DecimalMin("0") BigDecimal monthlyBudget) {}

    public record BrandRequest(@NotBlank String brandName,
                               @NotBlank @Pattern(regexp = "#[0-9A-Fa-f]{6}") String primaryColor) {}

    public record Account(Organization organization, CreditService.Standing credit) {}

    public record Branding(String brandName, String primaryColor, String organization) {}

    public record BranchRequest(@NotBlank String code, @NotBlank String name, String city) {}

    private final OrganizationRepository orgs;
    private final AppUserRepository users;
    private final CreditAccountRepository credit;
    private final BranchRepository branches;
    private final CreditService creditService;
    private final NotificationService notifications;

    public OrganizationController(OrganizationRepository orgs, AppUserRepository users,
                                  CreditAccountRepository credit, BranchRepository branches,
                                  CreditService creditService, NotificationService notifications) {
        this.orgs = orgs;
        this.users = users;
        this.credit = credit;
        this.branches = branches;
        this.creditService = creditService;
        this.notifications = notifications;
    }

    @GetMapping("/organizations")
    public List<Organization> list(HttpServletRequest request) {
        AuthService.Session s = Access.session(request);
        if (Access.seesAllOrganizations(s)) {
            return orgs.findAll().stream().sorted((a, b) -> a.getName().compareToIgnoreCase(b.getName())).toList();
        }
        return orgs.findByNameIgnoreCase(s.organization()).map(List::of).orElse(List.of());
    }

    @PostMapping("/organizations")
    @ResponseStatus(HttpStatus.CREATED)
    public Registered register(@RequestBody @Valid RegisterRequest req, HttpServletRequest request) {
        AuthService.Session s = Access.session(request);
        Access.requireOmc(s);
        // an OMC Administrator onboards customers; creating another supplier is a platform operator's decision
        if (!Access.isAdmin(s) && !Organization.CUSTOMER.equals(req.type())) {
            throw new ResponseStatusException(HttpStatus.FORBIDDEN, "An OMC Administrator can only register customers");
        }
        if (orgs.findByNameIgnoreCase(req.name().trim()).isPresent()) {
            throw new IllegalStateException("An organization called " + req.name() + " already exists");
        }
        if (users.findByEmailIgnoreCase(req.contactEmail()).isPresent()) {
            throw new IllegalStateException(req.contactEmail() + " is already a user");
        }
        Organization org = orgs.save(new Organization(req.name().trim(), req.type(), req.country().toUpperCase(),
                req.currency().toUpperCase(), req.contactEmail(), req.contactPhone(), req.registrationNo()));
        boolean customer = Organization.CUSTOMER.equals(req.type());
        if (customer) {
            credit.save(new CreditAccount(org.getName(),
                    req.creditLimit() == null ? BigDecimal.ZERO : req.creditLimit(),
                    req.terms() == null ? "PREPAID" : req.terms(),
                    req.monthlyBudget() == null ? BigDecimal.ZERO : req.monthlyBudget()));
        }
        String temp = temporaryPassword();
        users.save(new AppUser(req.contactEmail(), req.adminName(), customer ? Access.CUSTOMER : "Station Manager",
                org.getName(), null, AuthService.hashPassword(temp)));
        notifications.sms(org.getName(), req.adminName(), req.contactPhone(), "WELCOME",
                "Welcome to Maestro. Sign in as " + req.contactEmail() + " with your temporary password and change it.",
                org.getName());
        return new Registered(org, req.contactEmail(), temp);
    }

    @GetMapping("/account")
    public Account account(HttpServletRequest request) {
        AuthService.Session s = Access.session(request);
        Organization org = orgs.findByNameIgnoreCase(s.organization())
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND, "Organization not found"));
        return new Account(org, creditService.standing(org.getName()));
    }

    @PutMapping("/organizations/{name}/credit")
    public CreditAccount setCredit(@PathVariable String name, @RequestBody @Valid CreditRequest req,
                                   HttpServletRequest request) {
        Access.requireFinance(Access.session(request));
        CreditAccount acct = credit.findByOrganization(name)
                .orElseGet(() -> new CreditAccount(name, BigDecimal.ZERO, "PREPAID", BigDecimal.ZERO));
        acct.update(req.creditLimit(), req.terms(), req.monthlyBudget());
        return credit.save(acct);
    }

    @GetMapping("/credit-accounts")
    public List<CreditService.Standing> standings(HttpServletRequest request) {
        Access.requireFinance(Access.session(request));
        return credit.findAll().stream().map(c -> creditService.standing(c.getOrganization())).toList();
    }

    @GetMapping("/branches")
    public List<Branch> branches(HttpServletRequest request) {
        return branches.findByOrganization(Access.session(request).organization());
    }

    @PostMapping("/branches")
    @ResponseStatus(HttpStatus.CREATED)
    public Branch addBranch(@RequestBody @Valid BranchRequest req, HttpServletRequest request) {
        AuthService.Session s = Access.session(request);
        Access.requireCustomer(s);
        return branches.save(new Branch(s.organization(), req.code().trim().toUpperCase(), req.name(), req.city()));
    }

    /** White label: customers see their supplier's brand unless they have branded their own workspace. */
    @GetMapping("/branding")
    public Branding branding(HttpServletRequest request) {
        AuthService.Session s = Access.session(request);
        Organization own = orgs.findByNameIgnoreCase(s.organization()).orElse(null);
        if (own != null && own.getBrandName() != null) {
            return new Branding(own.getBrandName(), own.getPrimaryColor(), own.getName());
        }
        Organization supplier = orgs.findByNameIgnoreCase(com.maestro.fuelorder.order.OrderService.SUPPLIER_ORG).orElse(null);
        if (Access.isCustomer(s) && supplier != null && supplier.getBrandName() != null) {
            return new Branding(supplier.getBrandName(), supplier.getPrimaryColor(), supplier.getName());
        }
        return new Branding("Maestro", "#2DB94D", s.organization());
    }

    @PutMapping("/branding")
    public Branding setBranding(@RequestBody @Valid BrandRequest req, HttpServletRequest request) {
        AuthService.Session s = Access.session(request);
        Access.requireSupplier(s);
        Organization org = orgs.findByNameIgnoreCase(s.organization())
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND, "Organization not found"));
        org.brand(req.brandName().trim(), req.primaryColor());
        orgs.save(org);
        return new Branding(org.getBrandName(), org.getPrimaryColor(), org.getName());
    }

    static String temporaryPassword() {
        String alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
        SecureRandom r = new SecureRandom();
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < 12; i++) {
            sb.append(alphabet.charAt(r.nextInt(alphabet.length())));
        }
        return sb.toString();
    }
}
