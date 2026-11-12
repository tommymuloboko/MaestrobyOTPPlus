package com.maestro.fuelorder;

import com.sun.net.httpserver.HttpServer;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.test.context.SpringBootTest;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;
import tools.jackson.databind.node.ArrayNode;
import tools.jackson.databind.node.ObjectNode;

import java.net.InetSocketAddress;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.HexFormat;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** Live tanks pulled from a PTS-2: a fake controller speaking jsonPTS behind HTTP Digest auth, like the real one. */
@SpringBootTest(
        webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT,
        properties = {"maestro.mqtt.enabled=false", "maestro.rate-limit.per-minute=0", "maestro.rate-limit.login-per-minute=0",
                "maestro.pts2.initial-delay-ms=3600000"})
class Pts2ConnectionTest {

    private static final String PASSWORD = "Maestro#2026";
    private static final String SITE = "SITE-JHB-001";
    private static final String REALM = "PTS-2";
    private static final String NONCE = "abc123";

    @Value("${local.server.port}")
    int port;

    private final HttpClient http = HttpClient.newHttpClient();
    private final JsonMapper json = JsonMapper.builder().build();
    private HttpServer pts2;
    private volatile String pts2Password = "secret";
    /** The fake controller's fuel grade prices and prices scheduler, as the API last wrote them. */
    private final Map<Integer, java.math.BigDecimal> gradePrices = new java.util.concurrent.ConcurrentHashMap<>(
            Map.of(1, new java.math.BigDecimal("21.50"), 2, new java.math.BigDecimal("19.90")));
    private volatile JsonNode priceSchedules;
    /** The fake controller's clock runs 2 hours ahead of the API, like a station at UTC+2 and a VPS on UTC. */
    private static final int STATION_AHEAD_HOURS = 2;
    private static java.time.LocalDateTime stationNow() {
        return java.time.LocalDateTime.now().plusHours(STATION_AHEAD_HOURS).withNano(0);
    }

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

    private static String md5(String s) throws Exception {
        return HexFormat.of().formatHex(MessageDigest.getInstance("MD5").digest(s.getBytes(StandardCharsets.UTF_8)));
    }

    /** Checks a Digest Authorization header the way the controller does. */
    private boolean authorized(String header) throws Exception {
        if (header == null || !header.startsWith("Digest ")) {
            return false;
        }
        Map<String, String> p = new java.util.HashMap<>();
        Matcher m = Pattern.compile("(\\w+)=(?:\"([^\"]*)\"|([^,\\s]+))").matcher(header.substring(7));
        while (m.find()) {
            p.put(m.group(1), m.group(2) != null ? m.group(2) : m.group(3));
        }
        String ha1 = md5("admin:" + REALM + ":" + pts2Password);
        String ha2 = md5("POST:" + p.get("uri"));
        String expected = md5(ha1 + ":" + NONCE + ":" + p.get("nc") + ":" + p.get("cnonce") + ":auth:" + ha2);
        return NONCE.equals(p.get("nonce")) && expected.equals(p.get("response"));
    }

