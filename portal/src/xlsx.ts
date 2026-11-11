import { strToU8, zipSync } from 'fflate';

/**
 * A small writer for single-sheet .xlsx workbooks made of a title block and one table. It exists so the portal does
 * not need a spreadsheet library: the files are plain XML in a zip. Text is always written as a string cell, never as
 * a formula, so a value such as "=1+1" shows up as text and is never executed by Excel.
 */
export type XlsxType = 'text' | 'number' | 'litres' | 'money' | 'percent' | 'datetime' | 'date';
export type XlsxCell = string | number | null | undefined;

export interface XlsxColumn { header: string; type: XlsxType }

export interface XlsxSheet {
  name: string;
  /** Shown above the table; the first line is the title. */
  titleRows: string[];
  columns: XlsxColumn[];
  rows: XlsxCell[][];
  totals?: XlsxCell[];
  landscape?: boolean;
  /** Text shown before 'money' amounts, e.g. "R" or "ZMW". Defaults to "R". */
  moneyPrefix?: string;
}

export const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

const MAX_CELL_CHARS = 32_767;
const INVALID_XML = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g;
const esc = (s: string) =>
  s.replace(INVALID_XML, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const NUM_FMT: Record<XlsxType, number> = { text: 0, number: 0, litres: 165, money: 164, percent: 166, datetime: 167, date: 168 };
const TYPES: XlsxType[] = ['text', 'number', 'litres', 'money', 'percent', 'datetime', 'date'];

/* Style indexes into cellXfs below: 0 default, 1 title, 2 meta, 3 header (left), 4 header (right),
   then body styles per type, then totals styles per type. */
const XF_TITLE = 1;
const XF_META = 2;
const XF_HEAD_LEFT = 3;
const XF_HEAD_RIGHT = 4;
const XF_BODY = (t: XlsxType) => 5 + TYPES.indexOf(t);
const XF_TOTAL = (t: XlsxType) => 5 + TYPES.length + TYPES.indexOf(t);

const isRightAligned = (t: XlsxType) => t !== 'text';

function stylesXml(moneyPrefix: string): string {
  const xf = (numFmtId: number, fontId: number, fillId: number, borderId: number, align?: string) =>
    `<xf numFmtId="${numFmtId}" fontId="${fontId}" fillId="${fillId}" borderId="${borderId}" xfId="0"` +
    `${numFmtId ? ' applyNumberFormat="1"' : ''} applyFont="1"${fillId ? ' applyFill="1"' : ''}${borderId ? ' applyBorder="1"' : ''}` +
    `${align ? ` applyAlignment="1"><alignment horizontal="${align}" vertical="center"/></xf>` : '/>'}`;
  const xfs = [
    xf(0, 0, 0, 0),
    xf(0, 2, 0, 0),
    xf(0, 3, 0, 0),
    xf(0, 4, 2, 0, 'left'),
    xf(0, 4, 2, 0, 'right'),
    ...TYPES.map((t) => xf(NUM_FMT[t], 0, 0, 1)),
    ...TYPES.map((t) => xf(NUM_FMT[t], 1, 3, 2)),
  ];
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
    + '<numFmts count="5">'
    + `<numFmt numFmtId="164" formatCode="&quot;${esc(moneyPrefix)}&quot; #,##0.00"/>`
    + '<numFmt numFmtId="165" formatCode="#,##0.0"/>'
    + '<numFmt numFmtId="166" formatCode="0.0&quot;%&quot;"/>'
    + '<numFmt numFmtId="167" formatCode="yyyy\\-mm\\-dd\\ hh:mm"/>'
    + '<numFmt numFmtId="168" formatCode="yyyy\\-mm\\-dd"/>'
    + '</numFmts>'
    + '<fonts count="5">'
    + '<font><sz val="11"/><name val="Calibri"/></font>'
    + '<font><b/><sz val="11"/><name val="Calibri"/></font>'
    + '<font><b/><sz val="14"/><name val="Calibri"/></font>'
    + '<font><i/><sz val="10"/><color rgb="FF6B7280"/><name val="Calibri"/></font>'
    + '<font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font>'
    + '</fonts>'
    + '<fills count="4">'
    + '<fill><patternFill patternType="none"/></fill>'
    + '<fill><patternFill patternType="gray125"/></fill>'
    + '<fill><patternFill patternType="solid"><fgColor rgb="FF1E8E3E"/><bgColor indexed="64"/></patternFill></fill>'
    + '<fill><patternFill patternType="solid"><fgColor rgb="FFF3F4F6"/><bgColor indexed="64"/></patternFill></fill>'
    + '</fills>'
    + '<borders count="3">'
    + '<border><left/><right/><top/><bottom/><diagonal/></border>'
    + '<border><left/><right/><top/><bottom style="thin"><color rgb="FFE5E7EB"/></bottom><diagonal/></border>'
    + '<border><left/><right/><top style="thin"><color rgb="FF111827"/></top><bottom/><diagonal/></border>'
    + '</borders>'
    + '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
    + `<cellXfs count="${xfs.length}">${xfs.join('')}</cellXfs>`
    + '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>'
    + '</styleSheet>';
}

export function colName(index: number): string {
  let n = index + 1;
  let s = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

/** Excel stores dates as days since 1899-12-30; local wall-clock time is kept, as Excel has no time zones. */
export function excelSerial(value: string, withTime: boolean): number | null {
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (dateOnly) {
    return Date.UTC(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3])) / 86_400_000 + 25_569;
  }
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  const ms = Date.UTC(d.getFullYear(), d.getMonth(), d.getDate(),
    withTime ? d.getHours() : 0, withTime ? d.getMinutes() : 0, withTime ? d.getSeconds() : 0);
  return ms / 86_400_000 + 25_569;
}

