package com.maestro.fuelorder.bulk;

import org.apache.poi.ss.usermodel.BorderStyle;
import org.apache.poi.ss.usermodel.CellStyle;
import org.apache.poi.ss.usermodel.DataFormat;
import org.apache.poi.ss.usermodel.DataValidation;
import org.apache.poi.ss.usermodel.DataValidationConstraint;
import org.apache.poi.ss.usermodel.DataValidationHelper;
import org.apache.poi.ss.usermodel.FillPatternType;
import org.apache.poi.ss.usermodel.Font;
import org.apache.poi.ss.usermodel.IndexedColors;
import org.apache.poi.ss.usermodel.Row;
import org.apache.poi.ss.usermodel.Sheet;
import org.apache.poi.ss.util.CellRangeAddressList;
import org.apache.poi.xssf.usermodel.XSSFWorkbook;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.util.List;

/** Builds the downloadable Excel templates: a Data sheet to fill in and an Instructions sheet. */
final class ExcelTemplates {

    /** One prefilled line of the orders template: a vehicle of the customer's fleet and its usual driver. */
    record Prefill(String vehicleReg, String driverName) {}

    private ExcelTemplates() {}

    static final List<SheetReader.Col> VEHICLES = List.of(
            new SheetReader.Col("registration", "Registration *", true, "reg", "vehicle", "plate"),
            new SheetReader.Col("description", "Description", false, "make"),
            new SheetReader.Col("fuelType", "Fuel type *", true, "fuel"),
            new SheetReader.Col("capacity", "Tank capacity (L) *", true, "tankcapacity", "tankcapacitylitres", "tank"),
            new SheetReader.Col("vehicleType", "Vehicle type", false, "type"),
            new SheetReader.Col("model", "Model", false, "vehiclemodel"),
            new SheetReader.Col("modelYear", "Year", false, "modelyear", "yearofmanufacture"));

    static final List<SheetReader.Col> DRIVERS = List.of(
            new SheetReader.Col("name", "Full name *", true, "name", "driver", "drivername"),
            new SheetReader.Col("phone", "Phone", false, "mobile", "cell"),
            new SheetReader.Col("licenseNo", "Licence number", false, "licence", "license", "licenseno", "licenceno"),
            new SheetReader.Col("vehicleReg", "Assigned vehicle", false, "vehicle", "vehiclereg", "registration"));

    static final List<SheetReader.Col> ORDERS = List.of(
            new SheetReader.Col("vehicleReg", "Vehicle registration *", true, "vehicle", "registration", "reg"),
            new SheetReader.Col("driverName", "Driver name", false, "driver", "name"),
            new SheetReader.Col("litres", "Litres *", true, "volume", "quantity", "quantitylitres", "fuelvolumelitres"));

    static byte[] vehicles() {
        return build("Vehicles", VEHICLES, List.of(),
                List.of("Registration is the number plate, for example CA 123-456. It must not already be registered.",
                        "Description is optional free text.",
                        "Fuel type must be PETROL or DIESEL (pick it from the dropdown).",
                        "Tank capacity is in litres, between 1 and 100000. Orders larger than the tank are refused.",
                        "Vehicle type (for example Truck, Pickup, Van, Car), Model and Year are optional. Year is the year of manufacture, 1950 or later."),
                sheet -> {
                    list(sheet, 2, "PETROL", "DIESEL");
                    decimal(sheet, 3, 1, 100_000);
                }, 0, 1, 4, 5, 6);
    }

    static byte[] drivers() {
        return build("Drivers", DRIVERS, List.of(),
                List.of("Full name must be unique in your fleet. A random 4-digit PIN is generated for each driver.",
                        "Phone is optional; when given, the PIN is sent to it by SMS. Use the international format, for example +27 82 555 0100.",
                        "Licence number is optional.",
                        "Assigned vehicle is optional; if given it must already be one of your registered vehicles."),
                sheet -> { }, 1, 2, 3);
    }

