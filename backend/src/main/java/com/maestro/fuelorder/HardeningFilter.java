package com.maestro.fuelorder;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.core.annotation.Order;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

import java.io.IOException;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicInteger;

/**
 * Baseline protections on every API call: security headers, and a per-client request budget so a single
 * client cannot hammer the API or the login endpoint. The production gateway applies the same policy
 * at the edge; this keeps the skeleton safe on its own.
 */
@Component
@Order(5)
public class HardeningFilter extends OncePerRequestFilter {

    private record Window(long minute, AtomicInteger count) {}

    private final Map<String, Window> windows = new ConcurrentHashMap<>();
    private final int perMinute;
    private final int loginPerMinute;

    public HardeningFilter(@Value("${maestro.rate-limit.per-minute:600}") int perMinute,
                           @Value("${maestro.rate-limit.login-per-minute:30}") int loginPerMinute) {
        this.perMinute = perMinute;
        this.loginPerMinute = loginPerMinute;
    }

    @Override
    protected boolean shouldNotFilter(HttpServletRequest request) {
        return !request.getRequestURI().startsWith("/api/");
    }

    @Override
    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response,
                                    FilterChain chain) throws ServletException, IOException {
        response.setHeader("X-Content-Type-Options", "nosniff");
        response.setHeader("X-Frame-Options", "DENY");
        response.setHeader("Referrer-Policy", "no-referrer");
        response.setHeader("Cache-Control", "no-store");
        response.setHeader("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'");
        if (request.isSecure()) {
            response.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
        }
        boolean login = request.getRequestURI().equals("/api/v1/auth/login");
        int limit = login ? loginPerMinute : perMinute;
        if (limit > 0 && !allow((login ? "login:" : "api:") + request.getRemoteAddr(), limit)) {
            response.setStatus(429);
            response.setHeader("Retry-After", "60");
            response.setContentType("application/problem+json");
            response.getWriter().write("{\"title\":\"Too Many Requests\",\"status\":429,\"detail\":\"Slow down and try again shortly\"}");
            return;
        }
        chain.doFilter(request, response);
    }

    private boolean allow(String key, int limit) {
        long minute = System.currentTimeMillis() / 60_000;
        Window w = windows.compute(key, (k, old) -> old == null || old.minute() != minute
                ? new Window(minute, new AtomicInteger(0)) : old);
        return w.count().incrementAndGet() <= limit;
    }
}
