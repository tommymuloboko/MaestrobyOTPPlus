package com.maestro.fuelorder.org;

import com.maestro.fuelorder.auth.Access;
import com.maestro.fuelorder.auth.AuthService;
import com.maestro.fuelorder.order.OrderService;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.validation.Valid;
import jakarta.validation.constraints.Email;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.server.ResponseStatusException;

import java.util.List;
import java.util.Locale;
import java.util.UUID;

/**
 * User administration for the OMC Administrator: add, edit, deactivate and delete the people who can sign in.
 * An OMC Administrator is not the platform operator, so Platform Admin accounts are out of reach for them.
 */
@RestController
@RequestMapping("/api/v1/users")
public class UserController {

    private static final List<String> ROLES =
            List.of(Access.CUSTOMER, "Station Manager", "Attendant", Access.FINANCE, Access.OMC);

    public record UserView(UUID id, String email, String name, String role, String organization, String branchCode, boolean active) {}

    public record CreateRequest(@NotBlank @Email @Size(max = 200) String email,
                                @NotBlank @Size(max = 120) String name,
                                @NotBlank String role,
                                @Size(max = 120) String organization,
                                @Size(max = 40) String branchCode) {}

    public record UpdateRequest(@NotBlank @Size(max = 120) String name,
                                @NotBlank String role,
                                @Size(max = 120) String organization,
                                @Size(max = 40) String branchCode) {}

    /** The temporary password is returned once and never stored in readable form. */
    public record Created(UserView user, String loginEmail, String temporaryPassword) {}

    private final AppUserRepository users;
    private final OrganizationRepository orgs;
    private final BranchRepository branches;
    private final AuthService auth;

    public UserController(AppUserRepository users, OrganizationRepository orgs, BranchRepository branches, AuthService auth) {
        this.users = users;
        this.orgs = orgs;
        this.branches = branches;
        this.auth = auth;
    }

    @GetMapping
    public List<UserView> list(HttpServletRequest request) {
        Access.requireOmc(Access.session(request));
        return users.findAll().stream()
                .sorted((a, b) -> a.getName().compareToIgnoreCase(b.getName()))
                .map(UserController::view).toList();
    }

    @PostMapping
    @ResponseStatus(HttpStatus.CREATED)
    public Created create(@RequestBody @Valid CreateRequest req, HttpServletRequest request) {
        AuthService.Session s = Access.session(request);
        Access.requireOmc(s);
        String email = req.email().trim().toLowerCase(Locale.ROOT);
        if (users.findByEmailIgnoreCase(email).isPresent()) {
            throw new IllegalStateException(email + " is already a user");
        }
        checkRoleAllowed(s, req.role());
        String organization = organizationFor(req.role(), req.organization(), null, null);
        String branch = branchFor(req.role(), organization, req.branchCode());

        String temp = OrganizationController.temporaryPassword();
        AppUser u = users.save(new AppUser(email, req.name().trim(), req.role(), organization, branch, AuthService.hashPassword(temp)));
        return new Created(view(u), u.getEmail(), temp);
    }

    @PutMapping("/{id}")
    public UserView update(@PathVariable UUID id, @RequestBody @Valid UpdateRequest req, HttpServletRequest request) {
        AuthService.Session s = Access.session(request);
        Access.requireOmc(s);
        AppUser u = target(id, s);
        boolean roleChanged = !u.getRole().equals(req.role());
        if (roleChanged) {
            if (isSelf(s, u)) {
                throw new IllegalStateException("You cannot change your own role");
            }
            checkRoleAllowed(s, req.role());
            guardLastPlatformAdmin(u);
        }
        String organization = organizationFor(req.role(), req.organization(), roleChanged ? null : u.getOrganization(), u);
        String branch = branchFor(req.role(), organization, req.branchCode());
        String organizationBefore = u.getOrganization();
        u.update(req.name().trim(), req.role(), organization, branch);
        users.save(u);
        // sessions carry the role and organization they were created with, so a changed account must sign in again
        if (roleChanged || !organization.equals(organizationBefore)) {
            auth.revokeSessions(u.getEmail());
        }
        return view(u);
    }

    @PostMapping("/{id}/deactivate")
    public UserView deactivate(@PathVariable UUID id, HttpServletRequest request) {
        AuthService.Session s = Access.session(request);
        Access.requireOmc(s);
        AppUser u = target(id, s);
        if (isSelf(s, u)) {
            throw new IllegalStateException("You cannot deactivate your own account");
        }
        guardLastPlatformAdmin(u);
        u.setActive(false);
        users.save(u);
        auth.revokeSessions(u.getEmail());
        return view(u);
    }

