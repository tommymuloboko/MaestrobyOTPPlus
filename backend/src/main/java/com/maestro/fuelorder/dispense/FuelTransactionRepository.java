package com.maestro.fuelorder.dispense;

import org.springframework.data.domain.Pageable;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

import java.math.BigDecimal;
import java.time.Instant;
import java.util.List;
import java.util.UUID;

public interface FuelTransactionRepository extends JpaRepository<FuelTransaction, UUID> {
    List<FuelTransaction> findTop200ByOrderByDispensedAtDesc();

    List<FuelTransaction> findByDispensedAtGreaterThanEqual(Instant from);

    List<FuelTransaction> findByVehicleRegAndDispensedAtGreaterThanEqual(String vehicleReg, Instant from);

    List<FuelTransaction> findBySiteNameAndDispensedAtBetween(String siteName, Instant from, Instant to);

    @Query("select t from FuelTransaction t where t.vehicleReg = :reg and t.orderId in "
            + "(select o.id from FuelOrder o where o.customerName = :customer) order by t.dispensedAt desc")
    List<FuelTransaction> forVehicle(@Param("customer") String customer, @Param("reg") String reg, Pageable page);

    @Query("select t from FuelTransaction t where t.orderId in "
            + "(select o.id from FuelOrder o where o.customerName = :customer) order by t.dispensedAt desc")
    List<FuelTransaction> forCustomer(@Param("customer") String customer, Pageable page);

    @Query("select t from FuelTransaction t where t.dispensedAt >= :from and t.orderId in "
            + "(select o.id from FuelOrder o where o.customerName = :customer)")
    List<FuelTransaction> forCustomerSince(@Param("customer") String customer, @Param("from") Instant from);

    @Query("select coalesce(sum(t.amount), 0) from FuelTransaction t where t.dispensedAt >= :from and t.orderId in "
            + "(select o.id from FuelOrder o where o.customerName = :customer)")
    BigDecimal spendSince(@Param("customer") String customer, @Param("from") Instant from);

    @Query("select coalesce(sum(t.amount), 0) from FuelTransaction t where t.orderId in "
            + "(select o.id from FuelOrder o where o.customerName = :customer) "
            + "and t.id not in (select l.transactionId from InvoiceLine l)")
    BigDecimal unbilledAmount(@Param("customer") String customer);
}
