package com.maestro.fuelorder.notify;

import com.maestro.fuelorder.auth.Access;
import com.maestro.fuelorder.auth.AuthService;
import jakarta.servlet.http.HttpServletRequest;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;

@RestController
@RequestMapping("/api/v1/notifications")
public class NotificationController {

    private final NotificationRepository repo;

    public NotificationController(NotificationRepository repo) {
        this.repo = repo;
    }

    @GetMapping
    public List<Notification> list(HttpServletRequest request) {
        AuthService.Session s = Access.session(request);
        return Access.isCustomer(s)
                ? repo.findTop100ByOrganizationOrderByCreatedAtDesc(s.organization())
                : repo.findTop100ByOrderByCreatedAtDesc();
    }
}
