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
import java.time.Instant;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** Facilities Management: the OMC Administrator registers sites by the ID of their PTS-2 controller. */
@SpringBootTest(
        webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT,
        properties = {"maestro.mqtt.enabled=false", "maestro.rate-limit.per-minute=0", "maestro.rate-limit.login-per-minute=0"})
class SiteManagementTest {

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

    private static String unique() {
        return String.valueOf(System.nanoTime() % 100_000_000L);
    }

    private static Map<String, Object> site(String pts2Id, String code) {
        return Map.of("name", "Test Station " + unique(), "kind", "STATION", "pts2Id", pts2Id, "code", code,
                "latitude", -25.7479, "longitude", 28.2293,
                "tanks", List.of(Map.of("product", "DIESEL_50", "capacityLitres", 20000, "reorderLitres", 4000, "openingLitres", 12000)));
    }

    private static JsonNode find(JsonNode list, String code) {
        for (JsonNode s : list) {
            if (s.get("code").asText().equals(code)) {
                return s;
            }
        }
        return null;
    }

    @Test
    void omcRegistersASiteByItsPts2IdAndItsTanksAppear() throws Exception {
        String omc = login("omc@mainline.test");
        String n = unique();
        String pts2 = "ab12 cd34 " + n;
        String code = "TST-" + n;

        Reply created = call("POST", "/sites", omc, site(pts2, code));
        assertEquals(201, created.status(), created.body().toString());
        assertEquals(code, created.body().get("code").asText());
        assertEquals(("AB12CD34" + n), created.body().get("pts2Id").asText(), "the ID is stored without spaces, in upper case");

        JsonNode listed = find(call("GET", "/sites", omc, null).body(), code);
        assertTrue(listed != null, "the new site is in the site list");

        boolean hasTank = false;
        for (JsonNode level : call("GET", "/stock", omc, null).body()) {
            if (level.get("siteCode").asText().equals(code) && level.get("product").asText().equals("DIESEL_50")) {
                hasTank = true;
                assertEquals(20000, level.get("capacityLitres").asInt());
                assertEquals(12000, level.get("bookLitres").asInt());
            }
        }
        assertTrue(hasTank, "the tank configured with the site is reported in the stock levels");
    }

    @Test
    void aSiteCodeIsGeneratedWhenNoneIsGiven() throws Exception {
        String omc = login("omc@mainline.test");
        Reply r = call("POST", "/sites", omc, Map.of("name", "Auto Code Depot " + unique(), "kind", "DEPOT", "pts2Id", "AUTO" + unique(),
                "latitude", -26.0, "longitude", 28.0));
        assertEquals(201, r.status(), r.body().toString());
        assertTrue(r.body().get("code").asText().startsWith("SITE-"), r.body().toString());
    }

    @Test
    void aPts2ControllerAndASiteCodeCanOnlyBeRegisteredOnce() throws Exception {
        String omc = login("omc@mainline.test");
        String n = unique();
        assertEquals(201, call("POST", "/sites", omc, site("DUP" + n, "DUP-" + n)).status());

        Reply samePts2 = call("POST", "/sites", omc, site("dup" + n, "DUP2-" + n));
        assertEquals(409, samePts2.status(), "the same controller cannot belong to two sites");
        assertTrue(samePts2.body().get("detail").asText().contains("PTS-2"));

        Reply sameCode = call("POST", "/sites", omc, site("OTHER" + n, "DUP-" + n));
        assertEquals(409, sameCode.status(), "a site code is unique");
    }

