package com.maestro.fuelorder.delivery;

import com.maestro.fuelorder.delivery.DeliveryRecords.GpsPosition;
import com.maestro.fuelorder.delivery.DeliveryRecords.ProofOfDelivery;
import com.maestro.fuelorder.delivery.DeliveryRecords.TankDelivery;
import com.maestro.fuelorder.sentinel.RiskEvent;
import com.maestro.fuelorder.sentinel.SentinelService;
import com.maestro.fuelorder.site.Site;
import com.maestro.fuelorder.site.SiteCatalog;
import com.maestro.fuelorder.stock.StockMovement;
import com.maestro.fuelorder.stock.StockService;
import jakarta.persistence.EntityManager;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.server.ResponseStatusException;

import java.math.BigDecimal;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicLong;

@Service
public class DeliveryService {

    private static final double ARRIVAL_RADIUS_KM = 0.2;

    private final DeliveryNoteRepository notes;
    private final EntityManager em;
    private final StockService stock;
    private final SentinelService sentinel;
    private final SiteCatalog siteCatalog;
    private final BigDecimal customerSurcharge;
    private final AtomicLong seq = new AtomicLong(2000);

    public DeliveryService(DeliveryNoteRepository notes, EntityManager em, StockService stock,
                           SentinelService sentinel, SiteCatalog siteCatalog,
                           @Value("${maestro.delivery.surcharge-per-litre:0.40}") BigDecimal customerSurcharge) {
        this.notes = notes;
        this.em = em;
        this.stock = stock;
        this.sentinel = sentinel;
        this.siteCatalog = siteCatalog;
        this.customerSurcharge = customerSurcharge;
    }

    @Transactional
    public DeliveryNote plan(String origin, String destinationType, String destSiteCode, String destName,
                             Double lat, Double lng, String customer, String product, BigDecimal planned,
                             String truckReg, String driverName) {
        if (siteCatalog.find(origin).isEmpty()) {
            throw bad("Unknown origin depot " + origin);
        }
        String name = destName;
        Double dLat = lat;
        Double dLng = lng;
        if ("SITE".equals(destinationType)) {
            Site site = siteCatalog.find(destSiteCode).orElseThrow(() -> bad("Unknown destination site " + destSiteCode));
            name = site.getName();
            dLat = lat == null ? Double.valueOf(site.getLatitude()) : lat;
            dLng = lng == null ? Double.valueOf(site.getLongitude()) : lng;
        } else if (!"CUSTOMER".equals(destinationType)) {
            throw bad("destinationType must be SITE or CUSTOMER");
        } else if (customer == null || customer.isBlank() || name == null || name.isBlank()) {
            throw bad("A customer delivery needs the customer and a destination name");
        }
        // special delivery surcharge applies only to deliveries to a customer's own site
        BigDecimal surcharge = "CUSTOMER".equals(destinationType) ? customerSurcharge : BigDecimal.ZERO;
        return notes.save(new DeliveryNote("DN-" + seq.incrementAndGet(), origin, destinationType,
                destSiteCode, name, dLat, dLng, customer, product, planned, truckReg, driverName, surcharge));
    }

    @Transactional
    public DeliveryNote load(UUID id, BigDecimal loaded, String seals) {
        DeliveryNote d = require(id, DeliveryNote.PLANNED);
        d.loadedLitres = loaded;
        d.sealNumbers = seals;
        d.status = DeliveryNote.LOADING;
        stock.record(d.originSiteCode, d.product, StockMovement.DELIVERY_OUT, loaded.negate(), "DELIVERY", d.id);
        return notes.save(d);
    }

    @Transactional
    public DeliveryNote depart(UUID id) {
        DeliveryNote d = require(id, DeliveryNote.LOADING);
        d.status = DeliveryNote.IN_TRANSIT;
        return notes.save(d);
    }

