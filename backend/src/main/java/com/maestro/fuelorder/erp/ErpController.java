package com.maestro.fuelorder.erp;

import com.maestro.fuelorder.auth.Access;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.validation.Valid;
import jakarta.validation.constraints.DecimalMin;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.math.BigDecimal;
import java.util.List;
import java.util.UUID;

@RestController
@RequestMapping("/api/v1")
public class ErpController {

    public record RateRequest(@NotBlank String from, @NotBlank String to, @NotNull @DecimalMin("0.000001") BigDecimal rate) {}

    private final ErpService erp;

    public ErpController(ErpService erp) {
        this.erp = erp;
    }

    @GetMapping(value = "/integrations/erp/invoices.csv", produces = "text/csv")
    public ResponseEntity<String> invoicesCsv(HttpServletRequest request) {
        Access.requireFinance(Access.session(request));
        return ResponseEntity.ok().contentType(MediaType.parseMediaType("text/csv"))
                .header("Content-Disposition", "attachment; filename=invoices.csv").body(erp.invoicesCsv());
    }

    @PostMapping("/integrations/erp/push")
    public List<OutboundEvent> push(HttpServletRequest request) {
        Access.requireFinance(Access.session(request));
        return erp.pushInvoices();
    }

    @GetMapping("/integrations/erp/events")
    public List<OutboundEvent> events(HttpServletRequest request) {
        Access.requireFinance(Access.session(request));
        return erp.events();
    }

    @GetMapping("/fx")
    public List<FxRate> rates() {
        return erp.rates();
    }

    @PutMapping("/fx")
    public FxRate setRate(@RequestBody @Valid RateRequest r, HttpServletRequest request) {
        Access.requireFinance(Access.session(request));
        return erp.setRate(r.from().toUpperCase(), r.to().toUpperCase(), r.rate());
    }

    @GetMapping("/fx/convert")
    public BigDecimal convert(@RequestParam BigDecimal amount, @RequestParam String from, @RequestParam String to) {
        return erp.convert(amount, from, to);
    }

    @PostMapping("/finance/settlements")
    public SettlementRun settle(HttpServletRequest request) {
        Access.requireFinance(Access.session(request));
        return erp.settle();
    }

    @PostMapping("/finance/settlements/{id}/paid")
    public SettlementRun markPaid(@PathVariable UUID id, HttpServletRequest request) {
        Access.requireFinance(Access.session(request));
        return erp.markPaid(id);
    }

    @GetMapping("/finance/settlements")
    public List<SettlementRun> settlements(HttpServletRequest request) {
        Access.requireFinance(Access.session(request));
        return erp.settlements();
    }
}