    @BeforeEach
    void startFakeController() throws Exception {
        pts2 = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        pts2.createContext("/jsonPTS", ex -> {
            try {
                if (!authorized(ex.getRequestHeaders().getFirst("Authorization"))) {
                    ex.getResponseHeaders().add("WWW-Authenticate",
                            "Digest realm=\"" + REALM + "\", qop=\"auth\", nonce=\"" + NONCE + "\", algorithm=MD5");
                    ex.sendResponseHeaders(401, -1);
                    return;
                }
                JsonNode req = json.readTree(ex.getRequestBody().readAllBytes());
                ObjectNode res = json.createObjectNode().put("Protocol", "jsonPTS");
                ArrayNode out = res.putArray("Packets");
                for (JsonNode p : req.path("Packets")) {
                    ObjectNode r = out.addObject().put("Id", p.path("Id").asInt());
                    ObjectNode d = r.putObject("Data");
                    switch (p.path("Type").asText()) {
                        case "GetUniqueIdentifier" -> { r.put("Type", "UniqueIdentifier"); d.put("Id", "003A003A3435510938393730"); }
                        case "GetProbesConfiguration" -> {
                            r.put("Type", "ProbesConfiguration");
                            d.putArray("Probes").add(json.createObjectNode().put("Id", 1)).add(json.createObjectNode().put("Id", 2));
                        }
                        case "GetTanksConfiguration" -> {
                            r.put("Type", "TanksConfiguration");
                            d.putArray("Tanks").add(json.createObjectNode().put("Id", 1).put("FuelGradeId", 2).put("Height", 2500))
                                    .add(json.createObjectNode().put("Id", 2).put("FuelGradeId", 1).put("Height", 2000));
                        }
                        case "GetFuelGradesConfiguration" -> {
                            r.put("Type", "FuelGradesConfiguration");
                            d.putArray("FuelGrades").add(json.createObjectNode().put("Id", 1).put("Name", "ULP 95").put("Price", gradePrices.get(1)))
                                    .add(json.createObjectNode().put("Id", 2).put("Name", "Diesel 50").put("Price", gradePrices.get(2)));
                        }
                        case "SetFuelGradesPrices" -> {
                            // like the controller: grades left out of the list are cleared
                            gradePrices.replaceAll((k, v) -> java.math.BigDecimal.ZERO);
                            p.path("Data").path("FuelGradesPrices").forEach(g ->
                                    gradePrices.put(g.path("FuelGradeId").asInt(), g.path("Price").decimalValue()));
                            r.put("Type", "SetFuelGradesPrices").put("Message", "OK");
                        }
                        case "GetPricesSchedulerConfiguration" -> {
                            r.put("Type", "PricesSchedulerConfiguration");
                            d.set("PriceSchedules", priceSchedules == null ? json.createArrayNode() : priceSchedules);
                        }
                        case "GetDateTime" -> {
                            r.put("Type", "DateTime");
                            d.put("DateTime", stationNow().toString().length() == 16 ? stationNow() + ":00" : stationNow().toString())
                                    .put("AutoSynchronize", false).put("UTCOffset", 120);
                        }
                        case "SetPricesSchedulerConfiguration" -> {
                            priceSchedules = p.path("Data").path("PriceSchedules");
                            r.put("Type", "SetPricesSchedulerConfiguration").put("Message", "OK");
                        }
                        case "ProbeGetMeasurements" -> {
                            int probe = p.path("Data").path("Probe").asInt();
                            r.put("Type", "ProbeMeasurements");
                            d.put("Probe", probe).put("DateTime", "2026-11-12T08:30:00").put("Status", "OK")
                                    .put("ProductHeight", probe == 1 ? 1534.1 : 400.0).put("WaterHeight", 12.5)
                                    .put("Temperature", 21.3).put("ProductVolume", probe == 1 ? 21451 : 3000)
                                    .put("ProductVolumeFloat", probe == 1 ? 21451.34 : 3000.0)
                                    .put("ProductUllage", probe == 1 ? 8548 : 17000).put("ProductUllageFloat", probe == 1 ? 8548.66 : 17000.0)
                                    .put("TankFillingPercentage", probe == 1 ? 72 : 15);
                            if (probe == 2) {
                                d.putArray("Alarms").add("LowProduct");
                            }
                        }
                        default -> { r.put("Error", true); r.put("Message", "JSONPTS_ERROR_NOT_FOUND"); }
                    }
                }
                byte[] bytes = json.writeValueAsBytes(res);
                ex.getResponseHeaders().add("Content-Type", "application/json");
                ex.sendResponseHeaders(200, bytes.length);
                ex.getResponseBody().write(bytes);
            } catch (Exception e) {
                ex.sendResponseHeaders(500, -1);
            } finally {
                ex.close();
            }
        });
        pts2.start();
    }

    @AfterEach
    void stopFakeController() {
        pts2.stop(0);
    }

    private String fakeUrl() {
        return "http://127.0.0.1:" + pts2.getAddress().getPort();
    }

