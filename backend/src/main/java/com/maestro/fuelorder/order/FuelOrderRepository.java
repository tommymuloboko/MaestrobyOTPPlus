package com.maestro.fuelorder.order;

import org.springframework.data.jpa.repository.JpaRepository;
import java.util.List;
import java.util.UUID;

public interface FuelOrderRepository extends JpaRepository<FuelOrder, UUID> {
    List<FuelOrder> findTop200ByOrderByCreatedAtDesc();

    List<FuelOrder> findTop200ByCustomerNameOrderByCreatedAtDesc(String customerName);

    List<FuelOrder> findByCustomerNameAndStatus(String customerName, FuelOrder.Status status);

    long countByStatus(FuelOrder.Status status);
}
