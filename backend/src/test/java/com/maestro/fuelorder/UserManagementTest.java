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
import static org.junit.jupiter.api.Assertions.assertTrue;

/** Users & Permissions: the OMC Administrator adds, edits, deactivates and deletes user accounts. */
@SpringBootTest(
        webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT,
        properties = {"maestro.mqtt.enabled=false", "maestro.rate-limit.per-minute=0", "maestro.rate-limit.login-per-minute=0"})
class UserManagementTest {

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

    private Reply loginAs(String email, String password) throws Exception {
        return call("POST", "/auth/login", null, Map.of("email", email, "password", password));
    }

    private String login(String email) throws Exception {
        Reply r = loginAs(email, PASSWORD);
        assertEquals(200, r.status());
        return r.body().get("token").asText();
    }

    private static String unique() {
        return String.valueOf(System.nanoTime() % 100_000_000L);
    }

    private JsonNode create(String omc, String email, String role) throws Exception {
        Reply r = call("POST", "/users", omc, Map.of("email", email, "name", "Test " + email, "role", role));
        assertEquals(201, r.status(), r.body().toString());
        return r.body();
    }

    private JsonNode find(String omc, String email) throws Exception {
        for (JsonNode u : call("GET", "/users", omc, null).body()) {
            if (u.get("email").asText().equals(email)) {
                return u;
            }
        }
        return null;
    }

    @Test
    void omcAddsAUserWhoCanSignInWithTheTemporaryPassword() throws Exception {
        String omc = login("omc@mainline.test");
        String email = "att" + unique() + "@mainline.test";

        JsonNode created = create(omc, email, "Attendant");
        String temp = created.get("temporaryPassword").asText();
        assertEquals(12, temp.length());
        assertEquals("Maestro Fuel Depots", created.get("user").get("organization").asText(), "staff belong to the supplier");
        assertFalse(created.get("user").has("passwordHash"), "no password material is ever returned in the user");

        Reply in = loginAs(email, temp);
        assertEquals(200, in.status(), "the new user signs in with the temporary password");
        assertEquals("Attendant", in.body().get("role").asText());
        assertTrue(find(omc, email) != null, "and appears in the user list");
    }

    @Test
    void aFleetManagerMustBelongToAnExistingCustomer() throws Exception {
        String omc = login("omc@mainline.test");
        String email = "fm" + unique() + "@acme.test";

        assertEquals(400, call("POST", "/users", omc, Map.of("email", email, "name", "No Org", "role", "Fleet Manager")).status(),
                "a fleet manager needs a customer organization");
        assertEquals(400, call("POST", "/users", omc, Map.of("email", email, "name", "Supplier Org", "role", "Fleet Manager",
                "organization", "Maestro Fuel Depots")).status(), "the supplier is not a customer");
        assertEquals(400, call("POST", "/users", omc, Map.of("email", email, "name", "Bad Branch", "role", "Fleet Manager",
                "organization", "Acme Logistics", "branchCode", "NOPE")).status(), "the branch must belong to that customer");

        Reply ok = call("POST", "/users", omc, Map.of("email", email, "name", "Good", "role", "Fleet Manager",
                "organization", "Acme Logistics", "branchCode", "JHB"));
        assertEquals(201, ok.status(), ok.body().toString());
        assertEquals("Acme Logistics", ok.body().get("user").get("organization").asText());
    }

    @Test
    void emailsAreUniqueAndValidated() throws Exception {
        String omc = login("omc@mainline.test");
        String email = "dup" + unique() + "@mainline.test";
        create(omc, email, "Attendant");
        assertEquals(409, call("POST", "/users", omc, Map.of("email", email.toUpperCase(), "name", "Again", "role", "Attendant")).status());
        assertEquals(400, call("POST", "/users", omc, Map.of("email", "not-an-email", "name", "X", "role", "Attendant")).status());
        assertEquals(400, call("POST", "/users", omc, Map.of("email", "role" + unique() + "@x.test", "name", "X", "role", "Wizard")).status());
    }

    @Test
    void editingChangesTheAccountAndEndsItsOldSessions() throws Exception {
        String omc = login("omc@mainline.test");
        String email = "edit" + unique() + "@mainline.test";
        JsonNode created = create(omc, email, "Attendant");
        String id = created.get("user").get("id").asText();
        String userToken = loginAs(email, created.get("temporaryPassword").asText()).body().get("token").asText();
        assertEquals(200, call("GET", "/auth/me", userToken, null).status());

        Reply renamed = call("PUT", "/users/" + id, omc, Map.of("name", "Renamed Person", "role", "Attendant"));
        assertEquals(200, renamed.status(), renamed.body().toString());
        assertEquals("Renamed Person", renamed.body().get("name").asText());
        assertEquals(200, call("GET", "/auth/me", userToken, null).status(), "a rename does not sign the person out");

        Reply promoted = call("PUT", "/users/" + id, omc, Map.of("name", "Renamed Person", "role", "Station Manager"));
        assertEquals("Station Manager", promoted.body().get("role").asText());
        assertEquals(401, call("GET", "/auth/me", userToken, null).status(), "a role change ends the old session");
    }

    @Test
    void deactivatingBlocksSignInAndReactivatingRestoresIt() throws Exception {
        String omc = login("omc@mainline.test");
        String email = "off" + unique() + "@mainline.test";
        JsonNode created = create(omc, email, "Finance");
        String id = created.get("user").get("id").asText();
        String temp = created.get("temporaryPassword").asText();
        String userToken = loginAs(email, temp).body().get("token").asText();

        Reply off = call("POST", "/users/" + id + "/deactivate", omc, null);
        assertEquals(200, off.status());
        assertFalse(off.body().get("active").asBoolean());
        assertEquals(401, call("GET", "/auth/me", userToken, null).status(), "the live session is ended");
        assertEquals(401, loginAs(email, temp).status(), "and the account can no longer sign in");

        assertTrue(call("POST", "/users/" + id + "/activate", omc, null).body().get("active").asBoolean());
        assertEquals(200, loginAs(email, temp).status());
    }

