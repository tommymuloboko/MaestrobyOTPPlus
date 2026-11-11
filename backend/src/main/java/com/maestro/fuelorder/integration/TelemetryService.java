package com.maestro.fuelorder.integration;

import com.maestro.fuelorder.sentinel.RiskEvent;
import com.maestro.fuelorder.sentinel.SentinelService;
import com.maestro.fuelorder.site.SiteCatalog;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.math.BigDecimal;
import java.math.RoundingMode;
import java.time.Duration;
import java.time.Instant;
import java.util.Map;

/**
 * The cloud tier of the Integration Layer. Devices (or the site edge agent) publish over MQTT or HTTP;
 * everything funnels through here. Messages can arrive twice or late after a link outage, so each one
 * is de-duplicated on its device timestamp.
 */
@Service
public class TelemetryService {

    private static final Logger log = LoggerFactory.getLogger(TelemetryService.class);

    private final TankReadingRepository readings;
    private final PumpEventRepository pumpEvents;
    private final DeviceStatusRepository devices;
    private final SentinelService sentinel;
    private final SiteCatalog siteCatalog;
    private final Duration offlineAfter;

    public TelemetryService(TankReadingRepository readings, PumpEventRepository pumpEvents,
                            DeviceStatusRepository devices, SentinelService sentinel, SiteCatalog siteCatalog,
                            @Value("${maestro.telemetry.offline-after-seconds:300}") long offlineAfterSeconds) {
        this.readings = readings;
        this.pumpEvents = pumpEvents;
        this.devices = devices;
        this.sentinel = sentinel;
        this.siteCatalog = siteCatalog;
        this.offlineAfter = Duration.ofSeconds(offlineAfterSeconds);
    }

    /** Approximate correction of a volume to 15 degrees C (diesel ~0.083%/degC, petrol ~0.118%/degC). */
    static BigDecimal toStandardTemperature(String product, BigDecimal volume, BigDecimal tempC) {
        if (tempC == null) {
            return volume;
        }
        BigDecimal k = new BigDecimal(product.startsWith("ULP") ? "0.00118" : "0.00083");
        BigDecimal factor = BigDecimal.ONE.subtract(k.multiply(tempC.subtract(BigDecimal.valueOf(15))));
        return volume.multiply(factor).setScale(2, RoundingMode.HALF_UP);
    }

    @Transactional
    public boolean ingestTank(String siteOrControllerId, String product, BigDecimal volume, BigDecimal tempC,
                              BigDecimal waterMm, Instant deviceTime) {
        // a PTS-2 controller identifies itself by its own ID; the reading belongs to the site it is registered to
        String siteCode = siteCatalog.resolve(siteOrControllerId);
        Instant at = deviceTime.truncatedTo(java.time.temporal.ChronoUnit.MILLIS);
        touch(siteCode + "/atg/" + product, siteCode, "ATG");
        if (readings.existsBySiteCodeAndProductAndAt(siteCode, product, at)) {
            return false;
        }
        readings.save(new TankReading(siteCode, product, volume, tempC, waterMm,
                toStandardTemperature(product, volume, tempC), at));
        return true;
    }

    @Transactional
    public boolean ingestPump(String siteOrControllerId, String pumpId, String kind, BigDecimal value, Instant deviceTime) {
        String siteCode = siteCatalog.resolve(siteOrControllerId);
        Instant at = deviceTime.truncatedTo(java.time.temporal.ChronoUnit.MILLIS);
        touch(siteCode + "/pump/" + pumpId, siteCode, "PUMP");
        if (pumpEvents.existsBySiteCodeAndPumpIdAndKindAndAt(siteCode, pumpId, kind, at)) {
            return false;
        }
        pumpEvents.save(new PumpEvent(siteCode, pumpId, kind, value, at));
        return true;
    }

    @Transactional
    public void touch(String deviceId, String siteCode, String kind) {
        DeviceStatus d = devices.findByDeviceId(deviceId).orElseGet(() -> new DeviceStatus(deviceId, siteCode, kind));
        d.lastSeen = Instant.now();
        d.online = true;
        devices.save(d);
    }

    /** A controller that stops reporting is a security event: someone may have unplugged it. */
    @Scheduled(fixedDelayString = "${maestro.telemetry.check-ms:30000}")
    public void checkDevices() {
        Instant cutoff = Instant.now().minus(offlineAfter);
        for (DeviceStatus d : devices.findAll()) {
            if (d.online && d.lastSeen.isBefore(cutoff)) {
                d.online = false;
                devices.save(d);
                try {
                    sentinel.raise("CONTROLLER_OFFLINE", RiskEvent.HIGH, null, d.siteCode, null, null, null,
                            "DEVICE", d.id, d.deviceId + " has not reported for over "
                                    + offlineAfter.toMinutes() + " minutes", "REMOTE_AUTH_DISABLED",
                            Map.of("device", d.deviceId, "lastSeen", d.lastSeen.toString()));
                } catch (RuntimeException e) {
                    log.warn("Could not raise CONTROLLER_OFFLINE: {}", e.getMessage());
                }
            }
        }
    }
}
