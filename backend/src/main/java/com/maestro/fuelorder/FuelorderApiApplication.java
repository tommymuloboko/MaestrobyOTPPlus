package com.maestro.fuelorder;

import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.scheduling.annotation.EnableScheduling;

@SpringBootApplication
@EnableScheduling
public class FuelorderApiApplication {

	public static void main(String[] args) {
		SpringApplication.run(FuelorderApiApplication.class, args);
	}

}
