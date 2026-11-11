package com.maestro.fuelorder.notify;

import org.springframework.data.jpa.repository.JpaRepository;
import java.util.List;
import java.util.UUID;

public interface NotificationRepository extends JpaRepository<Notification, UUID> {
    List<Notification> findTop100ByOrderByCreatedAtDesc();
    List<Notification> findTop100ByOrganizationOrderByCreatedAtDesc(String organization);
}
