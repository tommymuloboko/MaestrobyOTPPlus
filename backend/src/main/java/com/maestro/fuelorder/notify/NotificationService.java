package com.maestro.fuelorder.notify;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

/**
 * Sends and records customer-facing messages. The gateway is an interface so a real SMS or
 * WhatsApp provider can replace the simulated one without touching callers.
 */
@Service
public class NotificationService {

    /** Seam for a real provider (Twilio, Clickatell, WhatsApp Business...). */
    public interface SmsGateway {
        /** @return the delivery status to store, e.g. SENT or FAILED. */
        String send(String phone, String message);
    }

    private static final Logger log = LoggerFactory.getLogger(NotificationService.class);

    private final NotificationRepository repo;
    private final SmsGateway gateway = (phone, message) -> {
        log.info("[simulated SMS] to {}: {}", phone, message);
        return "SENT_SIMULATED";
    };

    public NotificationService(NotificationRepository repo) {
        this.repo = repo;
    }

    public Notification sms(String organization, String recipientName, String phone,
                            String kind, String message, String reference) {
        String status = phone == null || phone.isBlank() ? "NO_PHONE" : gateway.send(phone, message);
        return repo.save(new Notification(organization, recipientName, phone, "SMS", kind, message, status, reference));
    }

    /** In-app message with no phone number involved. */
    public Notification inApp(String organization, String kind, String message, String reference) {
        return repo.save(new Notification(organization, null, null, "IN_APP", kind, message, "DELIVERED", reference));
    }
}
