package com.maestro.fuelorder.delivery;

import com.maestro.fuelorder.auth.Access;
import com.maestro.fuelorder.auth.AuthService;
import com.maestro.fuelorder.delivery.DeliveryRecords.GpsPosition;
import com.maestro.fuelorder.delivery.DeliveryRecords.ProofOfDelivery;
import com.maestro.fuelorder.delivery.DeliveryRecords.TankDelivery;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.validation.Valid;
import jakarta.validation.constraints.DecimalMin;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.server.ResponseStatusException;

import java.math.BigDecimal;
import java.util.List;
import java.util.UUID;

@RestController
@RequestMapping("/api/v1/deliveries")
public class DeliveryController {

    public record PlanRequest(@NotBlank String originSiteCode, @NotBlank String destinationType, String destinationSiteCode,
                              String destinationName, Double lat, Double lng, String customer, @NotBlank String product,
                              @NotNull @DecimalMin("1") BigDecimal plannedLitres, @NotBlank String truckReg,
                              @NotBlank String driverName) {}
    public record LoadRequest(@NotNull @DecimalMin("1") BigDecimal loadedLitres, String sealNumbers) {}
    public record GpsRequest(double lat, double lng, Double speedKph) {}
    public record OffloadRequest(@NotNull @DecimalMin("0") BigDecimal deliveredLitres) {}
    public record PodRequest(@NotBlank String signedBy, String signature, String notes) {}
    public record Detail(DeliveryNote delivery, List<GpsPosition> track, List<ProofOfDelivery> proof) {}

    private final DeliveryService service;
    private final DeliveryNoteRepository notes;

    public DeliveryController(DeliveryService service, DeliveryNoteRepository notes) {
        this.service = service;
        this.notes = notes;
    }

    @GetMapping
    public List<DeliveryNote> list(HttpServletRequest request) {
        AuthService.Session s = Access.session(request);
        List<DeliveryNote> all = Access.isCustomer(s) ? notes.findByCustomer(s.organization()) : notes.findAll();
        return all.stream().sorted((a, b) -> b.createdAt.compareTo(a.createdAt)).toList();
    }

    @GetMapping("/{id}")
    public Detail detail(@PathVariable UUID id, HttpServletRequest request) {
        DeliveryNote d = visible(id, Access.session(request));
        return new Detail(d, service.track(id), service.podOf(id));
    }

    @GetMapping("/tank-deliveries")
    public List<TankDelivery> tankDeliveries(HttpServletRequest request) {
        Access.requireStaff(Access.session(request));
        return service.tankDeliveries();
    }

    @PostMapping
    @ResponseStatus(HttpStatus.CREATED)
    public DeliveryNote plan(@RequestBody @Valid PlanRequest r, HttpServletRequest request) {
        Access.requireSupplier(Access.session(request));
        return service.plan(r.originSiteCode(), r.destinationType(), r.destinationSiteCode(), r.destinationName(),
                r.lat(), r.lng(), r.customer(), r.product(), r.plannedLitres(), r.truckReg(), r.driverName());
    }

    @PostMapping("/{id}/load")
    public DeliveryNote load(@PathVariable UUID id, @RequestBody @Valid LoadRequest r, HttpServletRequest request) {
        Access.requireSupplier(Access.session(request));
        return service.load(id, r.loadedLitres(), r.sealNumbers());
    }

    @PostMapping("/{id}/depart")
    public DeliveryNote depart(@PathVariable UUID id, HttpServletRequest request) {
        Access.requireSupplier(Access.session(request));
        return service.depart(id);
    }

    /** Truck tracker position. */
    @PostMapping("/{id}/gps")
    public DeliveryNote gps(@PathVariable UUID id, @RequestBody GpsRequest r, HttpServletRequest request) {
        Access.requireStaff(Access.session(request));
        return service.gps(id, r.lat(), r.lng(), r.speedKph());
    }

    @PostMapping("/{id}/offload")
    public DeliveryNote offload(@PathVariable UUID id, @RequestBody @Valid OffloadRequest r, HttpServletRequest request) {
        Access.requireSupplier(Access.session(request));
        return service.offload(id, r.deliveredLitres());
    }

    @PostMapping("/{id}/pod")
    public ProofOfDelivery pod(@PathVariable UUID id, @RequestBody @Valid PodRequest r, HttpServletRequest request) {
        Access.requireSupplier(Access.session(request));
        return service.pod(id, r.signedBy(), r.signature(), r.notes());
    }

    private DeliveryNote visible(UUID id, AuthService.Session s) {
        DeliveryNote d = notes.findById(id).orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND, "Delivery not found"));
        if (Access.isCustomer(s) && !s.organization().equals(d.customer)) {
            throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Delivery not found");
        }
        return d;
    }
}
