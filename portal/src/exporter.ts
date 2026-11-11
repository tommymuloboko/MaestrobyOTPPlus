import { sessionStore } from './api';
import { currencyPrefix, ownCurrencyCode } from './currency';
import { XLSX_MIME, buildXlsx, type XlsxType } from './xlsx';

/**
 * One description of a report, rendered to print, PDF, Excel or CSV. Every page builds an ExportSpec from the data it
 * is already showing, so what is exported is what is on screen.
 */
export type ColType = XlsxType;
export type Cell = string | number | null | undefined;

export interface ExportColumn { header: string; type?: ColType }

export interface ExportSpec {
  title: string;
  subtitle?: string;
  note?: string;
  /** Without extension or date; both are added. */
  filename: string;
  /** Currency of 'money' columns. Defaults to the signed-in user's own currency. Use a number column plus a Currency column when rows differ. */
  currency?: string;
  columns: ExportColumn[];
  rows: Cell[][];
  totals?: Cell[];
}

export type ExportFormat = 'print' | 'pdf' | 'xlsx' | 'csv';

const typeOf = (c: ExportColumn): ColType => c.type ?? 'text';
const isNumeric = (t: ColType) => t === 'number' || t === 'litres' || t === 'money' || t === 'percent';
const isLandscape = (spec: ExportSpec) => spec.columns.length > 6;

const fmt = (min: number, max: number) => new Intl.NumberFormat(undefined, { minimumFractionDigits: min, maximumFractionDigits: max });
const NF = { money: fmt(2, 2), litres: fmt(0, 1), number: fmt(0, 2), percent: fmt(0, 1) };

const pad = (n: number) => String(n).padStart(2, '0');
const stamp = (d = new Date()) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const isoLocal = (d: Date) => `${stamp(d)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;

const specPrefix = (spec: ExportSpec) => currencyPrefix(spec.currency ?? ownCurrencyCode());

/** The text a person sees on a printed page or in a PDF. */
export function display(cell: Cell, type: ColType, moneyPrefix = currencyPrefix(ownCurrencyCode())): string {
  if (cell === null || cell === undefined || cell === '') return '';
  if (isNumeric(type)) {
    const n = typeof cell === 'number' ? cell : Number(cell);
    if (!Number.isFinite(n)) return String(cell);
    return type === 'money' ? `${moneyPrefix} ${NF.money.format(n)}` : type === 'percent' ? `${NF.percent.format(n)}%` : NF[type].format(n);
  }
  if (type === 'datetime') {
    const d = new Date(String(cell));
    return Number.isNaN(d.getTime()) ? String(cell) : d.toLocaleString();
  }
  return String(cell);
}

/** Who made the export and when, so a printed copy can be traced back. */
function meta(): string {
  const s = sessionStore.get();
  const who = s ? ` by ${s.name}${s.organization ? ` (${s.organization})` : ''}` : '';
  return `Generated ${new Date().toLocaleString()}${who}`;
}

function headerLines(spec: ExportSpec): string[] {
  return [spec.title, ...(spec.subtitle ? [spec.subtitle] : []), ...(spec.note ? [spec.note] : []), meta()];
}

const save = (blob: Blob, filename: string) => {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // revoking straight away can cancel the download in some browsers
  setTimeout(() => URL.revokeObjectURL(url), 2000);
};

/* ── CSV ─────────────────────────────────────────────────── */

// a leading = + - @ makes a spreadsheet run a text cell as a formula
const csvText = (v: string) => {
  const safe = /^[=+@\t\r]|^-(?!\d)/.test(v) ? `'${v}` : v;
  return /[",\r\n]/.test(safe) ? `"${safe.replaceAll('"', '""')}"` : safe;
};

export function toCsv(spec: ExportSpec): string {
  const cell = (c: Cell, type: ColType) => {
    if (c === null || c === undefined || c === '') return '';
    if (isNumeric(type)) return Number.isFinite(Number(c)) ? String(Number(c)) : csvText(String(c));
    if (type === 'datetime') {
      const d = new Date(String(c));
      return Number.isNaN(d.getTime()) ? csvText(String(c)) : isoLocal(d);
    }
    return csvText(String(c));
  };
  const types = spec.columns.map(typeOf);
  const lines = [spec.columns.map((c) => csvText(c.header)).join(',')];
  for (const row of spec.rows) lines.push(row.map((c, i) => cell(c, types[i])).join(','));
  if (spec.totals) lines.push(spec.totals.map((c, i) => cell(c, types[i])).join(','));
  return lines.join('\r\n');
}

