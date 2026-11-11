package com.maestro.fuelorder.pricing;

import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;
import org.springframework.web.server.ResponseStatusException;

import java.math.BigDecimal;
import java.math.RoundingMode;
import java.time.LocalDate;
import java.util.Comparator;
import java.util.List;
import java.util.UUID;

/**
 * Resolves what one customer pays for one product at one station. Each customer has independent
 * pricing even at the same site. The most specific active rule wins; otherwise the list price applies.
 * Prices on orders are snapshots, so later rule changes never alter an order already placed.
 */
@Service
public class PricingService {

    public record Price(BigDecimal unitPrice, BigDecimal listPrice, String source, UUID ruleId) {}

    private final ListPriceRepository lists;
    private final PriceRuleRepository rules;
    private final PriceHistoryRepository history;

    public PricingService(ListPriceRepository lists, PriceRuleRepository rules, PriceHistoryRepository history) {
        this.lists = lists;
        this.rules = rules;
        this.history = history;
    }

    public Price resolve(String customer, String product, String siteCode, BigDecimal litres, LocalDate date) {
        LocalDate on = date == null ? LocalDate.now() : date;
        BigDecimal list = lists.findByProduct(product)
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.BAD_REQUEST, "No list price for " + product))
                .getUnitPrice();
        PriceRule best = rules.findByOrganizationAndProductAndStatus(customer, product, PriceRule.ACTIVE).stream()
                .filter(r -> r.appliesOn(on))
                .filter(r -> r.getMinLitres().compareTo(litres) <= 0)
                .filter(r -> r.getSiteCode() == null || r.getSiteCode().equalsIgnoreCase(siteCode))
                // station-specific beats any-station, then the higher volume tier, then the newest rule
                .max(Comparator.<PriceRule, Integer>comparing(r -> r.getSiteCode() == null ? 0 : 1)
                        .thenComparing(PriceRule::getMinLitres)
                        .thenComparing(PriceRule::getValidFrom))
                .orElse(null);
        if (best == null) {
            return new Price(list, list, "list price", null);
        }
        return new Price(apply(best, list), list,
                "contract rule " + best.getId().toString().substring(0, 8), best.getId());
    }

    static BigDecimal apply(PriceRule r, BigDecimal list) {
        BigDecimal p = switch (r.getMode()) {
            case PriceRule.FIXED -> r.getValue();
            case PriceRule.DISCOUNT_PCT -> list.multiply(BigDecimal.valueOf(100).subtract(r.getValue()))
                    .divide(BigDecimal.valueOf(100), 4, RoundingMode.HALF_UP);
            case PriceRule.DISCOUNT_ABS -> list.subtract(r.getValue());
            default -> throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Unknown pricing mode " + r.getMode());
        };
        return p.max(BigDecimal.ZERO).setScale(2, RoundingMode.HALF_UP);
    }

    @Transactional
    public PriceRule propose(PriceRule rule) {
        return rules.save(rule);
    }

    /**
     * Four-eyes: the approver must differ from the proposer. Approving activates the rule, retires any
     * rule it replaces and writes the previous and new price to the append-only history.
     */
    @Transactional
    public PriceRule approve(UUID ruleId, String approver) {
        PriceRule rule = pending(ruleId);
        if (rule.getProposedBy().equalsIgnoreCase(approver)) {
            throw new ResponseStatusException(HttpStatus.FORBIDDEN,
                    "A price change must be approved by someone other than the person who proposed it");
        }
        BigDecimal litres = rule.getMinLitres().max(BigDecimal.ONE);
        BigDecimal previous = resolve(rule.getOrganization(), rule.getProduct(),
                rule.getSiteCode(), litres, rule.getValidFrom()).unitPrice();
        rules.findByOrganizationAndProductAndStatus(rule.getOrganization(), rule.getProduct(), PriceRule.ACTIVE)
                .stream()
                .filter(r -> java.util.Objects.equals(r.getSiteCode(), rule.getSiteCode())
                        && r.getMinLitres().compareTo(rule.getMinLitres()) == 0)
                .forEach(r -> { r.supersede(); rules.save(r); });
        rule.decide(PriceRule.ACTIVE, approver);
        BigDecimal listPrice = lists.findByProduct(rule.getProduct()).orElseThrow().getUnitPrice();
        history.save(new PriceHistory(rule.getId(), rule.getOrganization(), rule.getProduct(), rule.getSiteCode(),
                previous, apply(rule, listPrice), rule.getProposedBy(), approver, rule.getValidFrom()));
        return rules.save(rule);
    }

    @Transactional
    public PriceRule reject(UUID ruleId, String by) {
        PriceRule rule = pending(ruleId);
        rule.decide(PriceRule.REJECTED, by);
        return rules.save(rule);
    }

    private PriceRule pending(UUID id) {
        PriceRule rule = rules.findById(id)
                .orElseThrow(() -> new ResponseStatusException(HttpStatus.NOT_FOUND, "Price rule not found"));
        if (!PriceRule.PENDING.equals(rule.getStatus())) {
            throw new ResponseStatusException(HttpStatus.CONFLICT, "Rule is already " + rule.getStatus());
        }
        return rule;
    }

    public List<PriceRule> rulesFor(String organization) {
        return rules.findByOrganization(organization);
    }
}
