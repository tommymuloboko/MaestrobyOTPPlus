package com.maestro.fuelorder.auth;

import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import jakarta.servlet.http.HttpServletRequest;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.server.ResponseStatusException;

@RestController
@RequestMapping("/api/v1/auth")
public class AuthController {

    public record LoginRequest(@NotBlank String email, @NotBlank String password) {}

    private final AuthService auth;

    public AuthController(AuthService auth) {
        this.auth = auth;
    }

    @PostMapping("/login")
    public AuthService.Session login(@RequestBody @Valid LoginRequest req) {
        try {
            return auth.login(req.email(), req.password())
                    .orElseThrow(() -> new ResponseStatusException(
                            HttpStatus.UNAUTHORIZED, "Invalid email or password"));
        } catch (AuthService.LockedOutException e) {
            throw new ResponseStatusException(HttpStatus.TOO_MANY_REQUESTS, e.getMessage());
        }
    }

    @GetMapping("/me")
    public AuthService.Session me(HttpServletRequest request) {
        return (AuthService.Session) request.getAttribute(AuthFilter.SESSION_ATTR);
    }

    @PostMapping("/logout")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    public void logout(HttpServletRequest request) {
        AuthService.Session s = (AuthService.Session) request.getAttribute(AuthFilter.SESSION_ATTR);
        if (s != null) {
            auth.logout(s.token());
        }
    }
}
