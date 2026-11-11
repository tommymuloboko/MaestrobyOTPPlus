package com.maestro.fuelorder.delivery;

import org.springframework.data.jpa.repository.JpaRepository;
import java.util.List;
import java.util.UUID;

public interface DeliveryNoteRepository extends JpaRepository<DeliveryNote, UUID> {
    List<DeliveryNote> findByCustomer(String customer);
}
