package com.maestro.fuelorder.integration;

import io.moquette.broker.Server;
import io.moquette.broker.config.MemoryConfig;
import jakarta.annotation.PreDestroy;
import org.eclipse.paho.client.mqttv3.IMqttDeliveryToken;
import org.eclipse.paho.client.mqttv3.MqttCallbackExtended;
import org.eclipse.paho.client.mqttv3.MqttClient;
import org.eclipse.paho.client.mqttv3.MqttConnectOptions;
import org.eclipse.paho.client.mqttv3.MqttMessage;
import org.eclipse.paho.client.mqttv3.persist.MemoryPersistence;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.context.event.ApplicationReadyEvent;
import org.springframework.context.event.EventListener;
import org.springframework.stereotype.Component;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

import java.math.BigDecimal;
import java.time.Instant;
import java.util.Properties;

/**
 * Starts an embedded MQTT broker for local development and subscribes the ingest consumer to it.
 * Topic scheme: maestro/{siteCode}/tank/{product}/reading, maestro/{siteCode}/pump/{pumpId}/event.
 * In production the broker is external (EMQX with mTLS) and only the subscriber runs.
 */
@Component
public class MqttIngest implements MqttCallbackExtended {

    private static final Logger log = LoggerFactory.getLogger(MqttIngest.class);

    private final TelemetryService telemetry;
    private final ObjectMapper mapper;
    private final boolean enabled;
    private final boolean embedded;
    private final int port;
    private final String url;
    private Server broker;
    private MqttClient client;

    public MqttIngest(TelemetryService telemetry, ObjectMapper mapper,
                      @Value("${maestro.mqtt.enabled:true}") boolean enabled,
                      @Value("${maestro.mqtt.embedded:true}") boolean embedded,
                      @Value("${maestro.mqtt.port:1883}") int port,
                      @Value("${maestro.mqtt.url:}") String url) {
        this.telemetry = telemetry;
        this.mapper = mapper;
        this.enabled = enabled;
        this.embedded = embedded;
        this.port = port;
        this.url = url.isBlank() ? "tcp://127.0.0.1:" + port : url;
    }

    @EventListener(ApplicationReadyEvent.class)
    public void start() {
        if (!enabled) {
            log.info("MQTT ingest disabled");
            return;
        }
        try {
            if (embedded) {
                Properties p = new Properties();
                p.setProperty("host", "127.0.0.1");
                p.setProperty("port", String.valueOf(port));
                p.setProperty("allow_anonymous", "true"); // dev only: production uses mTLS device certificates
                p.setProperty("persistence_enabled", "false");
                p.setProperty("telemetry_enabled", "false"); // do not let the broker phone home
                broker = new Server();
                broker.startServer(new MemoryConfig(p));
                log.info("Embedded MQTT broker listening on 127.0.0.1:{}", port);
            }
            client = new MqttClient(url, "maestro-ingest", new MemoryPersistence());
            client.setCallback(this);
            MqttConnectOptions o = new MqttConnectOptions();
            o.setAutomaticReconnect(true);
            o.setCleanSession(false);
            client.connect(o);
        } catch (Exception e) {
            log.error("MQTT ingest could not start (is port {} free?): {}", port, e.getMessage());
        }
    }

    @Override
    public void connectComplete(boolean reconnect, String serverURI) {
        try {
            client.subscribe("maestro/#", 1);
            log.info("MQTT ingest subscribed to maestro/# on {}", serverURI);
        } catch (Exception e) {
            log.error("MQTT subscribe failed: {}", e.getMessage());
        }
    }

    @Override
    public void connectionLost(Throwable cause) {
        log.warn("MQTT connection lost: {}", cause == null ? "" : cause.getMessage());
    }

    @Override
    public void messageArrived(String topic, MqttMessage message) {
        try {
            String[] t = topic.split("/");
            if (t.length < 5 || !"maestro".equals(t[0])) {
                return;
            }
            JsonNode n = mapper.readTree(new String(message.getPayload(), java.nio.charset.StandardCharsets.UTF_8));
            Instant at = n.hasNonNull("ts") ? Instant.parse(n.get("ts").asText()) : Instant.now();
            String site = t[1];
            if ("tank".equals(t[2])) {
                telemetry.ingestTank(site, t[3], dec(n, "volumeL"), n.hasNonNull("tempC") ? dec(n, "tempC") : null,
                        n.hasNonNull("waterMm") ? dec(n, "waterMm") : null, at);
            } else if ("pump".equals(t[2])) {
                telemetry.ingestPump(site, t[3], n.path("kind").asText("HEARTBEAT"),
                        n.hasNonNull("value") ? dec(n, "value") : null, at);
            }
        } catch (Exception e) {
            log.warn("Bad telemetry on {}: {}", topic, e.getMessage());
        }
    }

    private static BigDecimal dec(JsonNode n, String field) {
        return new BigDecimal(n.get(field).asText());
    }

    @Override
    public void deliveryComplete(IMqttDeliveryToken token) {
        // subscriber only
    }

    @PreDestroy
    public void stop() {
        try {
            if (client != null && client.isConnected()) {
                client.disconnect();
                client.close();
            }
        } catch (Exception ignored) {
            // shutting down
        }
        if (broker != null) {
            broker.stopServer();
        }
    }
}
