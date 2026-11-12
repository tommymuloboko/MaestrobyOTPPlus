package com.maestro.fuelorder.pts2;

import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.web.server.ResponseStatusException;
import tools.jackson.databind.JsonNode;

import java.math.BigDecimal;
import java.time.LocalDateTime;
import java.time.format.DateTimeFormatter;
import java.time.format.DateTimeParseException;
import java.time.temporal.ChronoUnit;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * Pump prices on a site's PTS-2. An immediate change rewrites the controller's fuel grade prices
 * (SetFuelGradesPrices); a scheduled change is written to the controller's own prices scheduler
 * (SetPricesSchedulerConfiguration), so it takes effect on time even if the API cannot reach the controller then.
 * Both commands replace the whole list on the controller, so the current list is always read and merged first.
 */
@Service
public class Pts2PriceService {

    /** One fuel grade and its current price on the controller. */
    public record Grade(int id, String name, BigDecimal price) {}

    /** One entry of the controller's prices scheduler. Recurring entries apply on the listed weekdays. */
    public record Schedule(int id, boolean enabled, int fuelGradeId, String fuelGradeName, BigDecimal price,
                           String dateTime, List<String> days, boolean pending) {}

    /** controllerTime is the controller's own clock, which scheduled times are in. */
    public record Prices(String siteCode, String controllerTime, List<Grade> grades, List<Schedule> schedules,
                         int freeSlots) {}

    public record Change(int fuelGradeId, BigDecimal price) {}

    /** The controller holds at most this many price schedules. */
    static final int SCHEDULE_SLOTS = 10;
    private static final String[] DAYS = {"Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"};
    private static final DateTimeFormatter PTS_TIME = DateTimeFormatter.ofPattern("yyyy-MM-dd'T'HH:mm:ss");

    private final Pts2ConnectionRepository connections;
    private final Pts2Client client;
    private final Pts2PriceChangeRepository changes;

    public Pts2PriceService(Pts2ConnectionRepository connections, Pts2Client client, Pts2PriceChangeRepository changes) {
        this.connections = connections;
        this.client = client;
        this.changes = changes;
    }

    public Prices prices(String siteCode) {
        Pts2Connection c = connection(siteCode);
        List<JsonNode> r = send(c, List.of(Pts2Client.Packet.of("GetFuelGradesConfiguration"),
                Pts2Client.Packet.of("GetPricesSchedulerConfiguration"), Pts2Client.Packet.of("GetDateTime")));
        return view(siteCode, grades(r.get(0)), configured(r.get(1)), controllerNow(r.get(2)));
    }

    public List<Pts2PriceChange> history(String siteCode) {
        return changes.findTop100BySiteCodeOrderByAtDesc(siteCode);
    }

