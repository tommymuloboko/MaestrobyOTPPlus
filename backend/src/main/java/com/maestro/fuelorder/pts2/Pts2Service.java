package com.maestro.fuelorder.pts2;

import com.maestro.fuelorder.integration.TelemetryService;
import com.maestro.fuelorder.site.SiteCatalog;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpStatus;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;
import org.springframework.web.server.ResponseStatusException;
import tools.jackson.databind.JsonNode;

import java.math.BigDecimal;
import java.net.URI;
import java.time.Instant;
import java.time.LocalDateTime;
import java.time.ZoneId;
import java.time.format.DateTimeParseException;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Pulls live tank readings from each site's PTS-2 over jsonPTS. Every poll reads the probe, tank and fuel grade
 * configuration and then each probe's measurements, keeps the result as the site's live tank state, and records
 * each reading through the telemetry pipeline so trends, reconciliation and device monitoring use it too.
 */
@Service
public class Pts2Service {

    private static final Logger log = LoggerFactory.getLogger(Pts2Service.class);

    /** One tank as the PTS-2 reports it. Fields the probe does not measure are null. */
    public record LiveTank(int tank, Integer fuelGradeId, String fuelGradeName, String product, String status,
                           List<String> alarms, BigDecimal productHeightMm, BigDecimal waterHeightMm,
                           BigDecimal temperatureC, BigDecimal volumeLitres, BigDecimal tcVolumeLitres,
                           BigDecimal waterVolumeLitres, BigDecimal ullageLitres, BigDecimal capacityLitres,
                           BigDecimal percent, Integer tankHeightMm, Instant measuredAt) {}

    /** The latest poll of one site. */
    public record SiteState(String siteCode, boolean ok, String error, Instant polledAt, Instant lastSuccessAt,
                            String controllerId, List<LiveTank> tanks) {}

    private final Pts2ConnectionRepository connections;
    private final Pts2Client client;
    private final TelemetryService telemetry;
    private final SiteCatalog sites;
    private final Map<String, SiteState> states = new ConcurrentHashMap<>();

    public Pts2Service(Pts2ConnectionRepository connections, Pts2Client client, TelemetryService telemetry,
                       SiteCatalog sites) {
        this.connections = connections;
        this.client = client;
        this.telemetry = telemetry;
        this.sites = sites;
    }

    public List<Pts2Connection> all() {
        return connections.findAllByOrderBySiteCodeAsc();
    }

    public SiteState state(String siteCode) {
        return states.get(siteCode);
    }

    /** Live tanks of every enabled connection, in site order. */
    public List<SiteState> live() {
        return all().stream().filter(Pts2Connection::isEnabled).map(c -> states.get(c.getSiteCode()))
                .filter(java.util.Objects::nonNull).toList();
    }

    public Pts2Connection save(String siteCode, String rawUrl, String username, String password, boolean enabled) {
        if (sites.find(siteCode).isEmpty()) {
            throw bad("Unknown site " + siteCode);
        }
        String url = normalizeUrl(rawUrl);
        if (username == null || username.isBlank()) {
            throw bad("The PTS-2 username is required");
        }
        Pts2Connection c = connections.findBySiteCode(siteCode).orElse(null);
        String pw = password == null || password.isEmpty() ? null : password;
        if (c == null) {
            if (pw == null) {
                throw bad("The PTS-2 password is required");
            }
            c = new Pts2Connection(siteCode, url, username.trim(), pw, enabled);
        } else {
            c.update(url, username.trim(), pw, enabled);
        }
        states.remove(siteCode);
        return connections.save(c);
    }

    public void delete(String siteCode) {
        connections.findBySiteCode(siteCode).ifPresent(connections::delete);
        states.remove(siteCode);
    }

    /** Accepts "192.168.1.117", "http://192.168.1.117" or the full jsonPTS URL; always returns the full URL. */
    static String normalizeUrl(String raw) {
        if (raw == null || raw.isBlank()) {
            throw bad("The PTS-2 address is required");
        }
        String s = raw.trim();
        if (!s.contains("://")) {
            s = "http://" + s;
        }
        URI u;
        try {
            u = URI.create(s);
        } catch (IllegalArgumentException e) {
            throw bad("The PTS-2 address is not a valid URL");
        }
        if (!("http".equalsIgnoreCase(u.getScheme()) || "https".equalsIgnoreCase(u.getScheme())) || u.getHost() == null) {
            throw bad("The PTS-2 address must be http:// or https:// followed by its IP address or host name");
        }
        String path = u.getPath() == null || u.getPath().isEmpty() || u.getPath().equals("/") ? "/jsonPTS" : u.getPath();
        return u.getScheme().toLowerCase(Locale.ROOT) + "://" + u.getHost() + (u.getPort() > 0 ? ":" + u.getPort() : "") + path;
    }

