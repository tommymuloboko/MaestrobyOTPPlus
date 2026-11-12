package com.maestro.fuelorder.pts2;

import com.maestro.fuelorder.auth.Access;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotEmpty;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Size;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.*;

import java.math.BigDecimal;
import java.time.LocalDateTime;
import java.util.List;
import java.util.Map;

/**
 * PTS-2 connection settings and pump prices (OMC / Platform Admin), and the live tank readings and prices pulled
 * from the controllers (staff).
 */
@RestController
@RequestMapping("/api/v1/pts2")
public class Pts2Controller {

    /** A blank password on an existing connection keeps the stored one. */
    public record SaveRequest(@NotBlank @Size(max = 200) String url,
                              @NotBlank @Size(max = 80) String username,
                              @Size(max = 120) String password,
                              Boolean enabled) {}

    public record PriceItem(@NotNull Integer fuelGradeId, @NotNull BigDecimal price) {}

    /** No effectiveAt changes the prices now; otherwise the controller applies them then (its local time). */
    public record PriceRequest(@NotEmpty @Size(max = 10) List<@Valid @NotNull PriceItem> changes,
                               LocalDateTime effectiveAt) {}

    private final Pts2Service pts2;
    private final Pts2PriceService prices;

    public Pts2Controller(Pts2Service pts2, Pts2PriceService prices) {
        this.pts2 = pts2;
        this.prices = prices;
    }

    @GetMapping("/connections")
    public List<Map<String, Object>> connections(HttpServletRequest request) {
        Access.requireStaff(Access.session(request));
        return pts2.all().stream().map(pts2::view).toList();
    }

    @PutMapping("/connections/{siteCode}")
    public Map<String, Object> save(@PathVariable String siteCode, @RequestBody @Valid SaveRequest req,
                                    HttpServletRequest request) {
        Access.requireOmc(Access.session(request));
        Pts2Connection c = pts2.save(siteCode, req.url(), req.username(), req.password(),
                req.enabled() == null || req.enabled());
        if (c.isEnabled()) {
            pts2.poll(c);
        }
        return pts2.view(c);
    }

    @DeleteMapping("/connections/{siteCode}")
    @ResponseStatus(HttpStatus.NO_CONTENT)
    public void delete(@PathVariable String siteCode, HttpServletRequest request) {
        Access.requireOmc(Access.session(request));
        pts2.delete(siteCode);
    }

    /** Polls the controller now and returns what it reported, or why it could not be read. */
    @PostMapping("/connections/{siteCode}/test")
    public Pts2Service.SiteState test(@PathVariable String siteCode, HttpServletRequest request) {
        Access.requireOmc(Access.session(request));
        return pts2.poll(siteCode);
    }

    @GetMapping("/tanks")
    public List<Pts2Service.SiteState> tanks(HttpServletRequest request) {
        Access.requireStaff(Access.session(request));
        return pts2.live();
    }

    /** Fuel grade prices and the prices scheduler, read live from the site's controller. */
    @GetMapping("/prices/{siteCode}")
    public Pts2PriceService.Prices prices(@PathVariable String siteCode, HttpServletRequest request) {
        Access.requireStaff(Access.session(request));
        return prices.prices(siteCode);
    }

    @PostMapping("/prices/{siteCode}")
    public Pts2PriceService.Prices changePrices(@PathVariable String siteCode, @RequestBody @Valid PriceRequest req,
                                                HttpServletRequest request) {
        var s = Access.session(request);
        Access.requireOmc(s);
        return prices.change(siteCode, req.changes().stream()
                .map(c -> new Pts2PriceService.Change(c.fuelGradeId(), c.price())).toList(), req.effectiveAt(), s.email());
    }

    @DeleteMapping("/prices/{siteCode}/schedules/{scheduleId}")
    public Pts2PriceService.Prices cancelSchedule(@PathVariable String siteCode, @PathVariable int scheduleId,
                                                  HttpServletRequest request) {
        var s = Access.session(request);
        Access.requireOmc(s);
        return prices.cancel(siteCode, scheduleId, s.email());
    }

    @GetMapping("/prices/{siteCode}/history")
    public List<Pts2PriceChange> priceHistory(@PathVariable String siteCode, HttpServletRequest request) {
        Access.requireStaff(Access.session(request));
        return prices.history(siteCode);
    }
}
