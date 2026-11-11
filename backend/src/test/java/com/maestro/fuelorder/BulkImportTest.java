package com.maestro.fuelorder;

import org.apache.poi.ss.usermodel.Row;
import org.apache.poi.ss.usermodel.Sheet;
import org.apache.poi.xssf.usermodel.XSSFWorkbook;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.test.context.SpringBootTest;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotNull;
import static org.junit.jupiter.api.Assertions.assertTrue;

/** Excel templates and bulk import for vehicles, drivers and bulk-order allocations, over real HTTP and real .xlsx files. */
@SpringBootTest(
        webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT,
        properties = {"maestro.mqtt.enabled=false", "maestro.rate-limit.per-minute=0", "maestro.rate-limit.login-per-minute=0"})
class BulkImportTest {

    private static final String PASSWORD = "Maestro#2026";

    @Value("${local.server.port}")
    int port;

    private final HttpClient http = HttpClient.newHttpClient();
    private final JsonMapper json = JsonMapper.builder().build();

    private record Reply(int status, JsonNode body) {}

    private record Formula(String text) {}

    private String login(String email) throws Exception {
        HttpRequest r = HttpRequest.newBuilder(URI.create("http://localhost:" + port + "/api/v1/auth/login"))
                .header("Content-Type", "application/json")
                .POST(HttpRequest.BodyPublishers.ofString(json.writeValueAsString(Map.of("email", email, "password", PASSWORD))))
                .build();
        return json.readTree(http.send(r, HttpResponse.BodyHandlers.ofString()).body()).get("token").asText();
    }

    private Reply get(String path, String token) throws Exception {
        HttpResponse<String> r = http.send(HttpRequest.newBuilder(URI.create("http://localhost:" + port + "/api/v1" + path))
                .header("Authorization", "Bearer " + token).GET().build(), HttpResponse.BodyHandlers.ofString());
        return new Reply(r.statusCode(), r.body().isBlank() ? json.createObjectNode() : json.readTree(r.body()));
    }

    private HttpResponse<byte[]> download(String path, String token) throws Exception {
        return http.send(HttpRequest.newBuilder(URI.create("http://localhost:" + port + "/api/v1" + path))
                .header("Authorization", "Bearer " + token).GET().build(), HttpResponse.BodyHandlers.ofByteArray());
    }

    private Reply upload(String path, String token, String filename, byte[] data, Map<String, String> fields) throws Exception {
        String boundary = "----maestroTestBoundary";
        ByteArrayOutputStream body = new ByteArrayOutputStream();
        for (var f : fields.entrySet()) {
            body.write(("--" + boundary + "\r\nContent-Disposition: form-data; name=\"" + f.getKey() + "\"\r\n\r\n"
                    + f.getValue() + "\r\n").getBytes(StandardCharsets.UTF_8));
        }
        body.write(("--" + boundary + "\r\nContent-Disposition: form-data; name=\"file\"; filename=\"" + filename
                + "\"\r\nContent-Type: application/octet-stream\r\n\r\n").getBytes(StandardCharsets.UTF_8));
        body.write(data);
        body.write(("\r\n--" + boundary + "--\r\n").getBytes(StandardCharsets.UTF_8));
        HttpResponse<String> r = http.send(HttpRequest.newBuilder(URI.create("http://localhost:" + port + "/api/v1" + path))
                .header("Authorization", "Bearer " + token)
                .header("Content-Type", "multipart/form-data; boundary=" + boundary)
                .POST(HttpRequest.BodyPublishers.ofByteArray(body.toByteArray())).build(), HttpResponse.BodyHandlers.ofString());
        return new Reply(r.statusCode(), r.body().isBlank() ? json.createObjectNode() : json.readTree(r.body()));
    }

