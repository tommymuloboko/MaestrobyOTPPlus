package com.maestro.fuelorder.finance;

import org.springframework.data.jpa.repository.JpaRepository;
import java.util.List;
import java.util.UUID;

public interface PaymentRepository extends JpaRepository<Payment, UUID> {
    List<Payment> findByOrganization(String organization);
    List<Payment> findByInvoiceId(UUID invoiceId);
}
