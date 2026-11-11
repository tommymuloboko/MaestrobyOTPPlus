import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import {
  AlertTriangle, ArrowLeft, BarChart3, Bell, Building2, Calendar, Camera, CheckCircle2, ChevronDown, ClipboardList,
  Clock, Cpu, CreditCard, Download, Droplet, Fuel, FileBarChart, FilePlus2, FileSpreadsheet, FileText, Gauge,
  HelpCircle, Info, KeyRound, Landmark, Layers, LayoutGrid, MapPin, MessageSquare, Package, Pencil, Plug, Plus, Printer,
  Receipt, RefreshCw, Route, Scale, ScrollText, Search, Settings, Shield, ShieldAlert, ShieldCheck, Tag, Trash2,
  TrendingUp, Truck, Upload, User, UserCheck, Users, Wallet, Warehouse, Ban, Zap, Cylinder, Thermometer, Database,
  type LucideIcon,
} from 'lucide-react';

const ICONS: Record<string, LucideIcon> = {
  key: KeyRound,
  userCheck: UserCheck,
  warehouse: Warehouse,
  plug: Plug,
  edit: Pencil,
  refresh: RefreshCw,
  ban: Ban,
  tag: Tag,
  finance: Landmark,
  audit: ScrollText,
  device: Cpu,
  scale: Scale,
  camera: Camera,
  message: MessageSquare,
  sentinel: ShieldCheck,
  plus: Plus,
  back: ArrowLeft,
  bulk: Layers,
  newOrder: FilePlus2,
  settings: Settings,
  pin: MapPin,
  user: User,
  trash: Trash2,
  grid: LayoutGrid,
  truck: Truck,
  drop: Droplet,
  chart: BarChart3,
  users: Users,
  help: HelpCircle,
  card: CreditCard,
  shield: Shield,
  search: Search,
  calendar: Calendar,
  bell: Bell,
  chevron: ChevronDown,
  box: Package,
  clock: Clock,
  check: CheckCircle2,
  zap: Zap,
  orders: ClipboardList,
  route: Route,
  fuel: Fuel,
  tank: Cylinder,
  thermo: Thermometer,
  stack: Database,
  wallet: Wallet,
  supplier: Building2,
  alert: ShieldAlert,
  warn: AlertTriangle,
  info: Info,
  insights: TrendingUp,
  report: FileBarChart,
  receipt: Receipt,
  download: Download,
  print: Printer,
  pdf: FileText,
  upload: Upload,
  sheet: FileSpreadsheet,
  gauge: Gauge,
};

export function Ic({ n, s = 15 }: { n: string; s?: number }) {
  const Icon = ICONS[n] ?? Info;
  return <Icon size={s} strokeWidth={1.8} aria-hidden />;
}

export function StatusChip({ status }: { status: string }) {
  return (
    <span className={`chip chip-${status.toLowerCase()}`}>
      {status.replaceAll('_', ' ').toLowerCase()}
    </span>
  );
}

export { money } from './currency';
export const num = (n: number | null | undefined, digits = 1) =>
  n === null || n === undefined ? '—' : Number(n).toLocaleString(undefined, { maximumFractionDigits: digits });
export const when = (iso: string | null | undefined) => (iso ? new Date(iso).toLocaleString() : '—');
export const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function PageHead({ icon, title, sub, children }: { icon: string; title: string; sub: string; children?: ReactNode }) {
  return (
    <div className="page-head">
      <span className="page-ic"><Ic n={icon} s={20} /></span>
      <div><h2>{title}</h2><small>{sub}</small></div>
      {children && <div className="page-actions">{children}</div>}
    </div>
  );
}

export function StatStrip({ items }: { items: { icon: string; label: string; value: string; sub: string }[] }) {
  return (
    <section className="card ops">
      <div className="ops-grid">
        {items.map((i) => (
          <div className="stat" key={i.label}>
            <span className="stat-label"><Ic n={i.icon} s={13} /> {i.label}</span>
            <div className="stat-row"><strong>{i.value}</strong></div>
            <small>{i.sub}</small>
          </div>
        ))}
      </div>
    </section>
  );
}