/* ── Excel ───────────────────────────────────────────────── */

export function toXlsx(spec: ExportSpec): Uint8Array {
  return buildXlsx({
    name: spec.title,
    titleRows: headerLines(spec),
    columns: spec.columns.map((c) => ({ header: c.header, type: typeOf(c) })),
    rows: spec.rows,
    totals: spec.totals,
    landscape: isLandscape(spec),
    moneyPrefix: specPrefix(spec),
  });
}

/* ── PDF ─────────────────────────────────────────────────── */

// the built-in PDF fonts only cover Latin-1 and a few punctuation marks; anything else would print as garbage
const pdfSafe = (s: string) =>
  s.replace(/[→⇒]/g, '->').replace(/[^\u0020-\u007E\u00A0-\u00FF\u2013\u2014\u2018\u2019\u201C\u201D\u2022\u2026\u20AC]/g, '?');

async function toPdf(spec: ExportSpec): Promise<Blob> {
  const [{ jsPDF }, { autoTable }] = await Promise.all([import('jspdf'), import('jspdf-autotable')]);
  const doc = new jsPDF({ orientation: isLandscape(spec) ? 'landscape' : 'portrait', unit: 'pt', format: 'a4' });
  const margin = 36;
  const width = doc.internal.pageSize.getWidth();
  const height = doc.internal.pageSize.getHeight();

  doc.setFont('helvetica', 'bold');
  doc.setFontSize(16);
  doc.text(pdfSafe(spec.title), margin, 44);
  doc.setFont('helvetica', 'normal');
  doc.setFontSize(9);
  doc.setTextColor(107, 114, 128);
  let y = 60;
  for (const line of headerLines(spec).slice(1)) {
    doc.text(pdfSafe(line), margin, y);
    y += 12;
  }

  const types = spec.columns.map(typeOf);
  const body = spec.rows.map((r) => r.map((c, i) => pdfSafe(display(c, types[i], specPrefix(spec)))));
  const columnStyles: Record<number, { halign: 'right' }> = {};
  types.forEach((t, i) => { if (t !== 'text') columnStyles[i] = { halign: 'right' }; });

  autoTable(doc, {
    startY: y + 6,
    head: [spec.columns.map((c) => pdfSafe(c.header))],
    body: body.length ? body : [[{ content: 'No data', colSpan: spec.columns.length, styles: { halign: 'center' } }]],
    foot: spec.totals ? [spec.totals.map((c, i) => pdfSafe(display(c, types[i], specPrefix(spec))))] : undefined,
    showFoot: 'lastPage',
    theme: 'striped',
    styles: { font: 'helvetica', fontSize: 8, cellPadding: 4, overflow: 'linebreak', textColor: [17, 24, 39] },
    headStyles: { fillColor: [30, 142, 62], textColor: 255, fontStyle: 'bold' },
    footStyles: { fillColor: [243, 244, 246], textColor: [17, 24, 39], fontStyle: 'bold' },
    alternateRowStyles: { fillColor: [249, 250, 251] },
    columnStyles,
    margin: { left: margin, right: margin, bottom: 40 },
  });

  const pages = doc.getNumberOfPages();
  doc.setFontSize(8);
  doc.setTextColor(107, 114, 128);
  for (let p = 1; p <= pages; p++) {
    doc.setPage(p);
    doc.text('Maestro FuelOrder', margin, height - 20);
    doc.text(`Page ${p} of ${pages}`, width - margin, height - 20, { align: 'right' });
  }
  return doc.output('blob');
}

/* ── Print ───────────────────────────────────────────────── */

