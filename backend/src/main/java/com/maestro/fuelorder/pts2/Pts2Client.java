package com.maestro.fuelorder.pts2;

import org.springframework.stereotype.Component;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.node.ArrayNode;
import tools.jackson.databind.node.ObjectNode;

import javax.net.ssl.SSLContext;
import javax.net.ssl.SSLEngine;
import javax.net.ssl.X509ExtendedTrustManager;
import java.io.IOException;
import java.net.Socket;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.security.SecureRandom;
import java.security.cert.X509Certificate;
import java.time.Duration;
import java.util.Base64;
import java.util.HashMap;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Minimal jsonPTS client: POSTs {"Protocol":"jsonPTS","Packets":[...]} to the controller and returns the response
 * packets in order. The controller asks for HTTP Digest or Basic auth depending on its DIP switches, so both are
 * answered from the 401 challenge. HTTPS uses the controller's self-signed certificate, which cannot be verified.
 */
@Component
public class Pts2Client {

    /** One request packet: its jsonPTS type and optional data object. */
    public record Packet(String type, Map<String, Object> data) {
        public static Packet of(String type) { return new Packet(type, null); }
    }

    public static class Pts2Exception extends RuntimeException {
        public Pts2Exception(String message) { super(message); }
        public Pts2Exception(String message, Throwable cause) { super(message, cause); }
    }

    private record Challenge(Map<String, String> params, AtomicInteger nc) {}

    private static final Pattern PARAM = Pattern.compile("(\\w+)=(?:\"([^\"]*)\"|([^,\\s]+))");

    private final ObjectMapper json = new ObjectMapper();
    private final HttpClient http;
    /** Last Digest challenge per URL, so a poll usually needs one round trip instead of two. */
    private final Map<String, Challenge> challenges = new ConcurrentHashMap<>();

    public Pts2Client() {
        this.http = HttpClient.newBuilder()
                .connectTimeout(Duration.ofSeconds(5))
                .sslContext(trustingContext())
                .build();
    }

    public List<JsonNode> send(Pts2Connection c, List<Packet> packets) {
        ObjectNode body = json.createObjectNode().put("Protocol", "jsonPTS");
        ArrayNode list = body.putArray("Packets");
        for (int i = 0; i < packets.size(); i++) {
            ObjectNode p = list.addObject().put("Id", i + 1).put("Type", packets.get(i).type());
            if (packets.get(i).data() != null) {
                p.set("Data", json.valueToTree(packets.get(i).data()));
            }
        }
        String payload = json.writeValueAsString(body);
        URI uri = URI.create(c.getUrl());

        HttpResponse<String> res = post(uri, payload, authorization(c, uri));
        if (res.statusCode() == 401) {
            String challenge = res.headers().firstValue("WWW-Authenticate").orElse("");
            if (challenge.regionMatches(true, 0, "Digest", 0, 6)) {
                challenges.put(c.getUrl(), new Challenge(parse(challenge), new AtomicInteger()));
            } else {
                challenges.remove(c.getUrl());
            }
            res = post(uri, payload, authorization(c, uri));
            if (res.statusCode() == 401) {
                challenges.remove(c.getUrl());
                throw new Pts2Exception("The PTS-2 rejected the username or password");
            }
        }
        if (res.statusCode() / 100 != 2) {
            throw new Pts2Exception("The PTS-2 answered HTTP " + res.statusCode());
        }
        JsonNode reply;
        try {
            reply = json.readTree(res.body());
        } catch (RuntimeException e) {
            throw new Pts2Exception("The PTS-2 sent a reply that is not jsonPTS", e);
        }
        JsonNode out = reply.path("Packets");
        if (!out.isArray()) {
            throw new Pts2Exception("The PTS-2 reply has no packets");
        }
        // replies carry the request Id; order them to match the request
        JsonNode[] ordered = new JsonNode[packets.size()];
        for (JsonNode p : out) {
            int id = p.path("Id").asInt(0);
            if (id >= 1 && id <= ordered.length) {
                ordered[id - 1] = p;
            }
        }
        return java.util.Arrays.stream(ordered).map(p -> p == null ? json.createObjectNode() : p).toList();
    }