    @Scheduled(fixedDelayString = "${maestro.pts2.poll-ms:15000}", initialDelayString = "${maestro.pts2.initial-delay-ms:5000}")
    public void pollAll() {
        for (Pts2Connection c : all()) {
            if (c.isEnabled()) {
                poll(c);
            }
        }
    }

    public SiteState poll(String siteCode) {
        Pts2Connection c = connections.findBySiteCode(siteCode)
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND, "No PTS-2 connection for " + siteCode));
        return poll(c);
    }

    SiteState poll(Pts2Connection c) {
        SiteState previous = states.get(c.getSiteCode());
        Instant now = Instant.now();
        SiteState next;
        try {
            next = read(c, now);
        } catch (RuntimeException e) {
            String message = e instanceof Pts2Client.Pts2Exception ? e.getMessage() : "Unexpected error: " + e.getMessage();
            log.warn("PTS-2 poll of {} failed: {}", c.getSiteCode(), message);
            next = new SiteState(c.getSiteCode(), false, message, now, previous == null ? null : previous.lastSuccessAt(),
                    previous == null ? null : previous.controllerId(), previous == null ? List.of() : previous.tanks());
        }
        states.put(c.getSiteCode(), next);
        return next;
    }

    private SiteState read(Pts2Connection c, Instant now) {
        List<JsonNode> config = client.send(c, List.of(
                Pts2Client.Packet.of("GetUniqueIdentifier"),
                Pts2Client.Packet.of("GetProbesConfiguration"),
                Pts2Client.Packet.of("GetTanksConfiguration"),
                Pts2Client.Packet.of("GetFuelGradesConfiguration"),
                Pts2Client.Packet.of("GetDateTime")));
        ZoneId zone = controllerZone(config.get(4));
        String controllerId = config.get(0).path("Data").path("Id").asString(null);

        List<Integer> probes = new ArrayList<>();
        for (JsonNode p : config.get(1).path("Data").path("Probes")) {
            int id = p.path("Id").asInt(0);
            if (id > 0) {
                probes.add(id);
            }
        }
        Map<Integer, JsonNode> tankConfig = new HashMap<>();
        for (JsonNode t : config.get(2).path("Data").path("Tanks")) {
            tankConfig.put(t.path("Id").asInt(0), t);
        }
        Map<Integer, String> grades = new HashMap<>();
        for (JsonNode g : config.get(3).path("Data").path("FuelGrades")) {
            grades.put(g.path("Id").asInt(0), g.path("Name").asString(""));
        }
        if (probes.isEmpty()) {
            return new SiteState(c.getSiteCode(), true, null, now, now, controllerId, List.of());
        }

        List<Pts2Client.Packet> requests = probes.stream()
                .map(id -> new Pts2Client.Packet("ProbeGetMeasurements", Map.<String, Object>of("Probe", id))).toList();
        List<JsonNode> measured = client.send(c, requests);

        List<LiveTank> tanks = new ArrayList<>();
        Set<String> productsSeen = new HashSet<>();
        for (int i = 0; i < probes.size(); i++) {
            int tankId = probes.get(i);
            JsonNode packet = measured.get(i);
            JsonNode d = packet.path("Data");
            JsonNode tc = tankConfig.get(tankId);
            Integer gradeId = d.has("FuelGradeId") ? Integer.valueOf(d.path("FuelGradeId").asInt())
                    : tc != null && tc.path("FuelGradeId").asInt(0) > 0 ? Integer.valueOf(tc.path("FuelGradeId").asInt()) : null;
            String gradeName = d.has("FuelGradeName") ? d.path("FuelGradeName").asString()
                    : gradeId == null ? null : grades.get(gradeId);
            String product = productCode(gradeName, tankId);
            // two tanks of the same grade at one site keep separate readings
            if (!productsSeen.add(product)) {
                product = product + "_T" + tankId;
                productsSeen.add(product);
            }
            boolean error = packet.path("Error").asBoolean(false);
            String status = error ? packet.path("Message").asString("Error") : d.path("Status").asString("Unknown");
            List<String> alarms = new ArrayList<>();
            d.path("Alarms").forEach(a -> alarms.add(a.asString()));

            BigDecimal volume = dec(d, "ProductVolumeFloat", "ProductVolume");
            BigDecimal water = dec(d, "WaterVolumeFloat", "WaterVolume");
            BigDecimal ullage = dec(d, "ProductUllageFloat", "ProductUllage");
            BigDecimal capacity = volume == null || ullage == null ? null
                    : volume.add(ullage).add(water == null ? BigDecimal.ZERO : water);
            BigDecimal percent = d.has("TankFillingPercentage") ? new BigDecimal(d.path("TankFillingPercentage").asString())
                    : capacity == null || capacity.signum() == 0 ? null
                    : volume.multiply(BigDecimal.valueOf(100)).divide(capacity, 1, java.math.RoundingMode.HALF_UP);
            Integer tankHeight = tc != null && tc.path("Height").asInt(0) > 0 ? Integer.valueOf(tc.path("Height").asInt()) : null;
            Instant at = deviceTime(d.path("DateTime").asString(null), zone, now);
            BigDecimal temp = dec(d, "Temperature");
            BigDecimal waterMm = dec(d, "WaterHeight");

            tanks.add(new LiveTank(tankId, gradeId, gradeName, product, status, alarms, dec(d, "ProductHeight"), waterMm,
                    temp, volume, dec(d, "ProductTCVolumeFloat", "ProductTCVolume"), water, ullage, capacity, percent,
                    tankHeight, at));

            if (!error && "OK".equalsIgnoreCase(status) && volume != null) {
                telemetry.ingestTank(c.getSiteCode(), product, volume, temp, waterMm, at);
            }
        }
        return new SiteState(c.getSiteCode(), true, null, now, now, controllerId, tanks);
    }

    /** "Diesel 50ppm" becomes DIESEL_50PPM; a tank with no grade is TANK_<n>. */
    static String productCode(String gradeName, int tankId) {
        if (gradeName == null || gradeName.isBlank()) {
            return "TANK_" + tankId;
        }
        String code = gradeName.trim().toUpperCase(Locale.ROOT).replaceAll("[^A-Z0-9]+", "_").replaceAll("^_|_$", "");
        return code.isEmpty() ? "TANK_" + tankId : code;
    }

    /** The controller's UTC offset from its DateTime reply; the server's zone if it reports none. */
    static ZoneId controllerZone(JsonNode dateTime) {
        JsonNode offset = dateTime.path("Data").path("UTCOffset");
        if (!offset.isNumber() || Math.abs(offset.asInt()) > 1440) {
            return ZoneId.systemDefault();
        }
        return java.time.ZoneOffset.ofTotalSeconds(offset.asInt() * 60);
    }

    /** The controller reports local time without a zone; its UTC offset turns it into an instant. */
    private static Instant deviceTime(String raw, ZoneId zone, Instant fallback) {
        if (raw == null || raw.isBlank()) {
            return fallback;
        }
        try {
            return LocalDateTime.parse(raw).atZone(zone).toInstant();
        } catch (DateTimeParseException e) {
            return fallback;
        }
    }

    private static BigDecimal dec(JsonNode d, String... fields) {
        for (String f : fields) {
            JsonNode n = d.get(f);
            if (n != null && n.isNumber()) {
                return n.decimalValue();
            }
        }
        return null;
    }

    private static ResponseStatusException bad(String message) {
        return new ResponseStatusException(HttpStatus.BAD_REQUEST, message);
    }

    /** For the connection list: the stored settings (without the password) and the latest poll. */
    public Map<String, Object> view(Pts2Connection c) {
        SiteState s = states.get(c.getSiteCode());
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("siteCode", c.getSiteCode());
        m.put("url", c.getUrl());
        m.put("username", c.getUsername());
        m.put("enabled", c.isEnabled());
        m.put("updatedAt", c.getUpdatedAt());
        m.put("ok", s == null ? null : s.ok());
        m.put("error", s == null ? null : s.error());
        m.put("polledAt", s == null ? null : s.polledAt());
        m.put("lastSuccessAt", s == null ? null : s.lastSuccessAt());
        m.put("controllerId", s == null ? null : s.controllerId());
        m.put("tankCount", s == null ? 0 : s.tanks().size());
        return m;
    }
}
