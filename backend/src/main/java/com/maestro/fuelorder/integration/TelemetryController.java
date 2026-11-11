package com.maestro.fuelorder.integration;

import com.maestro.fuelorder.auth.Access;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.validation.Valid;
import jakarta.validation.constraints.DecimalMin;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import org.springframework.web.bind.annotation.*;

import java.math.BigDecimal;
import java.time.Instant;
import java.util.List;
import java.util.Map;

/** Site edge agents that cannot speak MQTT post batches here; staff read the latest state. */
@RestController
@RequestMapping("/api/v1/telemetry")
public class TelemetryController {

    public record TankMessage(@NotBlank String siteCode, @NotBlank String product,
                              @NotNull @DecimalMin("0") BigDecimal volumeL, BigDecimal tempC, BigDecimal waterMm, Instant ts) {}

    public record PumpMessage(@NotBlank String siteCode, @NotBlank String pumpId, @NotBlank String kind,
                              BigDecimal value, Instant ts) {}

    private final TelemetryService telemetry;
    private final TankReadingRepository readings;
    private final PumpEventRepository pumpEvents;
    private final DeviceStatusRepository devices;

    public TelemetryController(TelemetryService telemetry, TankReadingRepository readings,
                               PumpEventRepository pumpEvents, DeviceStatusRepository devices) {
        this.telemetry = telemetry;
        this.readings = readings;
        this.pumpEvents = pumpEvents;
        this.devices = devices;
    }

    @PostMapping("/tank")
    public Map<String, Object> tank(@RequestBody @Valid TankMessage m, HttpServletRequest request) {
        Access.requireStaff(Access.session(request));
        boolean stored = telemetry.ingestTank(m.siteCode(), m.product(), m.volumeL(), m.tempC(), m.waterMm(),
                m.ts() == null ? Instant.now() : m.ts());
        return Map.of("stored", stored);
    }

    @PostMapping("/pump")
    public Map<String, Object> pump(@RequestBody @Valid PumpMessage m, HttpServletRequest request) {
        Access.requireStaff(Access.session(request));
        boolean stored = telemetry.ingestPump(m.siteCode(), m.pumpId(), m.kind(), m.value(),
                m.ts() == null ? Instant.now() : m.ts());
        return Map.of("stored", stored);
    }

    @GetMapping("/tanks")
    public List<TankReading> latestTankReadings(HttpServletRequest request) {
        Access.requireStaff(Access.session(request));
        return readings.findTop300ByOrderByAtDesc();
    }

    @GetMapping("/pumps")
    public List<PumpEvent> latestPumpEvents(HttpServletRequest request) {
        Access.requireStaff(Access.session(request));
        return pumpEvents.findTop200ByOrderByAtDesc();
    }

    @GetMapping("/devices")
    public List<DeviceStatus> devices(HttpServletRequest request) {
        Access.requireStaff(Access.session(request));
        return devices.findAll();
    }
}
