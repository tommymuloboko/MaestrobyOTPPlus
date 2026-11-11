package com.maestro.fuelorder.audit;

import com.maestro.fuelorder.auth.AuthFilter;
import com.maestro.fuelorder.auth.AuthService;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.core.annotation.Order;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

import java.io.IOException;
import java.util.Set;

/** Writes one audit row for every state-changing request, whatever its outcome. */
@Component
@Order(20)
public class AuditFilter extends OncePerRequestFilter {

    private static final Logger log = LoggerFactory.getLogger(AuditFilter.class);
    private static final Set<String> AUDITED = Set.of("POST", "PUT", "PATCH", "DELETE");

    private final AuditLogRepository repo;

    public AuditFilter(AuditLogRepository repo) {
        this.repo = repo;
    }

    @Override
    protected boolean shouldNotFilter(HttpServletRequest request) {
        return !request.getRequestURI().startsWith("/api/") || !AUDITED.contains(request.getMethod());
    }

    @Override
    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response,
                                    FilterChain chain) throws ServletException, IOException {
        try {
            chain.doFilter(request, response);
        } finally {
            try {
                AuthService.Session s = (AuthService.Session) request.getAttribute(AuthFilter.SESSION_ATTR);
                repo.save(new AuditLog(s == null ? "anonymous" : s.email(), s == null ? null : s.role(),
                        s == null ? null : s.organization(), request.getMethod(), request.getRequestURI(),
                        response.getStatus(), request.getRemoteAddr()));
            } catch (RuntimeException e) {
                // auditing must never break the request itself
                log.warn("Could not write audit log: {}", e.getMessage());
            }
        }
    }
}
