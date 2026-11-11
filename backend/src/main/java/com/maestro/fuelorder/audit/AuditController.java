package com.maestro.fuelorder.audit;

import com.maestro.fuelorder.auth.Access;
import jakarta.servlet.http.HttpServletRequest;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;

@RestController
@RequestMapping("/api/v1/audit")
public class AuditController {

    private final AuditLogRepository repo;

    public AuditController(AuditLogRepository repo) {
        this.repo = repo;
    }

    @GetMapping
    public List<AuditLog> latest(HttpServletRequest request) {
        Access.requireAdmin(Access.session(request));
        return repo.findTop200ByOrderByAtDesc();
    }
}
