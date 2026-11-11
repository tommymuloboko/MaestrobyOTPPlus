package com.maestro.fuelorder;

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.test.context.SpringBootTest;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/**
 * The rules the platform exists to guarantee, checked over real HTTP against the running application:
 * rejected orders never get an OTP, an OTP cannot exceed its authorised litres, and a redeemed OTP can never be reused.
 */
@SpringBootTest(
        webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT,
        properties = {"maestro.mqtt.enabled=false", "maestro.rate-limit.per-minute=0", "maestro.rate-limit.login-per-minute=0"})
class WorkflowInvariantsTest {

    private static final String PASSWORD = "Maestro#2026";

    @Value("${local.server.port}")
    int port;

    private final HttpClient http = HttpClient.newHttpClient();
    private final JsonMapper json = JsonMapper.builder().build();

    private record Reply(int status, JsonNode body) {}

    private Reply call(String method, String path, String token, Object body) throws Exception {
        HttpRequest.Builder b = HttpRequest.newBuilder(URI.create("http://localhost:" + port + "/api/v1" + path))
                .header("Content-Type", "application/json");
        if (token != null) {
            b.header("Authorization", "Bearer " + token);
        }
        b.method(method, body == null ? HttpRequest.BodyPublishers.noBody()
                : HttpRequest.BodyPublishers.ofString(json.writeValueAsString(body)));
        HttpResponse<String> r = http.send(b.build(), HttpResponse.BodyHandlers.ofString());
        return new Reply(r.statusCode(), r.body().isBlank() ? json.createObjectNode() : json.readTree(r.body()));
    }

    private String login(String email) throws Exception {
        Reply r = call("POST", "/auth/login", null, Map.of("email", email, "password", PASSWORD));
        assertEquals(200, r.status());
        return r.body().get("token").asText();
    }

    private JsonNode newOrder(String customerToken, int litres) throws Exception {
        Reply r = call("POST", "/orders", customerToken, Map.of(
                "siteCode", "SITE-JHB-001", "fuelProduct", "DIESEL_50", "quantityLitres", litres,
                "vehicleReg", "CA 123-456", "driverName", "S. Dlamini"));
        assertTrue(r.status() == 200 || r.status() == 201, "order created, got " + r.status());
        return r.body();
    }

    @Test
    void rejectedOrderNeverGetsAnOtp() throws Exception {
        String acme = login("fleet@acme.test");
        String supplier = login("supplier@mainline.test");
        JsonNode order = newOrder(acme, 30);

        assertEquals(200, call("POST", "/orders/" + order.get("id").asText() + "/reject", supplier,
                Map.of("reason", "Out of credit terms")).status());
        Reply approveAfterReject = call("POST", "/orders/" + order.get("id").asText() + "/approve", supplier, null);

        assertTrue(approveAfterReject.status() >= 400, "a rejected order must not be approvable");
        assertFalse(approveAfterReject.body().has("otp"));
    }

    @Test
    void customersCannotApproveTheirOwnOrders() throws Exception {
        String acme = login("fleet@acme.test");
        JsonNode order = newOrder(acme, 20);

        assertEquals(403, call("POST", "/orders/" + order.get("id").asText() + "/approve", acme, null).status());
    }

    @Test
    void otpCannotBeOverdrawnAndCannotBeReused() throws Exception {
        String acme = login("fleet@acme.test");
        String supplier = login("supplier@mainline.test");
        String attendant = login("attendant@mainline.test");
        JsonNode order = newOrder(acme, 50);
        Reply approved = call("POST", "/orders/" + order.get("id").asText() + "/approve", supplier, null);
        assertEquals(200, approved.status());
        String otp = approved.body().get("otp").asText();
        assertNotNull(otp);

        Reply wrongPin = call("POST", "/dispense/validate", attendant, Map.of("otp", otp, "driverPin", "0000"));
        assertTrue(wrongPin.status() >= 400, "a wrong driver PIN must be refused");

        Reply overLimit = call("POST", "/dispense/complete", attendant,
                Map.of("otp", otp, "driverPin", "1234", "volumeLitres", 80));
        assertTrue(overLimit.status() >= 400, "dispensing more than authorised must be refused");

        Reply ok = call("POST", "/dispense/complete", attendant,
                Map.of("otp", otp, "driverPin", "1234", "volumeLitres", 49.5));
        assertEquals(200, ok.status());

        Reply reuse = call("POST", "/dispense/complete", attendant,
                Map.of("otp", otp, "driverPin", "1234", "volumeLitres", 1));
        assertTrue(reuse.status() >= 400, "a redeemed OTP must never work twice");
    }

    @Test
    void deliveryLifecycleExposesTrackAndProofOfDelivery() throws Exception {
        String supplier = login("supplier@mainline.test");
        Reply planned = call("POST", "/deliveries", supplier, Map.ofEntries(
                Map.entry("originSiteCode", "SITE-JHB-001"), Map.entry("destinationType", "SITE"),
                Map.entry("destinationSiteCode", "SITE-CPT-002"), Map.entry("product", "DIESEL_50"),
                Map.entry("plannedLitres", 5000), Map.entry("truckReg", "GP 900-001"),
                Map.entry("driverName", "T. Nkosi")));
        assertEquals(201, planned.status());
        String id = planned.body().get("id").asText();

        assertEquals(200, call("POST", "/deliveries/" + id + "/load", supplier,
                Map.of("loadedLitres", 5000, "sealNumbers", "S1")).status());
        assertEquals(200, call("POST", "/deliveries/" + id + "/depart", supplier, null).status());
        assertEquals(200, call("POST", "/deliveries/" + id + "/gps", supplier,
                Map.of("lat", -33.9249, "lng", 18.4241, "speedKph", 5)).status());
        assertEquals(200, call("POST", "/deliveries/" + id + "/offload", supplier,
                Map.of("deliveredLitres", 4990)).status());
        assertEquals(200, call("POST", "/deliveries/" + id + "/pod", supplier,
                Map.of("signedBy", "J. Smith", "notes", "ok")).status());

        Reply detail = call("GET", "/deliveries/" + id, supplier, null);
        assertEquals(200, detail.status(), "delivery detail must load: " + detail.body());
        assertTrue(detail.body().get("track").size() >= 1, "GPS track must be returned");
        assertEquals(1, detail.body().get("proof").size());

        Reply tankDeliveries = call("GET", "/deliveries/tank-deliveries", supplier, null);
        assertEquals(200, tankDeliveries.status(), "tank deliveries must load: " + tankDeliveries.body());
        assertTrue(tankDeliveries.body().size() >= 1);
    }

    @Test
    void customersCannotSeeAnotherCustomersOrders() throws Exception {
        String acme = login("fleet@acme.test");
        String build = login("fleet@buildco.test");
        JsonNode order = newOrder(acme, 25);

        Reply list = call("GET", "/orders", build, null);
        assertEquals(200, list.status());
        for (JsonNode o : list.body()) {
            assertFalse(o.get("id").asText().equals(order.get("id").asText()), "BuildCo must not see Acme's order");
        }
    }
}
