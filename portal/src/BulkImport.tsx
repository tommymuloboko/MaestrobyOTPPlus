import { useRef, useState } from 'react';
import { api, type BulkKind, type BulkResult } from './api';
import { Ic } from './ui';

interface Props {
  kind: BulkKind;
  /** Plural noun used in the copy, e.g. "vehicles". */
  noun: string;
  /** Orders only: the product the allocations are checked against. */
  fuelProduct?: string;
  /** Orders only: restricts the downloaded template to vehicles that take this fuel. */
  templateFuelType?: string;
  /** Called after a successful import (vehicles, drivers) or when valid rows are accepted (orders). */
  onDone: (result: BulkResult) => void | Promise<void>;
  onClose: () => void;
}

const saveBlob = (blob: Blob, filename: string) => {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};

// a leading = + - @ makes spreadsheet programs run a cell as a formula
const csvCell = (v: string) => `"${(/^[=+\-@]/.test(v) ? `'${v}` : v).replace(/"/g, '""')}"`;

const COLUMN_LABELS: Record<string, string> = {
  registration: 'Registration', description: 'Description', fuelType: 'Fuel type', capacity: 'Tank (L)',
  vehicleType: 'Type', model: 'Model', modelYear: 'Year',
  name: 'Driver', phone: 'Phone', licenseNo: 'Licence', vehicleReg: 'Vehicle', driverName: 'Driver', litres: 'Litres',
};

function PinSheet({ result }: { result: BulkResult }) {
  const download = () => {
    const lines = ['Driver,PIN', ...result.pins.map((p) => `${csvCell(p.name)},${csvCell(p.pin)}`)];
    saveBlob(new Blob([lines.join('\r\n')], { type: 'text/csv' }), 'driver-pins.csv');
  };
  return (
    <div className="otp-box">
      <strong>{result.pins.length} driver PINs issued</strong>
      <small>These are shown only now and are never stored in readable form. Drivers with a phone number were also sent theirs by SMS.</small>
      <table className="bulk-table">
        <thead><tr><th>Driver</th><th>PIN</th></tr></thead>
        <tbody>{result.pins.map((p) => <tr key={p.row}><td>{p.name}</td><td><b className="mono">{p.pin}</b></td></tr>)}</tbody>
      </table>
      <div><button type="button" className="btn-ghost" onClick={download}><Ic n="download" s={13} /> Download PIN list (CSV)</button></div>
    </div>
  );
}

export default function BulkImport({ kind, noun, fuelProduct, templateFuelType, onDone, onClose }: Props) {
  const input = useRef<HTMLInputElement>(null);
  const [file, setFile] = useState<File | null>(null);
  const [result, setResult] = useState<BulkResult | null>(null);
  const [imported, setImported] = useState<BulkResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const run = async (f: File) => {
    setBusy(true);
    setError('');
    setResult(null);
    try {
      setResult(kind === 'orders' ? await api.bulkOrderParse(f, fuelProduct ?? '') : await api.bulkImport(kind, f, true));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not read the file');
    } finally {
      setBusy(false);
    }
  };

  const pick = (f: File | undefined) => {
    setImported(null);
    setFile(f ?? null);
    if (f) void run(f);
  };

  const template = async () => {
    setError('');
    try {
      saveBlob(await api.bulkTemplate(kind, templateFuelType), `maestro-${kind}-template.xlsx`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not download the template');
    }
  };

  const confirm = async () => {
    if (!result || !file) return;
    setBusy(true);
    setError('');
    try {
      if (kind === 'orders') {
        await onDone(result);
        onClose();
        return;
      }
      const done = await api.bulkImport(kind, file, false);
      if (done.error || !done.imported) {
        setResult(done);
        return;
      }
      setImported(done);
      setResult(null);
      setFile(null);
      if (input.current) input.current.value = '';
      await onDone(done);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The import failed');
    } finally {
      setBusy(false);
    }
  };

  const problems = result?.rows.filter((r) => r.status === 'ERROR') ?? [];
  const preview = result?.rows.filter((r) => r.status === 'OK') ?? [];
  const ready = !!result && !result.error && result.invalid === 0 && result.valid > 0;

  return (
    <section className="card bulk-panel">
      <div className="card-head">
        <h2><Ic n="sheet" s={16} /> Import {noun} from Excel</h2>
        <button type="button" className="btn-ghost" onClick={onClose}>Close</button>
      </div>

      <ol className="bulk-steps">
        <li>
          <b>Download the template</b>
          <span>
            {kind === 'orders'
              ? 'It is pre-filled with your vehicles and their usual drivers; type the litres for the ones you want to fuel.'
              : 'Fill in one row per record. Columns marked * are required.'}
          </span>
          <button type="button" className="cta" onClick={template}><Ic n="download" s={13} /> Download template (.xlsx)</button>
        </li>
        <li>
          <b>Upload the completed file</b>
          <span>Every row is checked before anything is saved{kind === 'orders' ? ' or added to the order' : ''}. Up to 500 rows, 2 MB, .xlsx only.</span>
          <label className="bulk-file">
            <input ref={input} type="file" accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              onChange={(e) => pick(e.target.files?.[0])} />
            <span><Ic n="upload" s={13} /> {file ? file.name : 'Choose a file…'}</span>
          </label>
        </li>
      </ol>

      {error && <div className="error" role="alert">{error}</div>}
      {busy && <p className="muted">Checking the file…</p>}

      {result?.error && <div className="error" role="alert">{result.error}</div>}

      {imported && (
        <>
          <div className="otp-box">
            <strong>{imported.valid} {noun} imported</strong>
          </div>
          {imported.pins.length > 0 && <PinSheet result={imported} />}
        </>
      )}

      {result && !result.error && (
        <>
          <div className={ready ? 'otp-box' : 'error'} role="status">
            <strong>
              {ready
                ? `${result.valid} of ${result.total} rows are valid${result.skipped ? `, ${result.skipped} skipped (no litres)` : ''}.`
                : `${result.invalid} of ${result.total} rows have problems. Nothing was imported; fix them in Excel and upload the file again.`}
            </strong>
          </div>

          {problems.length > 0 && (
            <table className="bulk-table">
              <thead><tr><th>Excel row</th><th>Problem</th></tr></thead>
              <tbody>
                {problems.slice(0, 100).map((r) => <tr key={r.row}><td>{r.row}</td><td>{r.message}</td></tr>)}
                {problems.length > 100 && <tr><td colSpan={2}>…and {problems.length - 100} more.</td></tr>}
              </tbody>
            </table>
          )}

          {ready && (
            <>
              <table className="bulk-table">
                <thead><tr>{Object.keys(preview[0]?.values ?? {}).map((k) => <th key={k}>{COLUMN_LABELS[k] ?? k}</th>)}</tr></thead>
                <tbody>
                  {preview.slice(0, 10).map((r) => (
                    <tr key={r.row}>{Object.values(r.values).map((v, i) => <td key={i}>{v}</td>)}</tr>
                  ))}
                </tbody>
              </table>
              {preview.length > 10 && <small className="muted">Showing the first 10 of {preview.length} rows.</small>}
              <div className="inline-actions">
                <button type="button" className="cta green" disabled={busy} onClick={confirm}>
                  {kind === 'orders' ? `Use these ${result.valid} allocations` : `Import ${result.valid} ${noun}`}
                </button>
              </div>
            </>
          )}
        </>
      )}
    </section>
  );
}
