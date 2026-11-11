package com.maestro.fuelorder.registry;

import com.maestro.fuelorder.notify.NotificationService;
import org.springframework.stereotype.Service;

import java.security.SecureRandom;

/** Driver PIN handling shared by the single-driver endpoint and the bulk import. */
@Service
public class RegistryService {

    private final SecureRandom random = new SecureRandom();
    private final NotificationService notifications;

    public RegistryService(NotificationService notifications) {
        this.notifications = notifications;
    }

    /** Sets a fresh random 4-digit PIN on the driver (stored hashed) and returns the plain value once. */
    public String newPin(Driver d) {
        String pin = "%04d".formatted(random.nextInt(10_000));
        d.setPin(pin);
        return pin;
    }

    public void sendPin(Driver d, String pin) {
        notifications.sms(d.getOrganization(), d.getName(), d.getPhone(), "DRIVER_PIN",
                "Maestro: your fuel identity PIN is " + pin + ". Keep it private; the attendant will ask for it.",
                d.getName());
    }

    public String issuePin(Driver d) {
        String pin = newPin(d);
        sendPin(d, pin);
        return pin;
    }
}
