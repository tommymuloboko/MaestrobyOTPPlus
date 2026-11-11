package com.maestro.fuelorder.bulk;

import com.maestro.fuelorder.auth.Access;
import com.maestro.fuelorder.auth.AuthService;
import jakarta.servlet.http.HttpServletRequest;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;
import org.springframework.web.multipart.MultipartFile;
import org.springframework.web.server.ResponseStatusException;

import java.io.IOException;
import java.util.List;
import java.util.Locale;

/** Excel templates to download, and the upload endpoints that validate and import them. */
@RestController
@RequestMapping("/api/v1/bulk")
public class BulkImportController {

    private static final MediaType XLSX =
            MediaType.parseMediaType("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");

    private final BulkImportService service;

    public BulkImportController(BulkImportService service) {
        this.service = service;
    }

    @GetMapping("/templates/{kind}")
    public ResponseEntity<byte[]> template(@PathVariable String kind,
                                           @RequestParam(required = false) String fuelType,
                                           @RequestParam(required = false) String customerName,
                                           HttpServletRequest request) {
        AuthService.Session s = Access.session(request);
        byte[] body = switch (kind) {
            case "vehicles" -> {
                Access.requireCustomer(s);
                yield ExcelTemplates.vehicles();
            }
            case "drivers" -> {
                Access.requireCustomer(s);
                yield ExcelTemplates.drivers();
            }
            case "orders" -> ExcelTemplates.orders(
                    service.fleetPrefill(customerFor(s, customerName), fuelType == null || fuelType.isBlank()
                            ? null : fuelType.toUpperCase(Locale.ROOT)));
            default -> throw new ResponseStatusException(HttpStatus.NOT_FOUND, "Unknown template " + kind);
        };
        return ResponseEntity.ok().contentType(XLSX)
                .header("Content-Disposition", "attachment; filename=\"maestro-" + kind + "-template.xlsx\"")
                .body(body);
    }

    /** {@code dryRun=true} (the default) only validates; {@code false} imports, and only if every row is valid. */
    @PostMapping(value = "/vehicles", consumes = MediaType.MULTIPART_FORM_DATA_VALUE)
    public BulkImportService.Result vehicles(@RequestParam("file") MultipartFile file,
                                             @RequestParam(defaultValue = "true") boolean dryRun,
                                             HttpServletRequest request) {
        AuthService.Session s = Access.session(request);
        Access.requireCustomer(s);
        return service.vehicles(s.organization(), bytes(file), dryRun);
    }

    @PostMapping(value = "/drivers", consumes = MediaType.MULTIPART_FORM_DATA_VALUE)
    public BulkImportService.Result drivers(@RequestParam("file") MultipartFile file,
                                            @RequestParam(defaultValue = "true") boolean dryRun,
                                            HttpServletRequest request) {
        AuthService.Session s = Access.session(request);
        Access.requireCustomer(s);
        return service.drivers(s.organization(), bytes(file), dryRun);
    }

    /** Validates allocation rows for a bulk order; the portal loads the valid rows into the order form. */
    @PostMapping(value = "/orders/parse", consumes = MediaType.MULTIPART_FORM_DATA_VALUE)
    public BulkImportService.Result orders(@RequestParam("file") MultipartFile file,
                                           @RequestParam String fuelProduct,
                                           @RequestParam(required = false) String customerName,
                                           HttpServletRequest request) {
        AuthService.Session s = Access.session(request);
        return service.orderAllocations(customerFor(s, customerName), Access.isCustomer(s), fuelProduct, bytes(file));
    }

    private static String customerFor(AuthService.Session s, String requested) {
        if (Access.isCustomer(s)) {
            return s.organization();
        }
        Access.requireStaff(s);
        if (requested == null || requested.isBlank()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "customerName is required");
        }
        return requested;
    }

    private static byte[] bytes(MultipartFile file) {
        if (file == null || file.isEmpty()) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "Choose an .xlsx file to upload.");
        }
        String name = file.getOriginalFilename() == null ? "" : file.getOriginalFilename().toLowerCase(Locale.ROOT);
        if (!name.endsWith(".xlsx")) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST,
                    "Only .xlsx workbooks are accepted. Download the template, fill it in and save it as .xlsx.");
        }
        if (file.getSize() > BulkImportService.MAX_BYTES) {
            throw new ResponseStatusException(HttpStatus.CONTENT_TOO_LARGE, "That file is larger than 2 MB. Split it into several files.");
        }
        try {
            return file.getBytes();
        } catch (IOException e) {
            throw new ResponseStatusException(HttpStatus.BAD_REQUEST, "The upload could not be read.");
        }
    }
}