    private static byte[] workbook(List<String> headers, List<List<Object>> rows) throws Exception {
        try (XSSFWorkbook wb = new XSSFWorkbook(); ByteArrayOutputStream out = new ByteArrayOutputStream()) {
            Sheet sheet = wb.createSheet("Data");
            Row head = sheet.createRow(0);
            for (int i = 0; i < headers.size(); i++) {
                head.createCell(i).setCellValue(headers.get(i));
            }
            for (int r = 0; r < rows.size(); r++) {
                Row row = sheet.createRow(r + 1);
                for (int c = 0; c < rows.get(r).size(); c++) {
                    Object v = rows.get(r).get(c);
                    if (v instanceof Double d) {
                        row.createCell(c).setCellValue(d);
                    } else if (v instanceof Formula f) {
                        row.createCell(c).setCellFormula(f.text());
                    } else if (v != null) {
                        row.createCell(c).setCellValue(v.toString());
                    }
                }
            }
            wb.write(out);
            return out.toByteArray();
        }
    }

    private static final List<String> VEHICLE_HEADERS = List.of("Registration *", "Description", "Fuel type *", "Tank capacity (L) *");
    private static final List<String> DRIVER_HEADERS = List.of("Full name *", "Phone", "Licence number", "Assigned vehicle");
    private static final List<String> ORDER_HEADERS = List.of("Vehicle registration *", "Driver name", "Litres *");

    private static String unique() {
        return String.valueOf(System.nanoTime() % 1_000_000);
    }

    private static List<Object> row(Object... cells) {
        return new ArrayList<>(List.of(cells));
    }

    private static boolean listContains(JsonNode array, String field, String value) {
        for (JsonNode n : array) {
            if (value.equalsIgnoreCase(n.get(field).asText())) {
                return true;
            }
        }
        return false;
    }

    @Test
    void templatesAreWorkbooksWithTheExpectedHeadersAndAreCustomerOnlyWhereTheyShouldBe() throws Exception {
        String acme = login("fleet@acme.test");
        for (var expected : Map.of("vehicles", VEHICLE_HEADERS, "drivers", DRIVER_HEADERS, "orders", ORDER_HEADERS).entrySet()) {
            HttpResponse<byte[]> r = download("/bulk/templates/" + expected.getKey(), acme);
            assertEquals(200, r.statusCode());
            assertTrue(r.headers().firstValue("Content-Disposition").orElse("").contains(".xlsx"));
            try (XSSFWorkbook wb = new XSSFWorkbook(new ByteArrayInputStream(r.body()))) {
                Sheet data = wb.getSheet("Data");
                assertNotNull(data, "Data sheet");
                assertNotNull(wb.getSheet("Instructions"), "Instructions sheet");
                for (int i = 0; i < expected.getValue().size(); i++) {
                    assertEquals(expected.getValue().get(i), data.getRow(0).getCell(i).getStringCellValue());
                }
                if (expected.getKey().equals("orders")) {
                    assertTrue(data.getLastRowNum() >= 1, "the orders template is prefilled with the fleet");
                }
            }
        }
        assertEquals(403, download("/bulk/templates/vehicles", login("supplier@mainline.test")).statusCode());
        assertEquals(404, download("/bulk/templates/nonsense", acme).statusCode());
    }

    @Test
    void vehicleImportChecksEveryRowAndImportsNothingIfOneIsBad() throws Exception {
        String acme = login("fleet@acme.test");
        String n = unique();
        String good1 = "BV" + n + "A";
        String good2 = "BV" + n + "B";

        byte[] withBadRow = workbook(VEHICLE_HEADERS, List.of(
                row(good1, "Truck", "DIESEL", 200.0),
                row(good2, "Bakkie", "petrol", 60.0),
                row("BV" + n + "C", "", "GAS", "abc")));
        Reply bad = upload("/bulk/vehicles?dryRun=false", acme, "fleet.xlsx", withBadRow, Map.of());
        assertEquals(200, bad.status());
        assertFalse(bad.body().get("imported").asBoolean(), "a bad row must stop the whole import");
        assertEquals(1, bad.body().get("invalid").asInt());
        JsonNode badRow = bad.body().get("rows").get(2);
        assertEquals(4, badRow.get("row").asInt(), "errors carry the Excel row number");
        assertTrue(badRow.get("message").asText().contains("Fuel type"));
        assertTrue(badRow.get("message").asText().contains("Tank capacity"));
        assertFalse(listContains(get("/vehicles", acme).body(), "registration", good1), "nothing may be saved");

        byte[] clean = workbook(VEHICLE_HEADERS, List.of(
                row(good1, "Truck", "DIESEL", 200.0), row(good2, "Bakkie", "petrol", 60.0)));
        Reply preview = upload("/bulk/vehicles", acme, "fleet.xlsx", clean, Map.of());
        assertEquals(2, preview.body().get("valid").asInt());
        assertTrue(preview.body().get("dryRun").asBoolean());
        assertFalse(listContains(get("/vehicles", acme).body(), "registration", good1), "a preview saves nothing");

        Reply done = upload("/bulk/vehicles?dryRun=false", acme, "fleet.xlsx", clean, Map.of());
        assertTrue(done.body().get("imported").asBoolean());
        JsonNode fleet = get("/vehicles", acme).body();
        assertTrue(listContains(fleet, "registration", good1));
        assertTrue(listContains(fleet, "registration", good2));

        Reply again = upload("/bulk/vehicles", acme, "fleet.xlsx", clean, Map.of());
        assertEquals(2, again.body().get("invalid").asInt());
        assertTrue(again.body().get("rows").get(0).get("message").asText().contains("already registered"));
    }