    @Test
    void omcConnectsAPts2AndItsLiveTanksAppear() throws Exception {
        String omc = login("omc@mainline.test");
        Reply saved = call("PUT", "/pts2/connections/" + SITE, omc,
                Map.of("url", fakeUrl(), "username", "admin", "password", "secret", "enabled", true));
        assertEquals(200, saved.status(), saved.body().toString());
        assertEquals(fakeUrl() + "/jsonPTS", saved.body().get("url").asText(), "the jsonPTS path is added");
        assertTrue(saved.body().get("ok").asBoolean(), "the first poll succeeds: " + saved.body());
        assertEquals("003A003A3435510938393730", saved.body().get("controllerId").asText());
        assertFalse(saved.body().has("password"), "the password is never returned");

        Reply live = call("GET", "/pts2/tanks", omc, null);
        JsonNode site = null;
        for (JsonNode s : live.body()) {
            if (s.get("siteCode").asText().equals(SITE)) site = s;
        }
        assertNotNull(site);
        assertEquals(2, site.get("tanks").size());
        JsonNode diesel = site.get("tanks").get(0);
        assertEquals("DIESEL_50", diesel.get("product").asText(), "the product comes from the tank's fuel grade");
        assertEquals(0, diesel.get("volumeLitres").decimalValue().compareTo(new java.math.BigDecimal("21451.34")));
        assertEquals(0, diesel.get("capacityLitres").decimalValue().compareTo(new java.math.BigDecimal("30000.00")));
        assertEquals(72, diesel.get("percent").asInt());
        assertEquals("LowProduct", site.get("tanks").get(1).get("alarms").get(0).asText());

        boolean recorded = false;
        for (JsonNode r : call("GET", "/telemetry/tanks", omc, null).body()) {
            if (r.get("siteCode").asText().equals(SITE) && r.get("product").asText().equals("DIESEL_50")) recorded = true;
        }
        assertTrue(recorded, "each reading is also stored as ATG telemetry");

        // a blank password keeps the stored one
        Reply edited = call("PUT", "/pts2/connections/" + SITE, omc, Map.of("url", fakeUrl(), "username", "admin", "password", ""));
        assertTrue(edited.body().get("ok").asBoolean(), edited.body().toString());

        // wrong credentials are reported, and the last good tanks stay visible
        pts2Password = "changed";
        Reply test = call("POST", "/pts2/connections/" + SITE + "/test", omc, null);
        assertEquals(200, test.status());
        assertFalse(test.body().get("ok").asBoolean());
        assertTrue(test.body().get("error").asText().contains("username or password"), test.body().toString());
        assertEquals(2, test.body().get("tanks").size());

        assertEquals(204, call("DELETE", "/pts2/connections/" + SITE, omc, null).status());
    }

    @Test
    void onlyTheOmcOrAdminConfiguresAndCustomersSeeNothing() throws Exception {
        String customer = login("fleet@acme.test");
        String supplier = login("supplier@mainline.test");
        Map<String, Object> body = Map.of("url", fakeUrl(), "username", "admin", "password", "secret");
        assertEquals(403, call("PUT", "/pts2/connections/" + SITE, supplier, body).status());
        assertEquals(403, call("PUT", "/pts2/connections/" + SITE, customer, body).status());
        assertEquals(403, call("GET", "/pts2/tanks", customer, null).status());
        assertEquals(200, call("GET", "/pts2/tanks", supplier, null).status());

        String omc = login("omc@mainline.test");
        Reply unknown = call("PUT", "/pts2/connections/NO-SUCH-SITE", omc, body);
        assertEquals(400, unknown.status());
        Reply badUrl = call("PUT", "/pts2/connections/" + SITE, omc, Map.of("url", "ftp://x", "username", "admin", "password", "x"));
        assertEquals(400, badUrl.status());
    }

