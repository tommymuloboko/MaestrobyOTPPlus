package com.maestro.fuelorder.stock;

import com.maestro.fuelorder.auth.Access;
import jakarta.servlet.http.HttpServletRequest;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;

@RestController
@RequestMapping("/api/v1/stock")
public class StockController {

    private final StockService stock;
    private final StockMovementRepository movements;

    public StockController(StockService stock, StockMovementRepository movements) {
        this.stock = stock;
        this.movements = movements;
    }

    @GetMapping
    public List<StockService.Level> levels(HttpServletRequest request) {
        Access.requireStaff(Access.session(request));
        return stock.levels();
    }

    @GetMapping("/movements")
    public List<StockMovement> recent(HttpServletRequest request) {
        Access.requireStaff(Access.session(request));
        return movements.findAll().stream()
                .sorted((a, b) -> b.getAt().compareTo(a.getAt()))
                .limit(100)
                .toList();
    }
}
