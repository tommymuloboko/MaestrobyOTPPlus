import { useCallback, useEffect, useRef, useState } from 'react';
import { exportSpec, type ExportFormat, type ExportSpec } from './exporter';
import { Ic } from './ui';

interface Props {
  /** Called when a format is chosen, so the export always reflects the data on screen at that moment. */
  build: () => ExportSpec;
  disabled?: boolean;
  label?: string;
}

const ITEMS: { format: ExportFormat; icon: string; label: string }[] = [
  { format: 'print', icon: 'print', label: 'Print' },
  { format: 'pdf', icon: 'pdf', label: 'PDF' },
  { format: 'xlsx', icon: 'sheet', label: 'Excel (.xlsx)' },
  { format: 'csv', icon: 'download', label: 'CSV' },
];

/** Print / PDF / Excel / CSV for the table beside it. */
export default function ExportMenu({ build, disabled, label = 'Export' }: Props) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<ExportFormat | null>(null);
  const [error, setError] = useState('');
  const [pos, setPos] = useState({ top: 0, right: 0 });
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);

  const close = useCallback(() => { setOpen(false); setError(''); }, []);

  const toggle = () => {
    if (open) return close();
    // fixed positioning: several cards scroll horizontally, which would clip an absolutely positioned menu
    const r = button.current?.getBoundingClientRect();
    if (r) setPos({ top: r.bottom + 6, right: Math.max(window.innerWidth - r.right, 8) });
    setOpen(true);
  };

  useEffect(() => {
    if (!open) return;
    menu.current?.querySelector<HTMLButtonElement>('button')?.focus();
    const onPointer = (e: PointerEvent) => {
      const t = e.target as Node;
      if (!menu.current?.contains(t) && !button.current?.contains(t)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { close(); button.current?.focus(); }
    };
    document.addEventListener('pointerdown', onPointer);
    document.addEventListener('keydown', onKey);
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    return () => {
      document.removeEventListener('pointerdown', onPointer);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
    };
  }, [open, close]);

  const choose = async (format: ExportFormat) => {
    setError('');
    setBusy(format);
    try {
      await exportSpec(build(), format);
      close();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'The export failed');
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <button ref={button} type="button" className="cta export-btn" disabled={disabled}
        aria-haspopup="menu" aria-expanded={open} onClick={toggle}>
        <Ic n="download" s={13} /> {label} <Ic n="chevron" s={12} />
      </button>
      {open && (
        <div ref={menu} className="export-pop" role="menu" style={{ top: pos.top, right: pos.right }}>
          {ITEMS.map((i) => (
            <button key={i.format} type="button" role="menuitem" disabled={busy !== null} onClick={() => void choose(i.format)}>
              <Ic n={i.icon} s={14} /> {busy === i.format ? 'Preparing…' : i.label}
            </button>
          ))}
          {error && <div className="export-err" role="alert">{error}</div>}
        </div>
      )}
    </>
  );
}