    @Test
    void omcChangesPumpPricesNowOrSchedulesThem() throws Exception {
        String omc = login("omc@mainline.test");
        assertEquals(200, call("PUT", "/pts2/connections/" + SITE, omc,
                Map.of("url", fakeUrl(), "username", "admin", "password", "secret")).status());

        Reply prices = call("GET", "/pts2/prices/" + SITE, omc, null);
        assertEquals(200, prices.status(), prices.body().toString());
        assertEquals(2, prices.body().get("grades").size());
        assertEquals(10, prices.body().get("freeSlots").asInt());

        // immediate: only diesel changes, and the other grade keeps its price
        Reply now = call("POST", "/pts2/prices/" + SITE, omc,
                Map.of("changes", java.util.List.of(Map.of("fuelGradeId", 2, "price", 20.45))));
        assertEquals(200, now.status(), now.body().toString());
        assertEquals(0, gradePrices.get(2).compareTo(new java.math.BigDecimal("20.45")));
        assertEquals(0, gradePrices.get(1).compareTo(new java.math.BigDecimal("21.50")), "other grades are not cleared");

        // scheduled: written to the controller's scheduler, prices unchanged until then
        String at = stationNow().plusDays(1).withHour(6).withMinute(0).withSecond(0).toString();
        Reply scheduled = call("POST", "/pts2/prices/" + SITE, omc,
                Map.of("changes", java.util.List.of(Map.of("fuelGradeId", 1, "price", 22.10)), "effectiveAt", at));
        assertEquals(200, scheduled.status(), scheduled.body().toString());
        assertEquals(0, gradePrices.get(1).compareTo(new java.math.BigDecimal("21.50")));
        JsonNode slot = priceSchedules.get(0);
        assertEquals(1, slot.get("FuelGradeId").asInt());
        assertTrue(slot.get("Enabled").asBoolean());
        assertEquals(at.length() == 16 ? at + ":00" : at, slot.get("DateTime").asText());
        JsonNode listed = scheduled.body().get("schedules").get(0);
        assertTrue(listed.get("pending").asBoolean());
        assertEquals("ULP 95", listed.get("fuelGradeName").asText());
        assertEquals(9, scheduled.body().get("freeSlots").asInt());

        assertTrue(scheduled.body().get("controllerTime").asText().startsWith(stationNow().toString().substring(0, 13)),
                "the station clock is reported: " + scheduled.body().get("controllerTime"));

        // an hour from now on the API's clock has already passed at the station, so it is refused
        String past = java.time.LocalDateTime.now().plusHours(1).withNano(0).toString();
        assertEquals(400, call("POST", "/pts2/prices/" + SITE, omc,
                Map.of("changes", java.util.List.of(Map.of("fuelGradeId", 1, "price", 22)), "effectiveAt", past)).status());
        assertEquals(400, call("POST", "/pts2/prices/" + SITE, omc,
                Map.of("changes", java.util.List.of(Map.of("fuelGradeId", 7, "price", 22)))).status());
        assertEquals(400, call("POST", "/pts2/prices/" + SITE, omc,
                Map.of("changes", java.util.List.of(Map.of("fuelGradeId", 1, "price", 0)))).status());

        // a station manager can see prices but not change them
        String supplier = login("supplier@mainline.test");
        assertEquals(200, call("GET", "/pts2/prices/" + SITE, supplier, null).status());
        assertEquals(403, call("POST", "/pts2/prices/" + SITE, supplier,
                Map.of("changes", java.util.List.of(Map.of("fuelGradeId", 1, "price", 1)))).status());
        assertEquals(403, call("GET", "/pts2/prices/" + SITE, login("fleet@acme.test"), null).status());

        // a schedule whose time the station has passed (but the API's clock has not) has run: not pending
        String ran = java.time.LocalDateTime.now().plusHours(1).withNano(0).toString();
        ((ArrayNode) priceSchedules).add(json.createObjectNode().put("Id", 5).put("Enabled", true).put("FuelGradeId", 2)
                .put("Price", 99.0).put("DateTime", ran.length() == 16 ? ran + ":00" : ran));
        JsonNode ranRow = null;
        for (JsonNode s : call("GET", "/pts2/prices/" + SITE, omc, null).body().get("schedules")) {
            if (s.get("id").asInt() == 5) ranRow = s;
        }
        assertNotNull(ranRow);
        assertFalse(ranRow.get("pending").asBoolean(), "judged by the station clock, the schedule has already run");
        ((ArrayNode) priceSchedules).remove(priceSchedules.size() - 1);

        Reply cancelled = call("DELETE", "/pts2/prices/" + SITE + "/schedules/" + slot.get("Id").asInt(), omc, null);
        assertEquals(200, cancelled.status(), cancelled.body().toString());
        assertEquals(0, priceSchedules.size());

        Reply history = call("GET", "/pts2/prices/" + SITE + "/history", omc, null);
        assertEquals(3, history.body().size());
        assertEquals("CANCELLED", history.body().get(0).get("mode").asText());
        assertEquals(0, history.body().get(2).get("previousPrice").decimalValue().compareTo(new java.math.BigDecimal("19.90")));

        call("DELETE", "/pts2/connections/" + SITE, omc, null);
    }
}