    @PostMapping("/{id}/activate")
    public UserView activate(@PathVariable UUID id, HttpServletRequest request) {
        AuthService.Session s = Access.session(request);
        Access.requireOmc(s);
        AppUser u = target(id, s);
        u.setActive(true);
        return view(users.save(u));
    }

    @PostMapping("/{id}/reset-password")
    public Created resetPassword(@PathVariable UUID id, HttpServletRequest request) {
        AuthService.Session s = Access.session(request);
        Access.requireOmc(s);
        AppUser u = target(id, s);
        if (isSelf(s, u)) {
            throw new IllegalStateException("You cannot reset your own password here");
        }
        String temp = OrganizationController.temporaryPassword();
        u.setPasswordHash(AuthService.hashPassword(temp));
        users.save(u);
        auth.revokeSessions(u.getEmail());
        return new Created(view(u), u.getEmail(), temp);
    }

    @DeleteMapping("/{id}")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    public void delete(@PathVariable UUID id, HttpServletRequest request) {
        AuthService.Session s = Access.session(request);
        Access.requireOmc(s);
        AppUser u = target(id, s);
        if (isSelf(s, u)) {
            throw new IllegalStateException("You cannot delete your own account");
        }
        guardLastPlatformAdmin(u);
        users.delete(u);
        auth.revokeSessions(u.getEmail());
    }

    /* ── rules ─────────────────────────────────────────────────── */

    private AppUser target(UUID id, AuthService.Session s) {
        AppUser u = users.findById(id).orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND, "User not found"));
        if (Access.ADMIN.equals(u.getRole()) && !Access.isAdmin(s)) {
            throw new ResponseStatusException(HttpStatus.FORBIDDEN, "Only a Platform Admin can change a Platform Admin account");
        }
        return u;
    }

    private static boolean isSelf(AuthService.Session s, AppUser u) {
        return s.email().equalsIgnoreCase(u.getEmail());
    }

    private static void checkRoleAllowed(AuthService.Session s, String role) {
        if (Access.ADMIN.equals(role)) {
            if (!Access.isAdmin(s)) {
                throw new ResponseStatusException(HttpStatus.FORBIDDEN, "Only a Platform Admin can give the Platform Admin role");
            }
        } else if (!ROLES.contains(role)) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Unknown role " + role);
        }
    }

    /** The platform must always keep one active Platform Admin. */
    private void guardLastPlatformAdmin(AppUser u) {
        if (Access.ADMIN.equals(u.getRole()) && u.isActive()
                && users.findAll().stream().filter(x -> Access.ADMIN.equals(x.getRole()) && x.isActive()).count() <= 1) {
            throw new IllegalStateException("This is the last active Platform Admin");
        }
    }

    /**
     * Fleet Managers belong to a customer. Every other role belongs to the supplier (or, for Platform Admin, the
     * platform); an existing account keeps its organization when its role is unchanged.
     */
    private String organizationFor(String role, String requested, String existing, AppUser current) {
        if (Access.CUSTOMER.equals(role)) {
            if (requested == null || requested.isBlank()) {
                throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "A fleet manager belongs to a customer: choose the organization");
            }
            return orgs.findByNameIgnoreCase(requested.trim()).filter(o -> Organization.CUSTOMER.equals(o.getType()))
                    .map(Organization::getName)
                    .orElseThrow(() -> new ResponseStatusException(HttpStatus.BAD_REQUEST, requested + " is not a customer organization"));
        }
        if (existing != null && current != null && !Access.CUSTOMER.equals(current.getRole())) {
            return existing;
        }
        if (Access.ADMIN.equals(role)) {
            return orgs.findAll().stream().filter(o -> Organization.PLATFORM.equals(o.getType())).findFirst()
                    .map(Organization::getName).orElse("Maestro Platform");
        }
        return OrderService.SUPPLIER_ORG;
    }

    private String branchFor(String role, String organization, String branchCode) {
        if (!Access.CUSTOMER.equals(role) || branchCode == null || branchCode.isBlank()) {
            return null;
        }
        String code = branchCode.trim();
        if (branches.findByOrganization(organization).stream().noneMatch(b -> b.getCode().equalsIgnoreCase(code))) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, code + " is not a branch of " + organization);
        }
        return code;
    }

    private static UserView view(AppUser u) {
        return new UserView(u.getId(), u.getEmail(), u.getName(), u.getRole(), u.getOrganization(), u.getBranchCode(), u.isActive());
    }
}
