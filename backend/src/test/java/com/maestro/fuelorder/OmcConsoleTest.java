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
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** The OMC Administrator console: its role, order cancel/amend, OTP management, driver controls and vehicle admin. */
@SpringBootTest(
        webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT,
        properties = {"maestro.mqtt.enabled=false", "maestro.rate-limit.per-minute=0", "maestro.rate-limit.login-per-minute=0"})
class OmcConsoleTest {

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
        return String.valueOf(System.nanoTime() % 10_000_000);
    }

    /** A fresh vehicle (registered by the OMC for Acme) and driver, so these tests never disturb the seeded fleet. */
    private record Fleet(String reg, String driver, String pin) {}

    private Fleet newFleet(String omc, String acme, int tankLitres) throws Exception {
        String reg = "OM" + unique();
        assertEquals(201, call("POST", "/vehicles", omc, Map.of("registration", reg, "description", "Test truck",
                "fuelType", "DIESEL", "tankCapacityLitres", tankLitres, "customerName", "Acme Logistics")).status());
        String name = "Driver " + unique();
        Reply d = call("POST", "/drivers", acme, Map.of("name", name, "phone", "+27 82 555 0188", "vehicleReg", reg));
        assertEquals(201, d.status());
        return new Fleet(reg, name, d.body().get("pin").asText());
    }

    private JsonNode order(String acme, Fleet f, int litres) throws Exception {
        Reply r = call("POST", "/orders", acme, Map.of("siteCode", "SITE-JHB-001", "fuelProduct", "DIESEL_50",
                "quantityLitres", litres, "vehicleReg", f.reg(), "driverName", f.driver()));
        assertEquals(201, r.status(), r.body().toString());
        return r.body();
    }

    private String approve(String token, JsonNode order) throws Exception {
        Reply r = call("POST", "/orders/" + order.get("id").asText() + "/approve", token, null);
        assertEquals(200, r.status(), r.body().toString());
        return r.body().get("otp").asText();
    }

    private Reply dispense(String attendant, String otp, String pin, double litres) throws Exception {
        return call("POST", "/dispense/complete", attendant, Map.of("otp", otp, "driverPin", pin, "volumeLitres", litres));
    }

    private JsonNode otpOf(String omc, JsonNode order) throws Exception {
        for (JsonNode o : call("GET", "/otp", omc, null).body()) {
            if (o.get("orderId").asText().equals(order.get("id").asText())) {
                return o;
            }
        }
        throw new AssertionError("no OTP listed for " + order.get("number").asText());
    }

    @Test
    void omcAdministratorHasTheSupplierNetworkButIsNotThePlatformOperator() throws Exception {
        String omc = login("omc@mainline.test");
        String acme = login("fleet@acme.test");

        JsonNode orgs = call("GET", "/organizations", omc, null).body();
        boolean seesAcme = false;
        for (JsonNode o : orgs) {
            seesAcme |= o.get("name").asText().equals("Acme Logistics");
        }
        assertTrue(seesAcme, "the OMC Administrator sees every customer");

        String n = unique();
        Map<String, Object> customer = Map.ofEntries(
                Map.entry("name", "Omc Test Co " + n), Map.entry("type", "CUSTOMER"), Map.entry("country", "ZA"),
                Map.entry("currency", "ZAR"), Map.entry("contactEmail", "boss" + n + "@omctest.example"),
                Map.entry("adminName", "Test Boss"), Map.entry("creditLimit", 10000), Map.entry("terms", "NET_30"),
                Map.entry("monthlyBudget", 5000));
        assertEquals(201, call("POST", "/organizations", omc, customer).status(), "the OMC onboards customers");

        Map<String, Object> supplier = new java.util.HashMap<>(customer);
        supplier.put("name", "Omc Rival " + n);
        supplier.put("type", "SUPPLIER");
        supplier.put("contactEmail", "rival" + n + "@omctest.example");
        assertEquals(403, call("POST", "/organizations", omc, supplier).status(), "but not another supplier");

        assertEquals(403, call("GET", "/otp", acme, null).status(), "customers cannot see OTP management");
        assertEquals(403, call("GET", "/audit", omc, null).status(), "the audit log stays with the Platform Admin");
    }

    @Test
    void cancellingAnAuthorizedOrderRevokesItsCodeAndNothingElseCanBeCancelled() throws Exception {
        String omc = login("omc@mainline.test");
        String acme = login("fleet@acme.test");
        String attendant = login("attendant@mainline.test");
        Fleet f = newFleet(omc, acme, 200);

        JsonNode o = order(acme, f, 50);
        String otp = approve(omc, o);
        String id = o.get("id").asText();

        assertEquals(403, call("POST", "/orders/" + id + "/cancel", acme, Map.of("reason", "x")).status(),
                "a customer cannot cancel through the supplier endpoint");
        Reply cancelled = call("POST", "/orders/" + id + "/cancel", omc, Map.of("reason", "Customer called to cancel"));
        assertEquals(200, cancelled.status(), cancelled.body().toString());
        assertEquals("CANCELLED", cancelled.body().get("status").asText());

        Reply use = dispense(attendant, otp, f.pin(), 10);
        assertTrue(use.status() >= 400, "the code of a cancelled order must not work");
        assertEquals("REVOKED", otpOf(omc, o).get("status").asText());
        assertEquals(409, call("POST", "/orders/" + id + "/cancel", omc, Map.of("reason", "again")).status(),
                "an order cannot be cancelled twice");

        JsonNode fulfilled = order(acme, f, 20);
        assertEquals(200, dispense(attendant, approve(omc, fulfilled), f.pin(), 20).status());
        assertEquals(409, call("POST", "/orders/" + fulfilled.get("id").asText() + "/cancel", omc, Map.of("reason", "late")).status(),
                "fuel already drawn cannot be cancelled");
    }

    @Test
    void amendingChangesAPendingOrderUnderTheFleetRulesButNotAnAuthorizedOne() throws Exception {
        String omc = login("omc@mainline.test");
        String acme = login("fleet@acme.test");
        Fleet f = newFleet(omc, acme, 100);
        JsonNode o = order(acme, f, 40);
        String id = o.get("id").asText();

        Reply amended = call("PATCH", "/orders/" + id, omc, Map.of("quantityLitres", 70, "destination", "Durban"));
        assertEquals(200, amended.status(), amended.body().toString());
        assertEquals(70, amended.body().get("quantityLitres").asInt());
        assertEquals("Durban", amended.body().get("destination").asText());

        Reply tooBig = call("PATCH", "/orders/" + id, omc, Map.of("quantityLitres", 500));
        assertEquals(400, tooBig.status());
        assertTrue(tooBig.body().get("detail").asText().contains("exceeds"), "the tank limit still applies to an amendment");
        assertEquals(400, call("PATCH", "/orders/" + id, omc, Map.of()).status(), "an empty amendment is refused");
        assertEquals(403, call("PATCH", "/orders/" + id, acme, Map.of("quantityLitres", 10)).status());

        boolean recorded = false;
        for (JsonNode h : call("GET", "/orders/" + id + "/history", omc, null).body()) {
            recorded |= h.get("reason").asText().contains("40 L -> 70 L");
        }
        assertTrue(recorded, "the amendment is in the order history");

        approve(omc, o);
        assertEquals(409, call("PATCH", "/orders/" + id, omc, Map.of("quantityLitres", 20)).status(),
                "once a code is out the order can no longer be amended");
    }

    @Test
    void otpsAreMonitoredRevokedAndRegeneratedWithoutEverExposingOrReusingACode() throws Exception {
        String omc = login("omc@mainline.test");
        String acme = login("fleet@acme.test");
        String attendant = login("attendant@mainline.test");
        Fleet f = newFleet(omc, acme, 200);

        JsonNode o = order(acme, f, 60);
        String oldOtp = approve(omc, o);
        JsonNode listed = otpOf(omc, o);
        assertEquals("ACTIVE", listed.get("status").asText());
        assertEquals(f.reg(), listed.get("vehicleReg").asText());
        assertFalse(listed.toString().contains(oldOtp), "the list must never contain the code");
        assertFalse(listed.has("codeHash"), "nor its hash");
        String id = listed.get("id").asText();

        assertEquals(403, call("POST", "/otp/" + id + "/revoke", acme, Map.of("reason", "x")).status());
        assertEquals(400, call("POST", "/otp/" + id + "/revoke", omc, Map.of()).status(), "a reason is required");
        Reply revoked = call("POST", "/otp/" + id + "/revoke", omc, Map.of("reason", "Driver lost the phone"));
        assertEquals("REVOKED", revoked.body().get("status").asText());
        assertEquals(409, call("POST", "/otp/" + id + "/revoke", omc, Map.of("reason", "again")).status());
        assertTrue(dispense(attendant, oldOtp, f.pin(), 10).status() >= 400, "a revoked code does not work");

        Reply fresh = call("POST", "/otp/" + id + "/regenerate", omc, Map.of("reason", "Issued a replacement"));
        assertEquals(200, fresh.status(), fresh.body().toString());
        String newOtp = fresh.body().get("otp").asText();
        assertNotEquals(oldOtp, newOtp);
        assertEquals("ACTIVE", otpOf(omc, o).get("status").asText());
        assertEquals(404, dispense(attendant, oldOtp, f.pin(), 10).status(), "the old code no longer exists");

        assertEquals(200, dispense(attendant, newOtp, f.pin(), 55).status(), "the replacement works once");
        assertEquals("REDEEMED", otpOf(omc, o).get("status").asText());
        assertEquals(409, call("POST", "/otp/" + id + "/regenerate", omc, Map.of("reason", "after use")).status(),
                "a redeemed authorization can never be reissued");
        assertTrue(dispense(attendant, newOtp, f.pin(), 5).status() >= 400, "and a redeemed code is never reusable");
    }

    @Test
    void aSuspendedDriverCannotBeOrderedForOrRedeemUntilRestored() throws Exception {
        String omc = login("omc@mainline.test");
        String acme = login("fleet@acme.test");
        String attendant = login("attendant@mainline.test");
        Fleet f = newFleet(omc, acme, 200);
        String driverId = null;
        for (JsonNode d : call("GET", "/drivers", omc, null).body()) {
            if (d.get("name").asText().equals(f.driver())) {
                driverId = d.get("id").asText();
                assertFalse(d.get("verified").asBoolean(), "a new driver starts unverified");
                assertFalse(d.toString().toLowerCase().contains("pin\":"), "a PIN is never in the driver listing");
            }
        }

        assertEquals(403, call("POST", "/drivers/" + driverId + "/verify", acme, null).status());
        Reply verified = call("POST", "/drivers/" + driverId + "/verify", omc, null);
        assertTrue(verified.body().get("verified").asBoolean());
        assertEquals("Zodwa Ndlovu", verified.body().get("verifiedBy").asText());

        JsonNode o = order(acme, f, 30);
        String otp = approve(omc, o);
        Reply suspended = call("POST", "/drivers/" + driverId + "/suspend", omc, Map.of("reason", "Licence expired"));
        assertTrue(suspended.body().get("accessSuspended").asBoolean());

        Reply refused = dispense(attendant, otp, f.pin(), 10);
        assertEquals(403, refused.status());
        assertTrue(refused.body().get("detail").asText().contains("Licence expired"));
        Reply blockedOrder = call("POST", "/orders", acme, Map.of("siteCode", "SITE-JHB-001", "fuelProduct", "DIESEL_50",
                "quantityLitres", 20, "vehicleReg", f.reg(), "driverName", f.driver()));
        assertEquals(400, blockedOrder.status());
        assertTrue(blockedOrder.body().get("detail").asText().contains("suspended"));

        assertFalse(call("POST", "/drivers/" + driverId + "/restore", omc, null).body().get("accessSuspended").asBoolean());
        assertEquals(200, dispense(attendant, otp, f.pin(), 25).status(), "restored, the same code works");
    }

    @Test
    void omcManagesVehiclesForCustomersAndSeesTheirFuellingHistory() throws Exception {
        String omc = login("omc@mainline.test");
        String acme = login("fleet@acme.test");
        String buildco = login("fleet@buildco.test");
        String attendant = login("attendant@mainline.test");
        Fleet f = newFleet(omc, acme, 120);

        Reply unknown = call("POST", "/vehicles", omc, Map.of("registration", "ZZ" + unique(), "fuelType", "DIESEL",
                "tankCapacityLitres", 50, "customerName", "No Such Customer"));
        assertEquals(400, unknown.status());
        assertEquals(400, call("POST", "/vehicles", omc, Map.of("registration", "ZZ" + unique(), "fuelType", "DIESEL",
                "tankCapacityLitres", 50)).status(), "the OMC must say which customer");

        String vehicleId = null;
        for (JsonNode v : call("GET", "/vehicles", omc, null).body()) {
            if (v.get("registration").asText().equals(f.reg())) {
                vehicleId = v.get("id").asText();
                assertEquals("Acme Logistics", v.get("organization").asText());
            }
        }
        Reply resized = call("PATCH", "/vehicles/" + vehicleId, omc, Map.of("tankCapacityLitres", 90));
        assertEquals(90, resized.body().get("tankCapacityLitres").asInt());
        Reply tooBig = call("POST", "/orders", acme, Map.of("siteCode", "SITE-JHB-001", "fuelProduct", "DIESEL_50",
                "quantityLitres", 100, "vehicleReg", f.reg(), "driverName", f.driver()));
        assertEquals(400, tooBig.status(), "orders above the new tank size are refused");
        assertEquals(400, call("PATCH", "/vehicles/" + vehicleId, omc, Map.of("tankCapacityLitres", 0)).status());

        assertEquals(200, dispense(attendant, approve(omc, order(acme, f, 40)), f.pin(), 38).status());
        Reply history = call("GET", "/vehicles/" + vehicleId + "/fuelling", omc, null);
        assertEquals(1, history.body().size());
        assertEquals(38.0, history.body().get(0).get("volumeLitres").asDouble());
        assertEquals(1, call("GET", "/vehicles/" + vehicleId + "/fuelling", acme, null).body().size(), "the owner sees it too");
        assertEquals(404, call("GET", "/vehicles/" + vehicleId + "/fuelling", buildco, null).status(),
                "another customer cannot read this vehicle's history");
    }

    private boolean notified(String token, String text) throws Exception {
        for (JsonNode n : call("GET", "/notifications", token, null).body()) {
            if (n.get("message").asText().contains(text)) {
                return true;
            }
        }
        return false;
    }

    @Test
    void vehicleCarriesTypeModelYearAndDriverAssignmentsNotifyTheCustomer() throws Exception {
        String acme = login("fleet@acme.test");
        String reg = "TY" + unique();
        Reply created = call("POST", "/vehicles", acme, Map.of("registration", reg, "fuelType", "DIESEL",
                "tankCapacityLitres", 60, "vehicleType", "Pickup", "model", "Hilux", "modelYear", 2020));
        assertEquals(201, created.status());
        assertEquals("Pickup", created.body().get("vehicleType").asText());
        assertEquals("Hilux", created.body().get("model").asText());
        assertEquals(2020, created.body().get("modelYear").asInt());
        String vehicleId = created.body().get("id").asText();

        assertEquals(400, call("POST", "/vehicles", acme, Map.of("registration", "TY" + unique(), "fuelType", "DIESEL",
                "tankCapacityLitres", 60, "modelYear", 1800)).status(), "a year before 1950 is refused");
        Reply edited = call("PATCH", "/vehicles/" + vehicleId, acme, Map.of("model", "Hilux GD-6", "modelYear", 2021));
        assertEquals("Hilux GD-6", edited.body().get("model").asText());
        assertEquals("Pickup", edited.body().get("vehicleType").asText(), "fields not sent are left alone");

        String name = "Notify " + unique();
        Reply driver = call("POST", "/drivers", acme, Map.of("name", name, "phone", "+27 82 555 0177"));
        assertEquals(201, driver.status());
        String driverId = driver.body().get("driver").get("id").asText();
        assertTrue(notified(acme, name + " was created"), "creating a driver notifies the customer");

        Reply assigned = call("PATCH", "/vehicles/" + vehicleId + "/driver", acme, Map.of("driverId", driverId));
        assertEquals(200, assigned.status());
        assertEquals(reg, assigned.body().get("vehicleReg").asText(), "assigned at once from the vehicle side");
        assertTrue(notified(acme, name + " was assigned to vehicle " + reg));

        assertEquals(204, call("PATCH", "/vehicles/" + vehicleId + "/driver", acme, new java.util.HashMap<String, Object>()).status());
        Reply fromDriver = call("PATCH", "/drivers/" + driverId + "/vehicle", acme, Map.of("vehicleReg", reg));
        assertEquals(reg, fromDriver.body().get("vehicleReg").asText(), "and from the driver side");
        assertTrue(notified(acme, "Vehicle " + reg + " no longer has an assigned driver"));
    }
}
