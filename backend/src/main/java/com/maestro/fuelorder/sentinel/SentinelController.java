package com.maestro.fuelorder.sentinel;

import com.maestro.fuelorder.auth.Access;
import com.maestro.fuelorder.auth.AuthService;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Pattern;
import org.springframework.http.HttpStatus;
import org.springframework.web.bind.annotation.*;
import org.springframework.web.server.ResponseStatusException;

import java.util.List;
import java.util.Map;
import java.util.UUID;

@RestController
@RequestMapping("/api/v1/sentinel")
public class SentinelController {

    public record StatusRequest(@NotBlank @Pattern(regexp = "OPEN|INVESTIGATING|CONFIRMED|DISMISSED") String status) {}
    public record NoteRequest(@NotBlank String note) {}
    public record CloseRequest(@NotBlank @Pattern(regexp = "CONFIRMED_FRAUD|FALSE_POSITIVE|NO_ACTION") String outcome) {}
    public record CaseView(FraudCase fraudCase, RiskEvent event) {}

    private final RiskEventRepository events;
    private final FraudCaseRepository cases;
    private final EvidenceRecordRepository evidence;
    private final SentinelService sentinel;

    public SentinelController(RiskEventRepository events, FraudCaseRepository cases,
                              EvidenceRecordRepository evidence, SentinelService sentinel) {
        this.events = events;
        this.cases = cases;
        this.evidence = evidence;
        this.sentinel = sentinel;
    }

    @GetMapping("/rules")
    public List<Map<String, String>> rules() {
        return SentinelService.CATALOG;
    }

    @GetMapping("/events")
    public List<RiskEvent> events(HttpServletRequest request) {
        AuthService.Session s = Access.session(request);
        return Access.isCustomer(s) ? events.findTop200ByOrganizationOrderByCreatedAtDesc(s.organization())
                : events.findTop200ByOrderByCreatedAtDesc();
    }

    @PostMapping("/events/{id}/status")
    public RiskEvent setStatus(@PathVariable UUID id, @RequestBody @Valid StatusRequest req, HttpServletRequest request) {
        Access.requireSupplier(Access.session(request));
        RiskEvent e = events.findById(id).orElseThrow(() -> notFound("Risk event"));
        e.setStatus(req.status());
        return events.save(e);
    }

    /** Evidence is restricted to investigators; every read is audited by the request audit log. */
    @GetMapping("/events/{id}/evidence")
    public List<EvidenceRecord> evidenceFor(@PathVariable UUID id, HttpServletRequest request) {
        Access.requireSupplier(Access.session(request));
        return evidence.findByRiskEventId(id);
    }

    @GetMapping("/evidence/verify")
    public Map<String, Object> verify(HttpServletRequest request) {
        Access.requireSupplier(Access.session(request));
        return sentinel.verifyChain();
    }

    @GetMapping("/cases")
    public List<CaseView> cases(HttpServletRequest request) {
        Access.requireSupplier(Access.session(request));
        return cases.findAll().stream()
                .map(c -> new CaseView(c, events.findById(c.getRiskEventId()).orElse(null)))
                .sorted((a, b) -> b.fraudCase().getOpenedAt().compareTo(a.fraudCase().getOpenedAt()))
                .toList();
    }

    @PostMapping("/cases/{id}/assign")
    public FraudCase assign(@PathVariable UUID id, HttpServletRequest request) {
        AuthService.Session s = Access.session(request);
        Access.requireSupplier(s);
        FraudCase c = cases.findById(id).orElseThrow(() -> notFound("Case"));
        c.assign(s.name());
        return cases.save(c);
    }

    @PostMapping("/cases/{id}/notes")
    public FraudCase note(@PathVariable UUID id, @RequestBody @Valid NoteRequest req, HttpServletRequest request) {
        AuthService.Session s = Access.session(request);
        Access.requireSupplier(s);
        FraudCase c = cases.findById(id).orElseThrow(() -> notFound("Case"));
        c.note(s.name(), req.note());
        return cases.save(c);
    }

    @PostMapping("/cases/{id}/close")
    public FraudCase close(@PathVariable UUID id, @RequestBody @Valid CloseRequest req, HttpServletRequest request) {
        Access.requireSupplier(Access.session(request));
        FraudCase c = cases.findById(id).orElseThrow(() -> notFound("Case"));
        c.close(req.outcome());
        events.findById(c.getRiskEventId()).ifPresent(e -> {
            e.setStatus("CONFIRMED_FRAUD".equals(req.outcome()) ? "CONFIRMED" : "DISMISSED");
            events.save(e);
        });
        return cases.save(c);
    }

    private static ResponseStatusException notFound(String what) {
        return new ResponseStatusException(HttpStatus.NOT_FOUND, what + " not found");
    }
}
