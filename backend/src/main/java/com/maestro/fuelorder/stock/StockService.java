package com.maestro.fuelorder.stock;

import org.springframework.stereotype.Service;

import java.math.BigDecimal;
import java.util.List;
import java.util.UUID;

@Service
public class StockService {

    public record Level(String siteCode, String product, BigDecimal capacityLitres, BigDecimal bookLitres,
                        BigDecimal reorderLitres, BigDecimal percent, boolean belowReorder) {}

    private final TankRepository tanks;
    private final StockMovementRepository movements;

    public StockService(TankRepository tanks, StockMovementRepository movements) {
        this.tanks = tanks;
        this.movements = movements;
    }

    public StockMovement record(String siteCode, String product, String kind, BigDecimal litres,
                                String refType, UUID refId) {
        return movements.save(new StockMovement(siteCode, product, kind, litres, refType, refId));
    }

    public BigDecimal bookLitres(Tank t) {
        return t.getOpeningLitres().add(movements.findBySiteCodeAndProduct(t.getSiteCode(), t.getProduct())
                .stream().map(StockMovement::getLitres).reduce(BigDecimal.ZERO, BigDecimal::add));
    }

    public List<Level> levels() {
        return tanks.findAll().stream().map(this::level)
                .sorted((a, b) -> (a.siteCode() + a.product()).compareTo(b.siteCode() + b.product()))
                .toList();
    }

    public Level level(Tank t) {
        BigDecimal book = bookLitres(t);
        BigDecimal pct = t.getCapacityLitres().signum() == 0 ? BigDecimal.ZERO
                : book.multiply(BigDecimal.valueOf(100)).divide(t.getCapacityLitres(), 1, java.math.RoundingMode.HALF_UP);
        return new Level(t.getSiteCode(), t.getProduct(), t.getCapacityLitres(), book,
                t.getReorderLitres(), pct, book.compareTo(t.getReorderLitres()) < 0);
    }
}
