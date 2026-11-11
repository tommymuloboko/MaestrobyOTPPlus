package com.maestro.fuelorder.integration;

import org.springframework.data.jpa.repository.JpaRepository;
import java.util.Optional;
import java.util.UUID;

public interface DeviceStatusRepository extends JpaRepository<DeviceStatus, UUID> {
    Optional<DeviceStatus> findByDeviceId(String deviceId);
}