const PRINT_CSS = `
  * { box-sizing: border-box; }
  body { font-family: Arial, Helvetica, sans-serif; color: #111827; margin: 0; font-size: 11px; }
  h1 { font-size: 18px; margin: 0 0 4px; }
  p { margin: 0 0 2px; color: #6b7280; font-size: 11px; }
  table { width: 100%; border-collapse: collapse; margin-top: 12px; }
  th { background: #1e8e3e; color: #fff; text-align: left; padding: 5px 6px; font-size: 10px; }
  td { padding: 5px 6px; border-bottom: 1px solid #e5e7eb; vertical-align: top; }
  tr:nth-child(even) td { background: #f9fafb; }
  thead { display: table-header-group; }
  tr { page-break-inside: avoid; }
  .num { text-align: right; white-space: nowrap; }
  tfoot td { font-weight: bold; background: #f3f4f6; border-top: 1px solid #111827; }
  .empty { text-align: center; color: #6b7280; padding: 16px; }
`;

function printSpec(spec: ExportSpec): void {
  const frame = document.createElement('iframe');
  frame.setAttribute('aria-hidden', 'true');
  frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden';
  document.body.appendChild(frame);

  const doc = frame.contentDocument;
  const win = frame.contentWindow;
  if (!doc || !win) {
    frame.remove();
    throw new Error('Printing is not available in this browser.');
  }
  doc.open();
  doc.write('<!doctype html><html><head><meta charset="utf-8"></head><body></body></html>');
  doc.close();
  doc.title = spec.title;

  // built with the DOM API and textContent, so nothing from the data is ever parsed as HTML
  const el = <K extends keyof HTMLElementTagNameMap>(tag: K, content?: string, className?: string) => {
    const e = doc.createElement(tag);
    if (content !== undefined) e.textContent = content;
    if (className) e.className = className;
    return e;
  };
  const style = el('style', `@page { size: A4 ${isLandscape(spec) ? 'landscape' : 'portrait'}; margin: 12mm; }${PRINT_CSS}`);
  doc.head.appendChild(style);
  const lines = headerLines(spec);
  doc.body.appendChild(el('h1', lines[0]));
  lines.slice(1).forEach((l) => doc.body.appendChild(el('p', l)));

  const types = spec.columns.map(typeOf);
  const table = el('table');
  const headRow = el('tr');
  spec.columns.forEach((c, i) => headRow.appendChild(el('th', c.header, types[i] !== 'text' ? 'num' : undefined)));
  table.appendChild(el('thead')).appendChild(headRow);
  const tbody = table.appendChild(el('tbody'));
  if (spec.rows.length === 0) {
    const tr = tbody.appendChild(el('tr'));
    const td = tr.appendChild(el('td', 'No data', 'empty'));
    td.colSpan = spec.columns.length;
  }
  for (const row of spec.rows) {
    const tr = tbody.appendChild(el('tr'));
    row.forEach((c, i) => tr.appendChild(el('td', display(c, types[i], specPrefix(spec)), types[i] !== 'text' ? 'num' : undefined)));
  }
  if (spec.totals) {
    const tr = table.appendChild(el('tfoot')).appendChild(el('tr'));
    spec.totals.forEach((c, i) => tr.appendChild(el('td', display(c, types[i], specPrefix(spec)), types[i] !== 'text' ? 'num' : undefined)));
  }
  doc.body.appendChild(table);

  const cleanup = () => frame.remove();
  win.addEventListener('afterprint', cleanup);
  setTimeout(cleanup, 5 * 60_000);
  win.focus();
  win.print();
}

/* ── entry point ─────────────────────────────────────────── */

export async function exportSpec(spec: ExportSpec, format: ExportFormat): Promise<void> {
  const base = `${spec.filename}-${stamp()}`;
  switch (format) {
    case 'print':
      printSpec(spec);
      return;
    case 'pdf':
      save(await toPdf(spec), `${base}.pdf`);
      return;
    case 'xlsx':
      save(new Blob([new Uint8Array(toXlsx(spec))], { type: XLSX_MIME }), `${base}.xlsx`);
      return;
    case 'csv':
      // the BOM lets Excel read non-English characters correctly
      save(new Blob(['\uFEFF', toCsv(spec)], { type: 'text/csv;charset=utf-8' }), `${base}.csv`);
      return;
  }
}
