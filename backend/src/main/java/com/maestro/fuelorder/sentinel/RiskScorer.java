package com.maestro.fuelorder.sentinel;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;

/**
 * Turns a rule hit into a 0-100 risk score. When {@code maestro.sentinel.ai-url} points at the Python
 * sentinel-ai service the score comes from there; if it is unset or unreachable a local heuristic is used,
 * so a dispense is never blocked or delayed by the AI tier being down.
 */
@Component
public class RiskScorer {

    private static final Logger log = LoggerFactory.getLogger(RiskScorer.class);

    private final String aiUrl;
    private final HttpClient http = HttpClient.newBuilder().connectTimeout(Duration.ofMillis(400)).build();

    public RiskScorer(@Value("${maestro.sentinel.ai-url:}") String aiUrl) {
        this.aiUrl = aiUrl;
    }

    public int score(String rule, String severity, int priorEventsForActor) {
        if (!aiUrl.isBlank()) {
            try {
                String body = "{\"rule\":\"%s\",\"severity\":\"%s\",\"priorEvents\":%d}"
                        .formatted(rule, severity, priorEventsForActor);
                HttpResponse<String> r = http.send(HttpRequest.newBuilder(URI.create(aiUrl + "/score"))
                        .timeout(Duration.ofMillis(800)).header("Content-Type", "application/json")
                        .POST(HttpRequest.BodyPublishers.ofString(body)).build(), HttpResponse.BodyHandlers.ofString());
                if (r.statusCode() == 200) {
                    var m = java.util.regex.Pattern.compile("\"score\"\\s*:\\s*(\\d+)").matcher(r.body());
                    if (m.find()) {
                        return Math.min(100, Integer.parseInt(m.group(1)));
                    }
                }
            } catch (Exception e) {
                log.warn("sentinel-ai unavailable, using local scoring: {}", e.getMessage());
            }
        }
        return local(severity, priorEventsForActor);
    }

    static int local(String severity, int priorEventsForActor) {
        int base = switch (severity) {
            case RiskEvent.CRITICAL -> 90;
            case RiskEvent.HIGH -> 70;
            case RiskEvent.MEDIUM -> 40;
            default -> 20;
        };
        return Math.min(100, base + Math.min(10, priorEventsForActor * 5));
    }
}
