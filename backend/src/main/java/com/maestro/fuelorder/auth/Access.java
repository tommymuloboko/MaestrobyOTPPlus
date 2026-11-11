package com.maestro.fuelorder.auth;

import jakarta.servlet.http.HttpServletRequest;
import org.springframework.http.HttpStatus;
import org.springframework.web.server.ResponseStatusException;

import java.util.Set;

/** Role and tenant checks shared by the controllers (skeleton stand-in for gateway policies). */
public final class Access {

    public static final String CUSTOMER = "Fleet Manager";
    public static final String ADMIN = "Platform Admin";
    public static final String FINANCE = "Finance";
    /** The oil marketing company's administrator: runs the supplier network, but is not the platform operator. */
    public static final String OMC = "OMC Administrator";
    private static final Set<String> SUPPLIER_ROLES = Set.of("Station Manager", OMC, ADMIN);
    private static final Set<String> DISPENSING_ROLES = Set.of("Attendant", "Station Manager", ADMIN);
    private static final Set<String> FINANCE_ROLES = Set.of(FINANCE, OMC, ADMIN);
    private static final Set<String> STAFF_ROLES = Set.of("Station Manager", "Attendant", FINANCE, OMC, ADMIN);

    private Access() {}

    public static AuthService.Session session(HttpServletRequest request) {
        return (AuthService.Session) request.getAttribute(AuthFilter.SESSION_ATTR);
    }

    /** Customers only ever see their own organization's data. */
    public static boolean isCustomer(AuthService.Session s) {
        return CUSTOMER.equals(s.role());
    }

    public static boolean isAdmin(AuthService.Session s) {
        return ADMIN.equals(s.role());
    }

    public static boolean isOmc(AuthService.Session s) {
        return OMC.equals(s.role());
    }

    /** Roles that may see every customer organization. */
    public static boolean seesAllOrganizations(AuthService.Session s) {
        return isAdmin(s) || isOmc(s) || FINANCE.equals(s.role());
    }

    public static void requireOmc(AuthService.Session s) {
        require(isOmc(s) || isAdmin(s), "Only the OMC Administrator can do this");
    }

    public static void requireCustomer(AuthService.Session s) {
        require(isCustomer(s), "Only the customer's fleet managers can do this");
    }

    public static void requireSupplier(AuthService.Session s) {
        require(SUPPLIER_ROLES.contains(s.role()), "Only the supplier can review and approve orders");
    }

    public static void requireDispensing(AuthService.Session s) {
        require(DISPENSING_ROLES.contains(s.role()), "Only site staff can validate OTPs and dispense fuel");
    }

    public static void requireFinance(AuthService.Session s) {
        require(FINANCE_ROLES.contains(s.role()), "Only Finance can do this");
    }

    public static void requireAdmin(AuthService.Session s) {
        require(isAdmin(s), "Only a Platform Admin can do this");
    }

    public static void requireStaff(AuthService.Session s) {
        require(STAFF_ROLES.contains(s.role()), "Staff only");
    }

    private static void require(boolean ok, String message) {
        if (!ok) {
            throw new ResponseStatusException(HttpStatus.FORBIDDEN, message);
        }
    }
}