    static byte[] orders(List<Prefill> fleet) {
        return build("Bulk order", ORDERS, fleet,
                List.of("One row per vehicle. The station and the fuel type are chosen on the Bulk Order page, not in this file.",
                        "Vehicle registration must be one of your registered vehicles that takes the chosen fuel.",
                        "Driver name is optional: when left blank the vehicle's assigned driver is used.",
                        "Litres is the quantity authorised for that vehicle. Rows with no litres are skipped, so you can leave "
                                + "out vehicles that are not being fuelled. A vehicle may appear only once."),
                sheet -> decimal(sheet, 2, 1, 100_000), 0, 1);
    }

    private interface Validations {
        void apply(Sheet sheet);
    }

    private static byte[] build(String noun, List<SheetReader.Col> cols, List<Prefill> prefill, List<String> notes,
                                Validations validations, int... textColumns) {
        try (XSSFWorkbook wb = new XSSFWorkbook(); ByteArrayOutputStream out = new ByteArrayOutputStream()) {
            Sheet data = wb.createSheet("Data");

            Font bold = wb.createFont();
            bold.setBold(true);
            CellStyle head = wb.createCellStyle();
            head.setFont(bold);
            head.setFillForegroundColor(IndexedColors.LIGHT_GREEN.getIndex());
            head.setFillPattern(FillPatternType.SOLID_FOREGROUND);
            head.setBorderBottom(BorderStyle.THIN);

            // text format stops Excel from turning registrations and phone numbers into numbers or dates
            DataFormat fmt = wb.createDataFormat();
            CellStyle text = wb.createCellStyle();
            text.setDataFormat(fmt.getFormat("@"));
            for (int col : textColumns) {
                data.setDefaultColumnStyle(col, text);
            }

            Row header = data.createRow(0);
            for (int i = 0; i < cols.size(); i++) {
                var cell = header.createCell(i);
                cell.setCellValue(cols.get(i).label());
                cell.setCellStyle(head);
                data.setColumnWidth(i, 24 * 256);
            }
            data.createFreezePane(0, 1);

            for (int i = 0; i < prefill.size(); i++) {
                Row row = data.createRow(i + 1);
                row.createCell(0).setCellValue(prefill.get(i).vehicleReg());
                if (prefill.get(i).driverName() != null) {
                    row.createCell(1).setCellValue(prefill.get(i).driverName());
                }
            }
            validations.apply(data);

            Sheet help = wb.createSheet("Instructions");
            help.setColumnWidth(0, 110 * 256);
            int r = 0;
            help.createRow(r++).createCell(0).setCellValue("Maestro FuelOrder - " + noun + " import");
            help.createRow(r++).createCell(0).setCellValue("Fill in the Data sheet, save the file as .xlsx and upload it. Columns marked * are required.");
            r++;
            for (String n : notes) {
                help.createRow(r++).createCell(0).setCellValue("- " + n);
            }
            r++;
            help.createRow(r++).createCell(0).setCellValue("Rules: at most " + SheetReader.MAX_ROWS
                    + " rows; do not rename the headers; formulas are not accepted. Every row is checked before anything is saved: "
                    + "if one row has a problem, nothing is imported and you are told which row to fix.");
            help.getRow(0).getCell(0).setCellStyle(head);

            wb.write(out);
            return out.toByteArray();
        } catch (IOException e) {
            throw new IllegalStateException("Could not build the template", e);
        }
    }

    private static void list(Sheet sheet, int column, String... values) {
        DataValidationHelper h = sheet.getDataValidationHelper();
        DataValidationConstraint c = h.createExplicitListConstraint(values);
        DataValidation v = h.createValidation(c, new CellRangeAddressList(1, SheetReader.MAX_ROWS, column, column));
        v.setShowErrorBox(true);
        v.createErrorBox("Fuel type", "Choose " + String.join(" or ", values) + ".");
        sheet.addValidationData(v);
    }

    private static void decimal(Sheet sheet, int column, double min, double max) {
        DataValidationHelper h = sheet.getDataValidationHelper();
        DataValidationConstraint c = h.createDecimalConstraint(
                DataValidationConstraint.OperatorType.BETWEEN, String.valueOf(min), String.valueOf(max));
        DataValidation v = h.createValidation(c, new CellRangeAddressList(1, SheetReader.MAX_ROWS, column, column));
        v.setShowErrorBox(true);
        v.createErrorBox("Litres", "Enter a number between " + (long) min + " and " + (long) max + ".");
        sheet.addValidationData(v);
    }
}