    @Test
    void driverImportIssuesPinsOnceAndAssignsTheVehicle() throws Exception {
        String acme = login("fleet@acme.test");
        String n = unique();
        String reg = "BD" + n;
        assertTrue(upload("/bulk/vehicles?dryRun=false", acme, "v.xlsx",
                workbook(VEHICLE_HEADERS, List.of(row(reg, "Truck", "DIESEL", 300.0))), Map.of()).body().get("imported").asBoolean());

        byte[] withProblems = workbook(DRIVER_HEADERS, List.of(
                row("Driver A" + n, 27825550101.0, "LIC1", reg),
                row("driver a" + n, "", "", ""),
                row("Driver B" + n, "not a phone", "", "NO-SUCH-VEHICLE")));
        Reply bad = upload("/bulk/drivers?dryRun=false", acme, "d.xlsx", withProblems, Map.of());
        assertFalse(bad.body().get("imported").asBoolean());
        assertEquals(0, bad.body().get("pins").size(), "no PIN may be issued when the import fails");
        assertTrue(bad.body().get("rows").get(1).get("message").asText().contains("more than once"));
        assertTrue(bad.body().get("rows").get(2).get("message").asText().contains("Phone"));
        assertTrue(bad.body().get("rows").get(2).get("message").asText().contains("not in your fleet"));

        byte[] clean = workbook(DRIVER_HEADERS, List.of(
                row("Driver A" + n, 27825550101.0, "LIC1", reg), row("Driver B" + n, "+27 82 555 0100", "", "")));
        Reply done = upload("/bulk/drivers?dryRun=false", acme, "d.xlsx", clean, Map.of());
        assertTrue(done.body().get("imported").asBoolean(), done.body().toString());
        JsonNode pins = done.body().get("pins");
        assertEquals(2, pins.size());
        for (JsonNode p : pins) {
            assertTrue(p.get("pin").asText().matches("\\d{4}"));
        }
        assertEquals("27825550101", pins.get(0).get("phone").asText(), "a numeric phone cell keeps all its digits");

        JsonNode drivers = get("/drivers", acme).body();
        assertTrue(listContains(drivers, "name", "Driver A" + n));
        for (JsonNode d : drivers) {
            assertFalse(d.has("pin") || d.has("pinHash"), "the listing must never expose a PIN");
            if (d.get("name").asText().equals("Driver A" + n)) {
                assertEquals(reg, d.get("vehicleReg").asText());
            }
        }
    }