    /**
     * Applies the new prices now, or schedules them on the controller for {@code effectiveAt} (controller local time).
     * Synchronized because each change is a read-modify-write of a list on the controller.
     */
    public synchronized Prices change(String siteCode, List<Change> requested, LocalDateTime effectiveAt, String by) {
        if (requested == null || requested.isEmpty()) {
            throw bad("Give at least one fuel grade and its new price");
        }
        Pts2Connection c = connection(siteCode);
        List<JsonNode> r = send(c, List.of(Pts2Client.Packet.of("GetFuelGradesConfiguration"),
                Pts2Client.Packet.of("GetPricesSchedulerConfiguration"), Pts2Client.Packet.of("GetDateTime")));
        Map<Integer, Grade> grades = grades(r.get(0));
        List<JsonNode> schedules = configured(r.get(1));
        LocalDateTime now = controllerNow(r.get(2));

        Set<Integer> seen = new HashSet<>();
        for (Change ch : requested) {
            if (!grades.containsKey(ch.fuelGradeId())) {
                throw bad("Fuel grade " + ch.fuelGradeId() + " is not configured on the PTS-2");
            }
            if (!seen.add(ch.fuelGradeId())) {
                throw bad("Fuel grade " + ch.fuelGradeId() + " is listed twice");
            }
            validatePrice(ch.price());
        }

        if (effectiveAt == null) {
            Map<Integer, BigDecimal> merged = new LinkedHashMap<>();
            grades.values().forEach(g -> merged.put(g.id(), g.price() == null ? BigDecimal.ZERO : g.price()));
            requested.forEach(ch -> merged.put(ch.fuelGradeId(), ch.price()));
            List<Map<String, Object>> list = new ArrayList<>();
            merged.forEach((id, price) -> list.add(Map.of("FuelGradeId", id, "Price", price)));
            send(c, List.of(new Pts2Client.Packet("SetFuelGradesPrices", Map.of("FuelGradesPrices", list))));
            for (Change ch : requested) {
                Grade g = grades.get(ch.fuelGradeId());
                changes.save(new Pts2PriceChange(siteCode, g.id(), g.name(), g.price(), ch.price(),
                        Pts2PriceChange.IMMEDIATE, now, null, by));
            }
        } else {
            LocalDateTime at = effectiveAt.truncatedTo(ChronoUnit.SECONDS);
            if (!at.isAfter(now)) {
                throw bad("A scheduled price change must be after the station's current time (" + PTS_TIME.format(now)
                        + "); choose \"now\" to change it immediately");
            }
            if (at.getYear() > 2099) {
                throw bad("The PTS-2 scheduler only accepts dates up to 2099");
            }
            List<Integer> slots = freeSlots(schedules, requested.size(), now);
            List<Object> list = new ArrayList<>();
            Set<Integer> reused = new HashSet<>(slots);
            schedules.stream().filter(s -> !reused.contains(s.path("Id").asInt())).forEach(list::add);
            for (int i = 0; i < requested.size(); i++) {
                Change ch = requested.get(i);
                Map<String, Object> s = new LinkedHashMap<>();
                s.put("Id", slots.get(i));
                s.put("Enabled", true);
                s.put("FuelGradeId", ch.fuelGradeId());
                s.put("Price", ch.price());
                s.put("DateTime", PTS_TIME.format(at));
                for (String d : DAYS) {
                    s.put("Every" + d, false);
                }
                list.add(s);
            }
            send(c, List.of(new Pts2Client.Packet("SetPricesSchedulerConfiguration", Map.of("PriceSchedules", list))));
            for (int i = 0; i < requested.size(); i++) {
                Change ch = requested.get(i);
                Grade g = grades.get(ch.fuelGradeId());
                changes.save(new Pts2PriceChange(siteCode, g.id(), g.name(), g.price(), ch.price(),
                        Pts2PriceChange.SCHEDULED, at, slots.get(i), by));
            }
        }
        return prices(siteCode);
    }

