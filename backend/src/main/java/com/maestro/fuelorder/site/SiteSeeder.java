package com.maestro.fuelorder.site;

import org.springframework.boot.CommandLineRunner;
import org.springframework.stereotype.Component;

import java.time.Instant;
import java.util.List;

/** Makes sure the three demo sites exist, on every start-up and on every database. */
@Component
public class SiteSeeder implements CommandLineRunner {

    private record Seed(String code, String name, String pts2Id, double lat, double lng) {}

    // the PTS-2 IDs are demo values, not real controllers
    private static final List<Seed> SEEDS = List.of(
            new Seed("SITE-JHB-001", "Maestro Fuel Depot — Johannesburg", "0031002E3232511531383639", -26.2041, 28.0473),
            new Seed("SITE-CPT-002", "Maestro Fuel Depot — Cape Town", "0036002C3232511531383641", -33.9249, 18.4241),
            new Seed("SITE-DBN-003", "Maestro Fuel Depot — Durban", "003B00253232511531383644", -29.8587, 31.0218));

    private final SiteRepository sites;

    public SiteSeeder(SiteRepository sites) {
        this.sites = sites;
    }

    @Override
    public void run(String... args) {
        Instant first = Instant.parse("2026-01-01T00:00:00Z");
        for (int i = 0; i < SEEDS.size(); i++) {
            Seed s = SEEDS.get(i);
            if (!sites.existsByCodeIgnoreCase(s.code())) {
                sites.save(new Site(s.code(), s.name(), Site.FUEL_DEPOT, s.pts2Id(), s.lat(), s.lng(), first.plusSeconds(i)));
            }
        }
    }
}