    /** A tracker position; getting within 200 m of the destination marks the truck as arrived. */
    @Transactional
    public DeliveryNote gps(UUID id, double lat, double lng, Double speed) {
        DeliveryNote d = notes.findById(id).orElseThrow(() -> notFound());
        em.persist(new GpsPosition(id, lat, lng, speed));
        if (DeliveryNote.IN_TRANSIT.equals(d.status) && d.destLat != null && d.destLng != null
                && haversineKm(lat, lng, d.destLat, d.destLng) <= ARRIVAL_RADIUS_KM) {
            d.status = DeliveryNote.ARRIVED;
            notes.save(d);
        }
        return d;
    }

    @Transactional
    public DeliveryNote offload(UUID id, BigDecimal delivered) {
        DeliveryNote d = require(id, DeliveryNote.ARRIVED);
        d.deliveredLitres = delivered;
        d.status = DeliveryNote.OFFLOADED;
        if ("SITE".equals(d.destinationType)) {
            stock.record(d.destinationSiteCode, d.product, StockMovement.DELIVERY_IN, delivered, "DELIVERY", d.id);
            em.persist(new TankDelivery(d.id, d.destinationSiteCode, d.product, d.loadedLitres, delivered));
        }
        BigDecimal shortage = d.loadedLitres.subtract(delivered);
        BigDecimal tolerance = BigDecimal.valueOf(20).max(d.loadedLitres.multiply(new BigDecimal("0.005")));
        if (shortage.compareTo(tolerance) > 0) {
            sentinel.raise("DELIVERY_SHORTAGE", RiskEvent.CRITICAL, d.customer, d.destinationSiteCode, d.truckReg,
                    d.driverName, null, "DELIVERY", d.id,
                    "%s loaded %s L but %s L was received (short %s L)".formatted(d.number, d.loadedLitres, delivered, shortage),
                    "HOLD_POD", Map.of("deliveryNote", d.number, "loadedLitres", d.loadedLitres,
                            "deliveredLitres", delivered, "seals", String.valueOf(d.sealNumbers)));
        }
        return notes.save(d);
    }

    @Transactional
    public ProofOfDelivery pod(UUID id, String signedBy, String signature, String notesText) {
        DeliveryNote d = require(id, DeliveryNote.OFFLOADED);
        d.status = DeliveryNote.COMPLETED;
        notes.save(d);
        ProofOfDelivery p = new ProofOfDelivery(id, signedBy, signature, notesText, d.deliveredLitres);
        em.persist(p);
        return p;
    }

    public List<GpsPosition> track(UUID id) {
        return em.createQuery("select g from GpsPosition g where g.deliveryId = :id order by g.at", GpsPosition.class)
                .setParameter("id", id).getResultList();
    }

    public List<ProofOfDelivery> podOf(UUID id) {
        return em.createQuery("select p from ProofOfDelivery p where p.deliveryId = :id", ProofOfDelivery.class)
                .setParameter("id", id).getResultList();
    }

    public List<TankDelivery> tankDeliveries() {
        return em.createQuery("select t from TankDelivery t order by t.at desc", TankDelivery.class).getResultList();
    }

    private DeliveryNote require(UUID id, String status) {
        DeliveryNote d = notes.findById(id).orElseThrow(() -> notFound());
        if (!status.equals(d.status)) {
            throw new ResponseStatusException(HttpStatus.CONFLICT,
                    d.number + " is " + d.status + ", it must be " + status + " for this step");
        }
        return d;
    }

    static double haversineKm(double lat1, double lon1, double lat2, double lon2) {
        double r = 6371.0;
        double dLat = Math.toRadians(lat2 - lat1);
        double dLon = Math.toRadians(lon2 - lon1);
        double a = Math.sin(dLat / 2) * Math.sin(dLat / 2)
                + Math.cos(Math.toRadians(lat1)) * Math.cos(Math.toRadians(lat2)) * Math.sin(dLon / 2) * Math.sin(dLon / 2);
        return r * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    }

    private static ResponseStatusException bad(String m) {
        return new ResponseStatusException(HttpStatus.BAD_REQUEST, m);
    }

    private static ResponseStatusException notFound() {
        return new ResponseStatusException(HttpStatus.NOT_FOUND, "Delivery not found");
    }
}
