package com.maestro.fuelorder.site;

import com.maestro.fuelorder.pricing.ListPriceRepository;
import com.maestro.fuelorder.stock.Tank;
import com.maestro.fuelorder.stock.TankRepository;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.server.ResponseStatusException;

import java.math.BigDecimal;
import java.time.Instant;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Optional;
import java.util.Set;
import java.util.regex.Pattern;

/** Looks sites up by code or PTS-2 controller ID and registers new ones. */
@Service
public class SiteCatalog {

    private static final Pattern PTS2_ID = Pattern.compile("[A-Z0-9:_-]{6,64}");
    private static final Pattern CODE = Pattern.compile("[A-Z0-9][A-Z0-9-]{2,29}");
    private static final Set<String> KINDS = Set.of(Site.STATION, Site.DEPOT, Site.FUEL_DEPOT);

    /** A tank to set up with the site. Opening stock defaults to empty. */
    public record TankSpec(String product, BigDecimal capacityLitres, BigDecimal reorderLitres, BigDecimal openingLitres) {}

    private final SiteRepository sites;
    private final TankRepository tanks;
    private final ListPriceRepository prices;

    public SiteCatalog(SiteRepository sites, TankRepository tanks, ListPriceRepository prices) {
        this.sites = sites;
        this.tanks = tanks;
        this.prices = prices;
    }

    public Optional<Site> find(String code) {
        return code == null || code.isBlank() ? Optional.empty() : sites.findByCodeIgnoreCase(code.trim());
    }

    /** In the order the sites were registered. */
    public List<Site> all() {
        return sites.findAllByOrderByCreatedAtAscCodeAsc();
    }

    /** A PTS-2 ID as entered by a person: no spaces, upper case. */
    public static String normalizePts2(String raw) {
        return raw == null ? "" : raw.replaceAll("\\s+", "").toUpperCase(Locale.ROOT);
    }

    /**
     * The site code for whatever a device or agent identified itself with: a site code, or the ID of the site's PTS-2
     * controller. Anything unrecognised is returned unchanged.
     */
    public String resolve(String idOrCode) {
        if (idOrCode == null || idOrCode.isBlank()) {
            return idOrCode;
        }
        return find(idOrCode).map(Site::getCode)
                .or(() -> sites.findByPts2Id(normalizePts2(idOrCode)).map(Site::getCode))
                .orElse(idOrCode);
    }

    @Transactional
    public Site create(String name, String kind, String pts2IdRaw, String codeRaw, double latitude, double longitude,
                       List<TankSpec> tankSpecs) {
        String pts2Id = normalizePts2(pts2IdRaw);
        if (!PTS2_ID.matcher(pts2Id).matches()) {
            throw bad("The PTS-2 controller ID must be 6 to 64 letters, digits, colons, dashes or underscores");
        }
        if (!KINDS.contains(kind)) {
            throw bad("The site type must be STATION, DEPOT or FUEL_DEPOT");
        }
        if (name == null || name.isBlank()) {
            throw bad("The site needs a name");
        }
        String code = codeRaw == null || codeRaw.isBlank() ? nextCode() : codeRaw.trim().toUpperCase(Locale.ROOT);
        if (!CODE.matcher(code).matches()) {
            throw bad("The site code must be 3 to 30 letters, digits or dashes, such as SITE-004");
        }
        if (sites.existsByPts2Id(pts2Id)) {
            throw new IllegalStateException("A site is already registered for PTS-2 controller " + pts2Id);
        }
        if (sites.existsByCodeIgnoreCase(code)) {
            throw new IllegalStateException("A site with code " + code + " already exists");
        }
        List<TankSpec> specs = tankSpecs == null ? List.of() : tankSpecs;
        Set<String> seen = new HashSet<>();
        for (TankSpec t : specs) {
            validate(t, seen);
        }

        Site site = sites.save(new Site(code, name.trim(), kind, pts2Id, latitude, longitude, Instant.now()));
        for (TankSpec t : specs) {
            tanks.save(new Tank(code, t.product(), t.capacityLitres(),
                    t.openingLitres() == null ? BigDecimal.ZERO : t.openingLitres(), t.reorderLitres()));
        }
        return site;
    }

    private void validate(TankSpec t, Set<String> seen) {
        if (t.product() == null || prices.findByProduct(t.product()).isEmpty()) {
            throw bad("Unknown fuel product " + t.product() + " (it has no list price)");
        }
        if (!seen.add(t.product())) {
            throw bad("Each product can have only one tank at a site (" + t.product() + " is listed twice)");
        }
        if (t.capacityLitres() == null || t.capacityLitres().signum() <= 0) {
            throw bad("The " + t.product() + " tank needs a capacity above zero");
        }
        if (t.reorderLitres() == null || t.reorderLitres().signum() < 0 || t.reorderLitres().compareTo(t.capacityLitres()) > 0) {
            throw bad("The " + t.product() + " reorder level must be between zero and the tank capacity");
        }
        if (t.openingLitres() != null && (t.openingLitres().signum() < 0 || t.openingLitres().compareTo(t.capacityLitres()) > 0)) {
            throw bad("The " + t.product() + " opening stock must be between zero and the tank capacity");
        }
    }

    private String nextCode() {
        for (int n = (int) sites.count() + 1; ; n++) {
            String code = "SITE-%03d".formatted(n);
            if (!sites.existsByCodeIgnoreCase(code)) {
                return code;
            }
        }
    }

    private static ResponseStatusException bad(String message) {
        return new ResponseStatusException(HttpStatus.BAD_REQUEST, message);
    }
}
