package com.maestro.fuelorder.site;

import com.maestro.fuelorder.auth.Access;
import com.maestro.fuelorder.auth.AuthService;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.validation.Valid;
import jakarta.validation.constraints.DecimalMax;
import jakarta.validation.constraints.DecimalMin;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Size;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.*;

import java.math.BigDecimal;
import java.util.List;

@RestController
@RequestMapping("/api/v1/sites")
public class SiteController {

    /** The PTS-2 ID identifies a controller, so only staff see it. */
    public record SiteView(String code, String name, String kind, String pts2Id, double latitude, double longitude) {}

    public record TankRequest(@NotBlank String product,
                              @NotNull @DecimalMin("1") BigDecimal capacityLitres,
                              @NotNull @DecimalMin("0") BigDecimal reorderLitres,
                              @DecimalMin("0") BigDecimal openingLitres) {}

    public record CreateRequest(@NotBlank @Size(max = 120) String name,
                                @NotBlank String kind,
                                @NotBlank @Size(max = 80) String pts2Id,
                                @Size(max = 30) String code,
                                @NotNull @DecimalMin("-90") @DecimalMax("90") Double latitude,
                                @NotNull @DecimalMin("-180") @DecimalMax("180") Double longitude,
                                List<@Valid TankRequest> tanks) {}

    private final SiteCatalog catalog;

    public SiteController(SiteCatalog catalog) {
        this.catalog = catalog;
    }

    @GetMapping
    public List<SiteView> list(HttpServletRequest request) {
        boolean staff = !Access.isCustomer(Access.session(request));
        return catalog.all().stream().map(s -> view(s, staff)).toList();
    }

    /** Registers a station, depot or fuel depot by the ID of its PTS-2 controller. */
    @PostMapping
    @ResponseStatus(HttpStatus.CREATED)
    public SiteView create(@RequestBody @Valid CreateRequest req, HttpServletRequest request) {
        AuthService.Session s = Access.session(request);
        Access.requireOmc(s);
        List<SiteCatalog.TankSpec> tanks = req.tanks() == null ? List.of() : req.tanks().stream()
                .map(t -> new SiteCatalog.TankSpec(t.product(), t.capacityLitres(), t.reorderLitres(), t.openingLitres()))
                .toList();
        return view(catalog.create(req.name(), req.kind(), req.pts2Id(), req.code(), req.latitude(), req.longitude(), tanks), true);
    }

    private static SiteView view(Site s, boolean staff) {
        return new SiteView(s.getCode(), s.getName(), s.getKind(), staff ? s.getPts2Id() : null, s.getLatitude(), s.getLongitude());
    }
}
