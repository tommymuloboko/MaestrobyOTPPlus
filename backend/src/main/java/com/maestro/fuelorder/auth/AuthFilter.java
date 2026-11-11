package com.maestro.fuelorder.auth;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.core.annotation.Order;
import org.springframework.http.MediaType;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.util.Optional;

/** Requires a valid Bearer token on every /api/ call except login (and CORS preflight). */
@Component
@Order(10)
public class AuthFilter extends OncePerRequestFilter {

    public static final String SESSION_ATTR = "maestro.session";

    private final AuthService auth;

    public AuthFilter(AuthService auth) {
        this.auth = auth;
    }

    @Override
    protected boolean shouldNotFilter(HttpServletRequest request) {
        String path = request.getRequestURI();
        return !path.startsWith("/api/")
                || path.equals("/api/v1/auth/login")
                || "OPTIONS".equalsIgnoreCase(request.getMethod());
    }

    @Override
    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response,
                                    FilterChain chain) throws ServletException, IOException {
        String header = request.getHeader("Authorization");
        Optional<AuthService.Session> session = Optional.empty();
        if (header != null && header.startsWith("Bearer ")) {
            session = auth.authenticate(header.substring(7));
        }
        if (session.isEmpty()) {
            response.setStatus(HttpServletResponse.SC_UNAUTHORIZED);
            response.setContentType(MediaType.APPLICATION_PROBLEM_JSON_VALUE);
            response.setCharacterEncoding(StandardCharsets.UTF_8.name());
            response.getWriter().write(
                    "{\"title\":\"Unauthorized\",\"status\":401,\"detail\":\"Sign in required\"}");
            return;
        }
        request.setAttribute(SESSION_ATTR, session.get());
        chain.doFilter(request, response);
    }
}
