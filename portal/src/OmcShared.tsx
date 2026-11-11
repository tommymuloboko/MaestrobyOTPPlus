import { useEffect, useRef, useState, type ReactNode } from 'react';
import { errorText, Ic } from './ui';

export const sumOf = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
export const lower = (s: string) => s.replaceAll('_', ' ').toLowerCase();
export const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
export const matches = (needle: string, ...fields: (string | null | undefined)[]) => {
  const n = needle.trim().toLowerCase();
  return !n || fields.some((f) => (f ?? '').toLowerCase().includes(n));
};

/**
 * Row selection for a table. `ids` are the rows that can be selected right now (for example the filtered rows that
 * are still pending); anything selected earlier that is no longer in `ids` is ignored rather than acted on.
 */
export function useSelection(ids: string[]) {
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const selected = ids.filter((id) => picked.has(id));
  const allSelected = ids.length > 0 && selected.length === ids.length;
  const toggle = (id: string) => setPicked((p) => {
    const next = new Set(p);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const toggleAll = () => setPicked((p) => {
    const next = new Set(p);
    for (const id of ids) {
      if (allSelected) next.delete(id); else next.add(id);
    }
    return next;
  });
  return {
    selected, allSelected, someSelected: selected.length > 0 && !allSelected,
    has: (id: string) => picked.has(id), toggle, toggleAll, clear: () => setPicked(new Set()),
  };
}

/** A checkbox that can show the "some rows selected" state used by select-all headers. */
export function SelectBox({ checked, indeterminate, disabled, label, onChange }: {
  checked: boolean; indeterminate?: boolean; disabled?: boolean; label: string; onChange: () => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => { if (ref.current) ref.current.indeterminate = !!indeterminate; }, [indeterminate]);
  return <input ref={ref} type="checkbox" className="select-box" aria-label={label} checked={checked} disabled={disabled} onChange={onChange} />;
}

export interface BulkResultData<R> {
  done: { label: string; result: R }[];
  failed: { label: string; error: string }[];
}

/** Runs one request per item, one after another, and reports each outcome so a single failure never hides the rest. */
export async function runBulk<I, R>(items: I[], label: (item: I) => string, fn: (item: I) => Promise<R>): Promise<BulkResultData<R>> {
  const out: BulkResultData<R> = { done: [], failed: [] };
  for (const item of items) {
    try {
      out.done.push({ label: label(item), result: await fn(item) });
    } catch (e) {
      out.failed.push({ label: label(item), error: errorText(e) });
    }
  }
  return out;
}

/** The bar above a table that shows how many rows are selected and holds the actions for them. */
export function SelectionBar({ selected, total, noun, onClear, children }: {
  selected: number; total: number; noun: string; onClear: () => void; children: ReactNode;
}) {
  return (
    <div className="select-bar" role="toolbar" aria-label={`Actions for selected ${noun}`}>
      <b>{selected} of {total} {noun} selected</b>
      <div className="inline-actions row-actions">
        {children}
        {selected > 0 && <button type="button" className="mini-btn" onClick={onClear}>Clear selection</button>}
      </div>
    </div>
  );
}

/** What happened to each row of a bulk action, with an optional extra column (such as a one-time code). */
export function BulkResultBox<R>({ title, result, detail, detailLabel, note, onDismiss }: {
  title: string; result: BulkResultData<R>; detail?: (r: R) => string | null; detailLabel?: string; note?: string; onDismiss: () => void;
}) {
  const total = result.done.length + result.failed.length;
  return (
    <div className={result.failed.length ? 'select-result has-errors' : 'select-result'} role="status">
      <strong>{title}: {result.done.length} of {total} succeeded{result.failed.length ? `, ${result.failed.length} failed` : ''}</strong>
      {result.done.length > 0 && detail && (
        <table className="bulk-table">
          <thead><tr><th>Item</th><th>{detailLabel}</th></tr></thead>
          <tbody>
            {result.done.map((d) => (
              <tr key={d.label}><td><b>{d.label}</b></td><td className="mono otp-secret">{detail(d.result) ?? 'sent to the driver by SMS'}</td></tr>
            ))}
          </tbody>
        </table>
      )}
      {result.failed.length > 0 && (
        <ul className="select-errors">
          {result.failed.map((f) => <li key={f.label}><b>{f.label}</b> — {f.error}</li>)}
        </ul>
      )}
      {note && <small>{note}</small>}
      <button type="button" className="mini-btn otp-dismiss" onClick={onDismiss}>Dismiss</button>
    </div>
  );
}

/** Navigate to another console page, optionally to a tab and customer inside it. */
export type OmcGo = (page: string, tab?: string, customer?: string) => void;

/** A secret the backend returns once (a code or a temporary password): shown until dismissed, never stored. */
export function OneTimeBox({ title, secretLabel, secret, note, onDismiss }: {
  title: string; secretLabel: string; secret: string | null; note?: string; onDismiss: () => void;
}) {
  return (
    <div className="otp-box" role="status">
      <strong>{title}</strong>
      {secret
        ? <span>{secretLabel}: <b className="mono otp-secret">{secret}</b></span>
        : <span>No code is shown here — it was delivered to the driver by SMS.</span>}
      {note && <small>{note}</small>}
      <small>{secret ? 'Shown once only — it cannot be retrieved again.' : ''}</small>
      <button type="button" className="mini-btn otp-dismiss" onClick={onDismiss}>Dismiss</button>
    </div>
  );
}

/** An inline "give a reason" form that replaces window.prompt. Errors from the backend are shown beside it. */
export function ReasonForm({ label, confirm, danger, onSubmit, onCancel }: {
  label: string; confirm: string; danger?: boolean; onSubmit: (reason: string) => Promise<void>; onCancel: () => void;
}) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  return (
    <form className="form-row inline-reason" onSubmit={async (e) => {
      e.preventDefault();
      setBusy(true);
      setError('');
      try {
        await onSubmit(reason.trim());
      } catch (err) {
        setError(errorText(err));
        setBusy(false);
      }
    }}>
      <label>{label}
        <input value={reason} onChange={(e) => setReason(e.target.value)} required maxLength={300} autoFocus />
      </label>
      <button type="submit" className={danger ? 'btn-ghost' : 'btn-ok'} disabled={busy || !reason.trim()}>{busy ? 'Working…' : confirm}</button>
      <button type="button" className="mini-btn" onClick={onCancel} disabled={busy}>Back</button>
      {error && <div className="error inline" style={{ flexBasis: '100%' }}>{error}</div>}
    </form>
  );
}

/** Status filter chips with counts, plus a free-text search box. */
export function FilterBar<K extends string>({ options, value, onChange, count, query, onQuery, placeholder }: {
  options: [K, string][]; value: K; onChange: (k: K) => void; count: (k: K) => number;
  query: string; onQuery: (q: string) => void; placeholder: string;
}) {
  return (
    <div className="filter-bar">
      <div className="filters">
        {options.map(([k, text]) => (
          <button key={k} type="button" className={value === k ? 'filter active' : 'filter'} onClick={() => onChange(k)}>
            {text} <b>{count(k)}</b>
          </button>
        ))}
      </div>
      <label className="search-box"><Ic n="search" s={13} />
        <input type="search" value={query} placeholder={placeholder} onChange={(e) => onQuery(e.target.value)} />
      </label>
    </div>
  );
}

export function Phase2({ title, intro, children }: { title: string; intro: string; children?: ReactNode }) {
  return (
    <section className="card phase2">
      <div className="card-head"><h2>{title}</h2><span className="chip chip-planned">Planned for Phase 2</span></div>
      <p className="phase2-intro">{intro}</p>
      {children}
    </section>
  );
}