    private HttpResponse<String> post(URI uri, String payload, String authorization) {
        HttpRequest.Builder b = HttpRequest.newBuilder(uri)
                .timeout(Duration.ofSeconds(10))
                .header("Content-Type", "application/json")
                .POST(HttpRequest.BodyPublishers.ofString(payload, StandardCharsets.UTF_8));
        if (authorization != null) {
            b.header("Authorization", authorization);
        }
        try {
            return http.send(b.build(), HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
        } catch (IOException e) {
            throw new Pts2Exception("Cannot reach the PTS-2 at " + uri.getHost() + ": "
                    + (e.getMessage() == null ? e.getClass().getSimpleName() : e.getMessage()), e);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new Pts2Exception("Interrupted while calling the PTS-2", e);
        }
    }

    /** Digest when the controller has challenged us before, otherwise Basic (which the controller may refuse). */
    private String authorization(Pts2Connection c, URI uri) {
        Challenge ch = challenges.get(c.getUrl());
        if (ch == null) {
            return "Basic " + Base64.getEncoder().encodeToString(
                    (c.getUsername() + ":" + c.getPassword()).getBytes(StandardCharsets.UTF_8));
        }
        Map<String, String> p = ch.params();
        String realm = p.getOrDefault("realm", "");
        String nonce = p.getOrDefault("nonce", "");
        String path = uri.getRawPath() == null || uri.getRawPath().isEmpty() ? "/" : uri.getRawPath();
        String qop = p.get("qop") == null ? null : (p.get("qop").contains("auth") ? "auth" : p.get("qop"));
        String ha1 = md5(c.getUsername() + ":" + realm + ":" + c.getPassword());
        String ha2 = md5("POST:" + path);
        StringBuilder h = new StringBuilder("Digest username=\"").append(c.getUsername())
                .append("\", realm=\"").append(realm).append("\", nonce=\"").append(nonce)
                .append("\", uri=\"").append(path).append('"');
        if (qop != null) {
            String nc = "%08x".formatted(ch.nc().incrementAndGet());
            byte[] raw = new byte[8];
            new SecureRandom().nextBytes(raw);
            String cnonce = HexFormat.of().formatHex(raw);
            h.append(", qop=").append(qop).append(", nc=").append(nc).append(", cnonce=\"").append(cnonce)
                    .append("\", response=\"").append(md5(ha1 + ":" + nonce + ":" + nc + ":" + cnonce + ":" + qop + ":" + ha2)).append('"');
        } else {
            h.append(", response=\"").append(md5(ha1 + ":" + nonce + ":" + ha2)).append('"');
        }
        if (p.containsKey("opaque")) {
            h.append(", opaque=\"").append(p.get("opaque")).append('"');
        }
        if (p.containsKey("algorithm")) {
            h.append(", algorithm=").append(p.get("algorithm"));
        }
        return h.toString();
    }

    static Map<String, String> parse(String header) {
        Map<String, String> out = new HashMap<>();
        Matcher m = PARAM.matcher(header.substring(Math.min(header.length(), 6)));
        while (m.find()) {
            out.put(m.group(1).toLowerCase(), m.group(2) != null ? m.group(2) : m.group(3));
        }
        return out;
    }

    private static String md5(String s) {
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("MD5").digest(s.getBytes(StandardCharsets.UTF_8)));
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
    }

    /** The PTS-2 serves a self-signed certificate on a LAN address, so neither the chain nor the host can be checked. */
    private static SSLContext trustingContext() {
        X509ExtendedTrustManager trustAll = new X509ExtendedTrustManager() {
            public void checkClientTrusted(X509Certificate[] chain, String authType) {}
            public void checkServerTrusted(X509Certificate[] chain, String authType) {}
            public void checkClientTrusted(X509Certificate[] chain, String authType, Socket socket) {}
            public void checkServerTrusted(X509Certificate[] chain, String authType, Socket socket) {}
            public void checkClientTrusted(X509Certificate[] chain, String authType, SSLEngine engine) {}
            public void checkServerTrusted(X509Certificate[] chain, String authType, SSLEngine engine) {}
            public X509Certificate[] getAcceptedIssuers() { return new X509Certificate[0]; }
        };
        try {
            SSLContext ctx = SSLContext.getInstance("TLS");
            ctx.init(null, new javax.net.ssl.TrustManager[]{trustAll}, new SecureRandom());
            return ctx;
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }
}
