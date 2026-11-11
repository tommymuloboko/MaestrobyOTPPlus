package com.maestro.fuelorder.bulk;

import org.apache.poi.openxml4j.util.ZipSecureFile;
import org.apache.poi.ss.usermodel.Cell;
import org.apache.poi.ss.usermodel.CellType;
import org.apache.poi.ss.usermodel.DateUtil;
import org.apache.poi.ss.usermodel.Row;
import org.apache.poi.ss.usermodel.Sheet;
import org.apache.poi.ss.usermodel.Workbook;
import org.apache.poi.xssf.usermodel.XSSFWorkbook;

import java.io.InputStream;
import java.math.BigDecimal;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/**
 * Reads the Data sheet of an uploaded .xlsx into plain strings. Columns are found by header name, so a customer who
 * reorders or adds columns does not break the import. Uploads are untrusted: formulas are refused, and the size of
 * the workbook and the number of rows are capped.
 */
final class SheetReader {

    static final int MAX_ROWS = 500;

    static {
        ZipSecureFile.setMaxEntrySize(20_000_000L);
        ZipSecureFile.setMaxTextSize(10_000_000L);
    }

    /** A column the template defines. {@code key} is what rows are keyed by; aliases are alternative header names. */
    record Col(String key, String label, boolean required, String... aliases) {}

    record DataRow(int number, Map<String, String> values, List<String> problems) {}

    /** Either a fatal problem with the file as a whole, or the rows that were read. */
    record Parsed(String fatal, List<DataRow> rows) {}

    private SheetReader() {}

    static Parsed read(InputStream in, List<Col> cols) {
        try (Workbook wb = new XSSFWorkbook(in)) {
            Sheet sheet = wb.getSheet("Data");
            if (sheet == null) {
                sheet = wb.getNumberOfSheets() > 0 ? wb.getSheetAt(0) : null;
            }
            if (sheet == null) {
                return fatal("The workbook has no sheets.");
            }
            Row header = sheet.getRow(sheet.getFirstRowNum());
            if (header == null) {
                return fatal("The sheet is empty. Download the template and fill it in.");
            }
            Map<String, Integer> index = headerIndex(header, cols);
            List<String> missing = cols.stream().filter(c -> c.required() && !index.containsKey(c.key()))
                    .map(c -> c.label().replace(" *", "")).toList();
            if (!missing.isEmpty()) {
                return fatal("Missing required column(s): " + String.join(", ", missing)
                        + ". Use the downloaded template without renaming its headers.");
            }
            List<DataRow> rows = new ArrayList<>();
            for (int r = header.getRowNum() + 1; r <= sheet.getLastRowNum(); r++) {
                Row row = sheet.getRow(r);
                if (row == null) {
                    continue;
                }
                Map<String, String> values = new LinkedHashMap<>();
                List<String> problems = new ArrayList<>();
                for (Col c : cols) {
                    Integer at = index.get(c.key());
                    values.put(c.key(), at == null ? "" : text(row.getCell(at), c.label(), problems));
                }
                if (problems.isEmpty() && values.values().stream().allMatch(String::isEmpty)) {
                    continue;
                }
                if (rows.size() >= MAX_ROWS) {
                    return fatal("The sheet has more than " + MAX_ROWS + " rows. Split it into several files.");
                }
                rows.add(new DataRow(r + 1, values, problems));
            }
            if (rows.isEmpty()) {
                return fatal("The sheet has no data rows.");
            }
            return new Parsed(null, rows);
        } catch (Exception e) {
            return fatal("That file could not be read. Upload an .xlsx workbook (not .xls or .csv) made from the template.");
        }
    }

    private static Parsed fatal(String message) {
        return new Parsed(message, List.of());
    }

    private static Map<String, Integer> headerIndex(Row header, List<Col> cols) {
        Map<String, Integer> index = new LinkedHashMap<>();
        for (Cell cell : header) {
            if (cell.getCellType() != CellType.STRING) {
                continue;
            }
            String name = normalize(cell.getStringCellValue());
            for (Col c : cols) {
                if (!index.containsKey(c.key()) && (name.equals(normalize(c.key())) || name.equals(normalize(c.label()))
                        || matchesAlias(name, c))) {
                    index.put(c.key(), cell.getColumnIndex());
                }
            }
        }
        return index;
    }

    private static boolean matchesAlias(String name, Col c) {
        for (String alias : c.aliases()) {
            if (name.equals(normalize(alias))) {
                return true;
            }
        }
        return false;
    }

    /** "Tank capacity (L) *" and "tank capacity (l)" both become "tankcapacityl". */
    static String normalize(String header) {
        return header.toLowerCase(Locale.ROOT).replaceAll("[^a-z0-9]", "");
    }

    private static String text(Cell c, String label, List<String> problems) {
        if (c == null) {
            return "";
        }
        String name = label.replace(" *", "");
        switch (c.getCellType()) {
            case STRING:
                return c.getStringCellValue().trim();
            case NUMERIC:
                if (DateUtil.isCellDateFormatted(c)) {
                    problems.add(name + ": a date was entered where text or a number is expected");
                    return "";
                }
                return BigDecimal.valueOf(c.getNumericCellValue()).stripTrailingZeros().toPlainString();
            case BOOLEAN:
                return String.valueOf(c.getBooleanCellValue());
            case FORMULA:
                problems.add(name + ": formulas are not allowed, paste the value instead");
                return "";
            case ERROR:
                problems.add(name + ": the cell contains an error value");
                return "";
            default:
                return "";
        }
    }
}