    /** Removes one entry from the controller's prices scheduler. */
    public synchronized Prices cancel(String siteCode, int scheduleId, String by) {
        Pts2Connection c = connection(siteCode);
        List<JsonNode> r = send(c, List.of(Pts2Client.Packet.of("GetFuelGradesConfiguration"),
                Pts2Client.Packet.of("GetPricesSchedulerConfiguration"), Pts2Client.Packet.of("GetDateTime")));
        Map<Integer, Grade> grades = grades(r.get(0));
        List<JsonNode> schedules = configured(r.get(1));
        JsonNode target = schedules.stream().filter(s -> s.path("Id").asInt() == scheduleId).findFirst()
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND,
                        "The PTS-2 has no price schedule " + scheduleId));
        List<Object> rest = new ArrayList<>(schedules.stream().filter(s -> s != target).toList());
        send(c, List.of(new Pts2Client.Packet("SetPricesSchedulerConfiguration", Map.of("PriceSchedules", rest))));

        int gradeId = target.path("FuelGradeId").asInt();
        Grade g = grades.get(gradeId);
        changes.save(new Pts2PriceChange(siteCode, gradeId, g == null ? null : g.name(), g == null ? null : g.price(),
                price(target), Pts2PriceChange.CANCELLED, time(target.path("DateTime").asString(null)), scheduleId, by));
        return prices(siteCode);
    }

    /** Unused slots first, then one-time schedules that have already run; enough for {@code needed} new entries. */
    static List<Integer> freeSlots(List<JsonNode> schedules, int needed, LocalDateTime now) {
        Set<Integer> used = new HashSet<>();
        List<Integer> spent = new ArrayList<>();
        for (JsonNode s : schedules) {
            int id = s.path("Id").asInt();
            used.add(id);
            if (!pending(s, now)) {
                spent.add(id);
            }
        }
        List<Integer> out = new ArrayList<>();
        for (int id = 1; id <= SCHEDULE_SLOTS && out.size() < needed; id++) {
            if (!used.contains(id)) {
                out.add(id);
            }
        }
        spent.sort(Integer::compare);
        for (int i = 0; i < spent.size() && out.size() < needed; i++) {
            out.add(spent.get(i));
        }
        if (out.size() < needed) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, "The PTS-2 prices scheduler is full ("
                    + SCHEDULE_SLOTS + " schedules). Cancel a scheduled change first.");
        }
        return out;
    }

    /** A schedule still to run: enabled and either recurring or set for a time the controller has not reached yet. */
    static boolean pending(JsonNode s, LocalDateTime now) {
        if (!s.path("Enabled").asBoolean(false)) {
            return false;
        }
        if (!days(s).isEmpty()) {
            return true;
        }
        LocalDateTime at = time(s.path("DateTime").asString(null));
        return at != null && at.isAfter(now);
    }

    private Prices view(String siteCode, Map<Integer, Grade> grades, List<JsonNode> schedules, LocalDateTime now) {
        List<Schedule> out = new ArrayList<>();
        for (JsonNode s : schedules) {
            int gradeId = s.path("FuelGradeId").asInt();
            Grade g = grades.get(gradeId);
            out.add(new Schedule(s.path("Id").asInt(), s.path("Enabled").asBoolean(false), gradeId,
                    g == null ? null : g.name(), price(s), s.path("DateTime").asString(null), days(s), pending(s, now)));
        }
        out.sort((a, b) -> String.valueOf(a.dateTime()).compareTo(String.valueOf(b.dateTime())));
        int free = (int) (SCHEDULE_SLOTS - out.stream().filter(Schedule::pending).count());
        return new Prices(siteCode, PTS_TIME.format(now), List.copyOf(grades.values()), out, free);
    }

    /**
     * The controller's local time from a DateTime reply. Scheduled times are in this clock, which can differ from
     * the API server's zone (the VPS runs on UTC). Falls back to the server clock if the controller sends none.
     */
    static LocalDateTime controllerNow(JsonNode packet) {
        LocalDateTime t = time(packet.path("Data").path("DateTime").asString(null));
        return (t != null ? t : LocalDateTime.now()).truncatedTo(ChronoUnit.SECONDS);
    }

    private static Map<Integer, Grade> grades(JsonNode packet) {
        Map<Integer, Grade> out = new LinkedHashMap<>();
        for (JsonNode g : packet.path("Data").path("FuelGrades")) {
            int id = g.path("Id").asInt(0);
            if (id > 0) {
                out.put(id, new Grade(id, g.path("Name").asString(""), price(g)));
            }
        }
        return out;
    }

    /** Scheduler entries that are configured; the controller reports unused slots with no fuel grade. */
    private static List<JsonNode> configured(JsonNode packet) {
        List<JsonNode> out = new ArrayList<>();
        for (JsonNode s : packet.path("Data").path("PriceSchedules")) {
            if (s.path("Id").asInt(0) > 0 && s.path("FuelGradeId").asInt(0) > 0) {
                out.add(s);
            }
        }
        return out;
    }

    private static List<String> days(JsonNode s) {
        List<String> out = new ArrayList<>();
        for (String d : DAYS) {
            if (s.path("Every" + d).asBoolean(false)) {
                out.add(d);
            }
        }
        return out;
    }

    private static BigDecimal price(JsonNode n) {
        JsonNode p = n.get("Price");
        return p != null && p.isNumber() ? p.decimalValue() : null;
    }

    private static LocalDateTime time(String raw) {
        if (raw == null || raw.isBlank()) {
            return null;
        }
        try {
            return LocalDateTime.parse(raw);
        } catch (DateTimeParseException e) {
            return null;
        }
    }

    /** The controller takes up to 9 digits and its pumps show at most 3 decimals. */
    private static void validatePrice(BigDecimal p) {
        if (p == null || p.signum() <= 0) {
            throw bad("A price must be more than zero");
        }
        BigDecimal s = p.stripTrailingZeros();
        if (s.scale() > 3 || s.precision() - Math.min(s.scale(), 0) > 9) {
            throw bad("A price can have at most 9 digits and 3 decimals");
        }
    }

    private Pts2Connection connection(String siteCode) {
        return connections.findBySiteCode(siteCode)
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND, "No PTS-2 connection for " + siteCode));
    }

    /** Sends the packets and fails if the controller cannot be reached or refuses any of them. */
    private List<JsonNode> send(Pts2Connection c, List<Pts2Client.Packet> packets) {
        List<JsonNode> replies;
        try {
            replies = client.send(c, packets);
        } catch (Pts2Client.Pts2Exception e) {
            throw new ResponseStatusException(HttpStatus.BAD_GATEWAY, e.getMessage());
        }
        for (int i = 0; i < replies.size(); i++) {
            JsonNode p = replies.get(i);
            // an older firmware without GetDateTime falls back to the server clock
            if (p.path("Error").asBoolean(false) && !"GetDateTime".equals(packets.get(i).type())) {
                throw new ResponseStatusException(HttpStatus.BAD_GATEWAY, "The PTS-2 refused " + packets.get(i).type()
                        + ": " + p.path("Message").asString("error"));
            }
        }
        return replies;
    }

    private static ResponseStatusException bad(String message) {
        return new ResponseStatusException(HttpStatus.BAD_REQUEST, message);
    }
}