    @Test
    void invalidSitesAreRejected() throws Exception {
        String omc = login("omc@mainline.test");
        String n = unique();
        assertEquals(400, call("POST", "/sites", omc, site("ab", "BAD-" + n)).status(), "too short to be a controller ID");
        assertEquals(400, call("POST", "/sites", omc, site("has spaces and $ymbols!", "BAD2-" + n)).status());

        Map<String, Object> badKind = Map.of("name", "X " + n, "kind", "WAREHOUSE", "pts2Id", "KIND" + n, "latitude", 1.0, "longitude", 1.0);
        assertEquals(400, call("POST", "/sites", omc, badKind).status());

        Map<String, Object> noCoords = Map.of("name", "X " + n, "kind", "STATION", "pts2Id", "COORD" + n);
        assertEquals(400, call("POST", "/sites", omc, noCoords).status(), "coordinates are needed to confirm a truck has arrived");

        Map<String, Object> badTank = Map.of("name", "X " + n, "kind", "STATION", "pts2Id", "TANK" + n, "latitude", 1.0, "longitude", 1.0,
                "tanks", List.of(Map.of("product", "DIESEL_50", "capacityLitres", 1000, "reorderLitres", 5000)));
        assertEquals(400, call("POST", "/sites", omc, badTank).status(), "the reorder level cannot exceed the capacity");

        Map<String, Object> unknownProduct = Map.of("name", "X " + n, "kind", "STATION", "pts2Id", "PROD" + n, "latitude", 1.0, "longitude", 1.0,
                "tanks", List.of(Map.of("product", "WATER", "capacityLitres", 1000, "reorderLitres", 100)));
        assertEquals(400, call("POST", "/sites", omc, unknownProduct).status());
    }

    @Test
    void onlyTheOmcCanAddSitesAndCustomersNeverSeeControllerIds() throws Exception {
        String n = unique();
        assertEquals(403, call("POST", "/sites", login("fleet@acme.test"), site("CUST" + n, "CUST-" + n)).status());
        assertEquals(403, call("POST", "/sites", login("attendant@mainline.test"), site("ATT" + n, "ATT-" + n)).status());
        assertEquals(403, call("POST", "/sites", login("supplier@mainline.test"), site("MGR" + n, "MGR-" + n)).status());

        String omc = login("omc@mainline.test");
        assertEquals(201, call("POST", "/sites", omc, site("VIS" + n, "VIS-" + n)).status());

        JsonNode seenByCustomer = find(call("GET", "/sites", login("fleet@acme.test"), null).body(), "VIS-" + n);
        assertTrue(seenByCustomer != null, "customers can order at the new site");
        assertTrue(seenByCustomer.get("pts2Id").isNull(), "but the controller ID is for staff only");

        JsonNode seenByStaff = find(call("GET", "/sites", login("supplier@mainline.test"), null).body(), "VIS-" + n);
        assertEquals("VIS" + n, seenByStaff.get("pts2Id").asText());
    }

    @Test
    void telemetryReportedUnderThePts2IdIsAttributedToItsSite() throws Exception {
        String omc = login("omc@mainline.test");
        String n = unique();
        String pts2 = "TEL" + n;
        String code = "TEL-" + n;
        assertEquals(201, call("POST", "/sites", omc, site(pts2, code)).status());

        Instant ts = Instant.now();
        Reply posted = call("POST", "/telemetry/tank", omc, Map.of("siteCode", pts2, "product", "DIESEL_50", "volumeL", 11950,
                "tempC", 22.5, "ts", ts.toString()));
        assertEquals(200, posted.status(), posted.body().toString());

        boolean attributed = false;
        for (JsonNode r : call("GET", "/telemetry/tanks", omc, null).body()) {
            if (r.get("siteCode").asText().equals(code) && r.get("volumeLitres").asInt() == 11950) {
                attributed = true;
            }
            assertFalse(r.get("siteCode").asText().equals(pts2), "no reading is stored under the raw controller ID");
        }
        assertTrue(attributed, "the reading is stored against the site code");
    }

    @Test
    void ordersAndDeliveriesWorkAtANewSite() throws Exception {
        String omc = login("omc@mainline.test");
        String n = unique();
        String code = "NEW-" + n;
        assertEquals(201, call("POST", "/sites", omc, site("NEW" + n, code)).status());

        Reply delivery = call("POST", "/deliveries", login("supplier@mainline.test"), Map.of("originSiteCode", "SITE-JHB-001",
                "destinationType", "SITE", "destinationSiteCode", code, "product", "DIESEL_50", "plannedLitres", 500,
                "truckReg", "TRK-" + n, "driverName", "Test Driver"));
        assertEquals(201, delivery.status(), delivery.body().toString());
        assertEquals(-25.7479, delivery.body().get("destLat").asDouble(), 0.0001, "the truck is checked against the site's coordinates");
    }
}
