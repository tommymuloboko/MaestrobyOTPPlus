package com.maestro.fuelorder.auth;

import com.maestro.fuelorder.org.AppUser;
import com.maestro.fuelorder.org.AppUserRepository;
import org.springframework.stereotype.Service;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayDeque;
import java.util.Base64;
import java.util.Deque;
import java.util.HexFormat;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Walking-skeleton authentication: database users and opaque in-memory session tokens.
 * Production replaces this with the Spring Cloud Gateway + Spring Security tier
 * (argon2id passwords, JWT, MFA, Redis-backed sessions).
 */
@Service
public class AuthService {

    public record Session(String token, String email, String name, String role,
                          String organization, Instant expiresAt) {}

    private static final Duration SESSION_TTL = Duration.ofHours(8);
    private static final int MAX_FAILURES = 5;
    private static final Duration LOCKOUT_WINDOW = Duration.ofMinutes(10);
    private static final String SALT = "maestro-demo-salt";

    private final AppUserRepository users;
    private final Map<String, Session> sessions = new ConcurrentHashMap<>();
    private final Map<String, Deque<Instant>> failures = new ConcurrentHashMap<>();
    private final SecureRandom random = new SecureRandom();

    public AuthService(AppUserRepository users) {
        this.users = users;
    }

    public static class LockedOutException extends RuntimeException {
        public LockedOutException() {
            super("Too many failed attempts. Try again in a few minutes.");
        }
    }

    public Optional<Session> login(String email, String password) {
        String key = email.trim().toLowerCase();
        if (isLockedOut(key)) {
            throw new LockedOutException();
        }
        Optional<AppUser> user = users.findByEmailIgnoreCase(key).filter(AppUser::isActive);
        // always hash so response time doesn't reveal whether the account exists
        String candidate = hashPassword(password);
        boolean ok = user.map(u -> u.passwordMatches(candidate)).orElse(false);
        if (!ok) {
            recordFailure(key);
            return Optional.empty();
        }
        failures.remove(key);
        AppUser u = user.get();
        byte[] raw = new byte[32];
        random.nextBytes(raw);
        String token = Base64.getUrlEncoder().withoutPadding().encodeToString(raw);
        Session session = new Session(token, key, u.getName(), u.getRole(), u.getOrganization(),
                Instant.now().plus(SESSION_TTL));
        sessions.put(token, session);
        return Optional.of(session);
    }

    public Optional<Session> authenticate(String token) {
        Session s = sessions.get(token);
        if (s == null) {
            return Optional.empty();
        }
        if (Instant.now().isAfter(s.expiresAt())) {
            sessions.remove(token);
            return Optional.empty();
        }
        return Optional.of(s);
    }

    public void logout(String token) {
        sessions.remove(token);
    }

    /** Ends every live session of a user, so deleting, deactivating or changing an account takes effect at once. */
    public void revokeSessions(String email) {
        sessions.values().removeIf(s -> s.email().equalsIgnoreCase(email));
    }

    private boolean isLockedOut(String key) {
        Deque<Instant> attempts = failures.get(key);
        if (attempts == null) {
            return false;
        }
        synchronized (attempts) {
            Instant cutoff = Instant.now().minus(LOCKOUT_WINDOW);
            while (!attempts.isEmpty() && attempts.peekFirst().isBefore(cutoff)) {
                attempts.pollFirst();
            }
            return attempts.size() >= MAX_FAILURES;
        }
    }

    private void recordFailure(String key) {
        Deque<Instant> attempts = failures.computeIfAbsent(key, k -> new ArrayDeque<>());
        synchronized (attempts) {
            attempts.addLast(Instant.now());
        }
    }

    public static String hashPassword(String value) {
        try {
            MessageDigest md = MessageDigest.getInstance("SHA-256");
            return HexFormat.of().formatHex(md.digest((SALT + value).getBytes(StandardCharsets.UTF_8)));
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }
}