    @Test
    void bulkOrderAllocationsAreValidatedAgainstTheCustomersOwnFleet() throws Exception {
        String acme = login("fleet@acme.test");
        String build = login("fleet@buildco.test");
        String n = unique();
        String reg = "BO" + n;
        String spare = "BS" + n;
        assertTrue(upload("/bulk/vehicles?dryRun=false", acme, "v.xlsx", workbook(VEHICLE_HEADERS, List.of(
                row(reg, "Truck", "DIESEL", 100.0), row(spare, "Truck", "DIESEL", 100.0), row("BP" + n, "Car", "PETROL", 50.0))),
                Map.of()).body().get("imported").asBoolean());
        assertTrue(upload("/bulk/drivers?dryRun=false", acme, "d.xlsx", workbook(DRIVER_HEADERS, List.of(
                row("Usual Driver" + n, "", "", reg))), Map.of()).body().get("imported").asBoolean());
        Map<String, String> diesel = Map.of("fuelProduct", "DIESEL_50");

        byte[] good = workbook(ORDER_HEADERS, List.of(row(reg.toLowerCase(), "", 40.0), row(spare, "", "")));
        Reply ok = upload("/bulk/orders/parse", acme, "o.xlsx", good, diesel);
        assertEquals(200, ok.status());
        assertEquals(0, ok.body().get("invalid").asInt(), ok.body().toString());
        assertEquals(1, ok.body().get("skipped").asInt(), "a row with no litres is left out");
        JsonNode allocation = ok.body().get("allocations").get(0);
        assertEquals(reg, allocation.get("vehicleReg").asText(), "the registered spelling is used");
        assertEquals("Usual Driver" + n, allocation.get("driverName").asText(), "a blank driver defaults to the assigned one");

        Reply tooMuch = upload("/bulk/orders/parse", acme, "o.xlsx",
                workbook(ORDER_HEADERS, List.of(row(reg, "Usual Driver" + n, 500.0))), diesel);
        assertTrue(tooMuch.body().get("rows").get(0).get("message").asText().contains("exceeds"));
        assertEquals(0, tooMuch.body().get("allocations").size(), "nothing is offered when a row is invalid");

        Reply wrongFuel = upload("/bulk/orders/parse", acme, "o.xlsx",
                workbook(ORDER_HEADERS, List.of(row("BP" + n, "Usual Driver" + n, 10.0))), diesel);
        assertTrue(wrongFuel.body().get("rows").get(0).get("message").asText().contains("petrol"));

        Reply duplicate = upload("/bulk/orders/parse", acme, "o.xlsx",
                workbook(ORDER_HEADERS, List.of(row(reg, "", 10.0), row(reg, "", 20.0))), diesel);
        assertTrue(duplicate.body().get("rows").get(1).get("message").asText().contains("more than once"));

        Reply formula = upload("/bulk/orders/parse", acme, "o.xlsx",
                workbook(ORDER_HEADERS, List.of(row(reg, "", new Formula("10+10")))), diesel);
        assertTrue(formula.body().get("rows").get(0).get("message").asText().contains("formulas are not allowed"));

        Reply otherTenant = upload("/bulk/orders/parse", build, "o.xlsx", good, diesel);
        assertEquals(1, otherTenant.body().get("invalid").asInt());
        assertTrue(otherTenant.body().get("rows").get(0).get("message").asText().contains("not registered to your fleet"),
                "another customer must not be able to use this fleet");
    }

    @Test
    void badUploadsAreRefusedClearly() throws Exception {
        String acme = login("fleet@acme.test");
        byte[] fine = workbook(VEHICLE_HEADERS, List.of(row("BX" + unique(), "", "DIESEL", 100.0)));

        assertEquals(400, upload("/bulk/vehicles", acme, "fleet.csv", fine, Map.of()).status(), "only .xlsx is accepted");
        assertEquals(403, upload("/bulk/vehicles", login("supplier@mainline.test"), "fleet.xlsx", fine, Map.of()).status(),
                "only customers register their fleet");

        Reply garbage = upload("/bulk/vehicles", acme, "fleet.xlsx", "this is not a workbook".getBytes(StandardCharsets.UTF_8), Map.of());
        assertEquals(200, garbage.status());
        assertNotNull(garbage.body().get("error").asText());
        assertTrue(garbage.body().get("error").asText().contains("could not be read"));

        Reply wrongColumns = upload("/bulk/vehicles", acme, "fleet.xlsx",
                workbook(List.of("Plate", "Colour"), List.of(row("X", "red"))), Map.of());
        assertTrue(wrongColumns.body().get("error").asText().contains("Missing required column"));

        List<List<Object>> many = new ArrayList<>();
        for (int i = 0; i < 501; i++) {
            many.add(row("BM" + i, "", "DIESEL", 100.0));
        }
        Reply tooManyRows = upload("/bulk/vehicles", acme, "fleet.xlsx", workbook(VEHICLE_HEADERS, many), Map.of());
        assertTrue(tooManyRows.body().get("error").asText().contains("more than 500"));
    }
}
