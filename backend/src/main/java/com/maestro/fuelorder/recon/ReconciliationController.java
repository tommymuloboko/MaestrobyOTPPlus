package com.maestro.fuelorder.recon;

import com.maestro.fuelorder.auth.Access;
import com.maestro.fuelorder.auth.AuthService;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import org.springframework.web.bind.annotation.*;

import java.time.LocalDate;
import java.util.List;
import java.util.UUID;

@RestController
@RequestMapping("/api/v1/reconciliation")
public class ReconciliationController {

    public record ResolveRequest(@NotBlank String note) {}

    private final ReconciliationService service;
    private final ReconciliationRunRepository runs;
    private final VarianceExceptionRepository exceptions;

    public ReconciliationController(ReconciliationService service, ReconciliationRunRepository runs,
                                    VarianceExceptionRepository exceptions) {
        this.service = service;
        this.runs = runs;
        this.exceptions = exceptions;
    }

    @PostMapping("/close")
    public ReconciliationRun close(@RequestParam String siteCode,
                                   @RequestParam(required = false) LocalDate date, HttpServletRequest request) {
        Access.requireStaff(Access.session(request));
        return service.close(siteCode, date == null ? LocalDate.now() : date);
    }

    @GetMapping("/runs")
    public List<ReconciliationRun> runs(HttpServletRequest request) {
        Access.requireStaff(Access.session(request));
        return runs.findTop100ByOrderByAtDesc();
    }

    @GetMapping("/exceptions")
    public List<VarianceException> exceptions(HttpServletRequest request) {
        Access.requireStaff(Access.session(request));
        return exceptions.findAllByOrderByCreatedAtDesc();
    }

    @PostMapping("/exceptions/{id}/resolve")
    public VarianceException resolve(@PathVariable UUID id, @RequestBody @Valid ResolveRequest req,
                                     HttpServletRequest request) {
        AuthService.Session s = Access.session(request);
        Access.requireStaff(s);
        return service.resolve(id, s.name(), req.note());
    }
}