    @Test
    void resettingAPasswordIssuesANewOneAndRetiresTheOld() throws Exception {
        String omc = login("omc@mainline.test");
        String email = "pw" + unique() + "@mainline.test";
        JsonNode created = create(omc, email, "Attendant");
        String id = created.get("user").get("id").asText();
        String oldTemp = created.get("temporaryPassword").asText();

        Reply reset = call("POST", "/users/" + id + "/reset-password", omc, null);
        assertEquals(200, reset.status());
        String newTemp = reset.body().get("temporaryPassword").asText();
        assertEquals(401, loginAs(email, oldTemp).status(), "the old password stops working");
        assertEquals(200, loginAs(email, newTemp).status());
    }

    @Test
    void deletingRemovesTheAccountAndItsSessions() throws Exception {
        String omc = login("omc@mainline.test");
        String email = "del" + unique() + "@mainline.test";
        JsonNode created = create(omc, email, "Attendant");
        String id = created.get("user").get("id").asText();
        String userToken = loginAs(email, created.get("temporaryPassword").asText()).body().get("token").asText();

        assertEquals(204, call("DELETE", "/users/" + id, omc, null).status());
        assertEquals(null, find(omc, email), "the user is gone from the list");
        assertEquals(401, call("GET", "/auth/me", userToken, null).status(), "their session is ended");
        assertEquals(401, loginAs(email, created.get("temporaryPassword").asText()).status());
        assertEquals(404, call("DELETE", "/users/" + id, omc, null).status());
    }

    @Test
    void youCannotLockYourselfOutOrPromoteYourself() throws Exception {
        String omc = login("omc@mainline.test");
        String myId = find(omc, "omc@mainline.test").get("id").asText();
        assertEquals(409, call("DELETE", "/users/" + myId, omc, null).status());
        assertEquals(409, call("POST", "/users/" + myId + "/deactivate", omc, null).status());
        assertEquals(409, call("POST", "/users/" + myId + "/reset-password", omc, null).status());
        assertEquals(409, call("PUT", "/users/" + myId, omc, Map.of("name", "Me", "role", "Attendant")).status(), "no demoting yourself");
        assertEquals(409, call("PUT", "/users/" + myId, omc, Map.of("name", "Me", "role", "Platform Admin")).status(), "no promoting yourself");
        assertEquals(200, call("PUT", "/users/" + myId, omc, Map.of("name", "Zodwa Ndlovu", "role", "OMC Administrator")).status(),
                "but editing your own name is fine");
    }

    @Test
    void anOmcAdministratorCannotGivePlatformAdminToAnotherAccount() throws Exception {
        String omc = login("omc@mainline.test");
        String email = "up" + unique() + "@mainline.test";
        String id = create(omc, email, "Attendant").get("user").get("id").asText();
        assertEquals(403, call("PUT", "/users/" + id, omc, Map.of("name", "Climber", "role", "Platform Admin")).status());
    }

    @Test
    void anOmcAdministratorCannotTouchPlatformAdmins() throws Exception {
        String omc = login("omc@mainline.test");
        JsonNode admin = find(omc, "admin@maestro.test");
        String adminId = admin.get("id").asText();

        assertEquals(403, call("POST", "/users", omc, Map.of("email", "pa" + unique() + "@x.test", "name", "X", "role", "Platform Admin")).status(),
                "the OMC cannot create a Platform Admin");
        assertEquals(403, call("DELETE", "/users/" + adminId, omc, null).status());
        assertEquals(403, call("POST", "/users/" + adminId + "/reset-password", omc, null).status());
        assertEquals(403, call("POST", "/users/" + adminId + "/deactivate", omc, null).status());
        assertEquals(403, call("PUT", "/users/" + adminId, omc, Map.of("name", "Hijacked", "role", "Attendant")).status());
    }

    @Test
    void thePlatformAdminCanManageEveryoneButKeepsTheLastAdmin() throws Exception {
        String platform = login("admin@maestro.test");
        String email = "pa" + unique() + "@maestro.test";
        Reply made = call("POST", "/users", platform, Map.of("email", email, "name", "Second Admin", "role", "Platform Admin"));
        assertEquals(201, made.status(), made.body().toString());
        assertEquals("Maestro Platform", made.body().get("user").get("organization").asText());

        // with two active admins one can be removed...
        assertEquals(204, call("DELETE", "/users/" + made.body().get("user").get("id").asText(), platform, null).status());
        // ...and the remaining admin cannot be deleted (it is also the signed-in user, so the self-protection applies first)
        String lastId = find(platform, "admin@maestro.test").get("id").asText();
        assertEquals(409, call("DELETE", "/users/" + lastId, platform, null).status());
    }

    @Test
    void onlyTheOmcAndPlatformAdminsCanManageUsers() throws Exception {
        for (String email : new String[]{"fleet@acme.test", "attendant@mainline.test", "supplier@mainline.test", "finance@maestro.test"}) {
            String token = login(email);
            assertEquals(403, call("GET", "/users", token, null).status(), email + " cannot list users");
            assertEquals(403, call("POST", "/users", token, Map.of("email", "x" + unique() + "@x.test", "name", "X", "role", "Attendant")).status());
        }
        assertEquals(401, call("GET", "/users", null, null).status());
    }
}
