package com.maestro.fuelorder.pricing;

import com.maestro.fuelorder.auth.Access;
import com.maestro.fuelorder.auth.AuthService;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.validation.Valid;
import jakarta.validation.constraints.DecimalMin;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Pattern;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.server.ResponseStatusException;

import java.math.BigDecimal;
import java.time.LocalDate;
import java.util.List;
import java.util.UUID;

@RestController
@RequestMapping("/api/v1/pricing")
public class PricingController {

    public record RuleRequest(
            @NotBlank String organization,
            @NotBlank String product,
            String siteCode,
            @NotBlank @Pattern(regexp = "FIXED|DISCOUNT_PCT|DISCOUNT_ABS") String mode,
            @NotNull @DecimalMin("0.0") BigDecimal value,
            BigDecimal minLitres,
            LocalDate validFrom,
            LocalDate validTo) {}

    private final PricingService pricing;
    private final PriceRuleRepository rules;
    private final PriceHistoryRepository history;
    private final ListPriceRepository lists;

    public PricingController(PricingService pricing, PriceRuleRepository rules,
                             PriceHistoryRepository history, ListPriceRepository lists) {
        this.pricing = pricing;
        this.rules = rules;
        this.history = history;
        this.lists = lists;
    }

    @GetMapping("/list")
    public List<ListPrice> listPrices() {
        return lists.findAll();
    }

    @GetMapping("/rules")
    public List<PriceRule> rules(HttpServletRequest request) {
        AuthService.Session s = Access.session(request);
        List<PriceRule> all = Access.isCustomer(s) ? rules.findByOrganization(s.organization()) : rules.findAll();
        return all.stream().sorted((a, b) -> b.getProposedAt().compareTo(a.getProposedAt())).toList();
    }

    @PostMapping("/rules")
    @ResponseStatus(HttpStatus.CREATED)
    public PriceRule propose(@RequestBody @Valid RuleRequest req, HttpServletRequest request) {
        AuthService.Session s = Access.session(request);
        Access.requireFinance(s);
        if (lists.findByProduct(req.product()).isEmpty()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Unknown product " + req.product());
        }
        return pricing.propose(new PriceRule(req.organization(), req.product(), req.siteCode(), req.mode(),
                req.value(), req.minLitres(), req.validFrom() == null ? LocalDate.now() : req.validFrom(),
                req.validTo(), s.email()));
    }

    @PostMapping("/rules/{id}/approve")
    public PriceRule approve(@PathVariable UUID id, HttpServletRequest request) {
        AuthService.Session s = Access.session(request);
        Access.requireFinance(s);
        return pricing.approve(id, s.email());
    }

    @PostMapping("/rules/{id}/reject")
    public PriceRule reject(@PathVariable UUID id, HttpServletRequest request) {
        AuthService.Session s = Access.session(request);
        Access.requireFinance(s);
        return pricing.reject(id, s.email());
    }

    @GetMapping("/history")
    public List<PriceHistory> history(HttpServletRequest request) {
        AuthService.Session s = Access.session(request);
        return Access.isCustomer(s) ? history.findByOrganizationOrderByAtDesc(s.organization())
                : history.findAllByOrderByAtDesc();
    }

    /** Price preview for one customer; customers can only ask about themselves. */
    @GetMapping("/resolve")
    public PricingService.Price resolve(@RequestParam(required = false) String customer,
                                        @RequestParam String product,
                                        @RequestParam(required = false) String siteCode,
                                        @RequestParam(defaultValue = "1") BigDecimal litres,
                                        HttpServletRequest request) {
        AuthService.Session s = Access.session(request);
        String org = Access.isCustomer(s) ? s.organization() : customer;
        if (org == null) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "customer is required");
        }
        return pricing.resolve(org, product, siteCode, litres, null);
    }
}