const text = (ref: string, style: number, value: string) =>
  `<c r="${ref}" s="${style}" t="inlineStr"><is><t xml:space="preserve">${esc(value.slice(0, MAX_CELL_CHARS))}</t></is></c>`;

function cellXml(ref: string, style: number, type: XlsxType, value: XlsxCell): string {
  if (value === null || value === undefined || value === '') return '';
  if (type === 'datetime' || type === 'date') {
    const serial = typeof value === 'string' ? excelSerial(value, type === 'datetime') : null;
    return serial === null ? text(ref, style, String(value)) : `<c r="${ref}" s="${style}"><v>${serial}</v></c>`;
  }
  if (type !== 'text') {
    const n = typeof value === 'number' ? value : Number(String(value).trim());
    if (Number.isFinite(n) && String(value).trim() !== '') return `<c r="${ref}" s="${style}"><v>${n}</v></c>`;
  }
  return text(ref, style, String(value));
}

const widthOf = (type: XlsxType, v: XlsxCell): number => {
  if (v === null || v === undefined) return 0;
  if (type === 'datetime') return 16;
  if (type === 'money') return String(v).length + 4;
  return String(v).length;
};

export function buildXlsx(sheet: XlsxSheet): Uint8Array {
  const name = sheet.name.replace(/[[\]:*?/\\]/g, ' ').trim().slice(0, 31) || 'Report';
  const cols = sheet.columns;
  const lastCol = colName(cols.length - 1);

  const rows: string[] = [];
  let r = 1;
  sheet.titleRows.forEach((line, i) => {
    rows.push(`<row r="${r}">${text(`A${r}`, i === 0 ? XF_TITLE : XF_META, line)}</row>`);
    r++;
  });
  if (sheet.titleRows.length) r++;

  const headerRow = r;
  rows.push(`<row r="${r}">${cols.map((c, i) =>
    text(`${colName(i)}${r}`, isRightAligned(c.type) ? XF_HEAD_RIGHT : XF_HEAD_LEFT, c.header)).join('')}</row>`);
  r++;

  for (const row of sheet.rows) {
    rows.push(`<row r="${r}">${cols.map((c, i) => cellXml(`${colName(i)}${r}`, XF_BODY(c.type), c.type, row[i])).join('')}</row>`);
    r++;
  }
  const lastData = r - 1;

  if (sheet.totals) {
    const totals = sheet.totals;
    rows.push(`<row r="${r}">${cols.map((c, i) => {
      const ref = `${colName(i)}${r}`;
      // an empty totals cell still needs the shaded style, so the band runs across the whole row;
      // a text label (such as "Total") in a numeric or date column keeps the plain text format
      const v = totals[i];
      if (v === null || v === undefined || v === '') return `<c r="${ref}" s="${XF_TOTAL('text')}"/>`;
      return typeof v === 'string' && Number.isNaN(Number(v)) && c.type !== 'text'
        ? text(ref, XF_TOTAL('text'), v)
        : cellXml(ref, XF_TOTAL(c.type), c.type, v);
    }).join('')}</row>`);
    r++;
  }
  const lastRow = r - 1;

  const widths = cols.map((c, i) => {
    let longest = c.header.length;
    for (const row of sheet.rows) longest = Math.max(longest, widthOf(c.type, row[i]));
    if (sheet.totals) longest = Math.max(longest, widthOf(c.type, sheet.totals[i]));
    return Math.min(Math.max(longest + 3, 9), 60);
  });

  const hasData = sheet.rows.length > 0;
  const sheetXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
    + '<sheetPr><pageSetUpPr fitToPage="1"/></sheetPr>'
    + `<dimension ref="A1:${lastCol}${lastRow}"/>`
    + `<sheetViews><sheetView workbookViewId="0" showGridLines="0"><pane ySplit="${headerRow}" topLeftCell="A${headerRow + 1}" activePane="bottomLeft" state="frozen"/><selection pane="bottomLeft"/></sheetView></sheetViews>`
    + '<sheetFormatPr defaultRowHeight="15"/>'
    + `<cols>${widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join('')}</cols>`
    + `<sheetData>${rows.join('')}</sheetData>`
    + (hasData ? `<autoFilter ref="A${headerRow}:${lastCol}${lastData}"/>` : '')
    + '<pageMargins left="0.5" right="0.5" top="0.6" bottom="0.6" header="0.3" footer="0.3"/>'
    + `<pageSetup paperSize="9" orientation="${sheet.landscape ? 'landscape' : 'portrait'}" fitToWidth="1" fitToHeight="0"/>`
    + '</worksheet>';

  const quoted = `'${name.replace(/'/g, "''")}'`;
  const workbookXml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
    + '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
    + `<sheets><sheet name="${esc(name)}" sheetId="1" r:id="rId1"/></sheets>`
    + '<definedNames>'
    + (hasData ? `<definedName name="_xlnm._FilterDatabase" localSheetId="0" hidden="1">${esc(quoted)}!$A$${headerRow}:$${lastCol}$${lastData}</definedName>` : '')
    + `<definedName name="_xlnm.Print_Titles" localSheetId="0">${esc(quoted)}!$${headerRow}:$${headerRow}</definedName>`
    + '</definedNames>'
    + '</workbook>';

  const files: Record<string, Uint8Array> = {
    '[Content_Types].xml': strToU8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
      + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
      + '<Default Extension="xml" ContentType="application/xml"/>'
      + '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
      + '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
      + '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'
      + '</Types>'),
    '_rels/.rels': strToU8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
      + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>'
      + '</Relationships>'),
    'xl/workbook.xml': strToU8(workbookXml),
    'xl/_rels/workbook.xml.rels': strToU8('<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
      + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
      + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>'
      + '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>'
      + '</Relationships>'),
    'xl/styles.xml': strToU8(stylesXml(sheet.moneyPrefix ?? 'R')),
    'xl/worksheets/sheet1.xml': strToU8(sheetXml),
  };
  return zipSync(files);
}