export interface Loaded<T> { data: T | null; error: string; loading: boolean; reload: () => Promise<void> }

/** Loads once on mount and again on reload(); pass a stable function (an `api.*` method or a useCallback). */
export function useLoad<T>(fetcher: () => Promise<T>): Loaded<T> {
  const [state, setState] = useState<{ data: T | null; error: string; loading: boolean }>({ data: null, error: '', loading: true });
  const reload = useCallback(async () => {
    try {
      const data = await fetcher();
      setState({ data, error: '', loading: false });
    } catch (e) {
      setState((s) => ({ ...s, error: errorText(e), loading: false }));
    }
  }, [fetcher]);
  useEffect(() => { void reload(); }, [reload]);
  return { ...state, reload };
}

export function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [ok, setOk] = useState('');
  const run = async (fn: () => Promise<string | void>) => {
    setBusy(true);
    setError('');
    setOk('');
    try {
      const message = await fn();
      if (message) setOk(message);
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };
  const clear = () => {
    setError('');
    setOk('');
  };
  return { busy, error, ok, run, clear };
}

export function Notice({ error, ok }: { error?: string; ok?: string }) {
  if (!error && !ok) return null;
  return error ? <div className="error inline">{error}</div> : <div className="notice-ok">{ok}</div>;
}

export interface ToastMessage { id: number; title: string; detail?: string }

/** A popup that closes itself. Give it a new `id` for each message so the timer restarts. */
export function Toast({ toast, onClose }: { toast: ToastMessage; onClose: () => void }) {
  const close = useRef(onClose);
  useEffect(() => { close.current = onClose; });
  useEffect(() => {
    const timer = setTimeout(() => close.current(), 4500);
    return () => clearTimeout(timer);
  }, [toast.id]);
  return (
    <div className="toast" role="status" aria-live="polite">
      <span className="toast-ic"><CheckCircle2 size={20} /></span>
      <div className="toast-body">
        <b>{toast.title}</b>
        {toast.detail && <small>{toast.detail}</small>}
      </div>
      <button type="button" className="toast-close" aria-label="Dismiss" onClick={onClose}>×</button>
    </div>
  );
}

/** Table body rows for the loading / error / empty states of a table card. */
export function Rows<T>({ state, cols, empty, children }: {
  state: Loaded<T[]>; cols: number; empty: string; children: (rows: T[]) => ReactNode;
}) {
  if (state.loading) return <tr><td colSpan={cols} className="empty">Loading…</td></tr>;
  if (state.error && !state.data) return <tr><td colSpan={cols} className="empty err">{state.error}</td></tr>;
  if (!state.data || state.data.length === 0) return <tr><td colSpan={cols} className="empty">{empty}</td></tr>;
  return <>{children(state.data)}</>;
}

export function Field({ label, value, onChange, type = 'text', required, placeholder, step, min, max }: {
  label: string; value: string; onChange: (v: string) => void; type?: string; required?: boolean;
  placeholder?: string; step?: string; min?: string; max?: string;
}) {
  return (
    <label>{label}
      <input type={type} value={value} required={required} placeholder={placeholder} step={step} min={min} max={max}
        onChange={(e) => onChange(e.target.value)} />
    </label>
  );
}

export function Select({ label, value, onChange, options }: {
  label: string; value: string; onChange: (v: string) => void; options: (string | [string, string])[];
}) {
  return (
    <label>{label}
      <select value={value} onChange={(e) => onChange(e.target.value)}>
        {options.map((o) => {
          const [v, text] = typeof o === 'string' ? [o, o] : o;
          return <option key={v} value={v}>{text}</option>;
        })}
      </select>
    </label>
  );
}

export function Tabs<K extends string>({ tabs, value, onChange }: { tabs: [K, string][]; value: K; onChange: (k: K) => void }) {
  return (
    <div className="filters">
      {tabs.map(([k, label]) => (
        <button key={k} type="button" className={value === k ? 'filter active' : 'filter'} onClick={() => onChange(k)}>{label}</button>
      ))}
    </div>
  );
}
