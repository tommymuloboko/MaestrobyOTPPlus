import { useCallback, useEffect, useState } from 'react';
import { api, type StockLevel, type StockoutRow, type TankReading } from './api';
import ExportMenu from './ExportMenu';
import type { ExportSpec } from './exporter';
import { MOVEMENT_LABELS, levelAt, numberTanks, productColor, productName, tankEvents, tankKey, type TankEvent } from './tanks';
import { Notice, Select, num, useLoad, when } from './ui';

type RangeKey = '1h' | '24h' | '7d' | '30d' | 'all';
const RANGES: [RangeKey, string, number][] = [
  ['1h', 'Last hour', 3_600_000], ['24h', 'Last 24 hours', 86_400_000], ['7d', 'Last 7 days', 7 * 86_400_000],
  ['30d', 'Last 30 days', 30 * 86_400_000], ['all', 'All available', 0],
];
type ScaleKey = 'fit' | 'full';

// the movements endpoint returns the latest 100 across all tanks, so older history may be missing
const LEDGER_PAGE = 100;
const REFRESH_MS = 15000;

const DAY = 86_400_000;
const clockTime = (t: number) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const dayLabel = (t: number) => new Date(t).toLocaleDateString([], { day: 'numeric', month: 'short' });
const signed = (n: number) => `${n > 0 ? '+' : n < 0 ? '−' : ''}${num(Math.abs(n), 0)}`;

interface TankData {
  level: StockLevel;
  key: string;
  no: number;
  events: TankEvent[];
  opening: number;
  readings: { t: number; v: number }[];
  forecast: StockoutRow | undefined;
}

interface Domain { t0: number; t1: number }

/* ── the chart ────────────────────────────────────────────────── */
const W = 640, H = 236, PL = 62, PR = 14, PT = 12, PB = 28;

function TrendChart({ tank, domain, scale }: { tank: TankData; domain: Domain; scale: ScaleKey }) {
  const { t0, t1 } = domain;
  const { level, events, opening, readings } = tank;
  const current = Number(level.bookLitres);
  const inRange = events.filter((e) => e.at > t0 && e.at <= t1);
  const atg = readings.filter((r) => r.t >= t0 && r.t <= t1);

  // the step line: flat between movements, jumping at each one
  const points: [number, number][] = [[t0, levelAt(events, opening, t0)]];
  for (const e of inRange) points.push([e.at, e.after - e.litres], [e.at, e.after]);
  points.push([t1, current]);

  const values = [...points.map((p) => p[1]), ...atg.map((r) => r.v)];
  let yMin = 0;
  let yMax = Number(level.capacityLitres);
  if (scale === 'fit') {
    const lo = Math.min(...values);
    const hi = Math.max(...values);
    const pad = hi - lo > 0 ? (hi - lo) * 0.15 : Math.max(50, hi * 0.02);
    yMin = Math.max(0, lo - pad);
    yMax = hi + pad;
  }
  const x = (t: number) => PL + ((t - t0) / Math.max(t1 - t0, 1)) * (W - PL - PR);
  const y = (v: number) => PT + (1 - (v - yMin) / Math.max(yMax - yMin, 1)) * (H - PT - PB);
  const line = points.map(([t, v], i) => `${i ? 'L' : 'M'} ${x(t).toFixed(1)} ${y(v).toFixed(1)}`).join(' ');
  const area = `${line} L ${x(t1).toFixed(1)} ${y(yMin).toFixed(1)} L ${x(t0).toFixed(1)} ${y(yMin).toFixed(1)} Z`;

  const color = productColor(level.product);
  const reorder = Number(level.reorderLitres);
  const yTicks = Array.from({ length: 5 }, (_, i) => yMin + ((yMax - yMin) * i) / 4);
  const span = t1 - t0;
  const xTicks = Array.from({ length: 5 }, (_, i) => t0 + (span * i) / 4);
  const label = span <= 36 * 3_600_000 ? clockTime : dayLabel;
  const gradient = `trend-${tank.key.replace(/[^a-zA-Z0-9]/g, '')}`;

  return (
    <svg className="trend-svg" viewBox={`0 0 ${W} ${H}`} role="img"
      aria-label={`${productName(level.product)} level over time, now ${num(current, 0)} litres`}>
      <defs>
        <linearGradient id={gradient} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor={color} stopOpacity="0.35" /><stop offset="1" stopColor={color} stopOpacity="0.02" />
        </linearGradient>
      </defs>
      {yTicks.map((v) => (
        <g key={v}>
          <line x1={PL} x2={W - PR} y1={y(v)} y2={y(v)} className="trend-grid-line" />
          <text x={PL - 8} y={y(v) + 4} textAnchor="end" className="trend-axis">{num(v, 0)}</text>
        </g>
      ))}
      {xTicks.map((t, i) => (
        <text key={t} x={x(t)} y={H - 8} textAnchor={i === 0 ? 'start' : i === xTicks.length - 1 ? 'end' : 'middle'} className="trend-axis">{label(t)}</text>
      ))}
      {reorder >= yMin && reorder <= yMax && (
        <g>
          <line x1={PL} x2={W - PR} y1={y(reorder)} y2={y(reorder)} stroke="#d84c3e" strokeDasharray="5 4" />
          <text x={W - PR - 4} y={y(reorder) - 4} textAnchor="end" className="trend-axis trend-reorder">reorder {num(reorder, 0)} L</text>
        </g>
      )}
      <path d={area} fill={`url(#${gradient})`} />
      <path d={line} fill="none" stroke={color} strokeWidth="2" strokeLinejoin="round" />
      {atg.length > 0 && (
        <g>
          <polyline points={atg.map((r) => `${x(r.t).toFixed(1)},${y(r.v).toFixed(1)}`).join(' ')} fill="none" stroke="#2563eb" strokeWidth="1.5" strokeDasharray="4 3" />
          {atg.map((r) => (
            <circle key={r.t} cx={x(r.t)} cy={y(r.v)} r="2.6" fill="#2563eb"><title>{`${when(new Date(r.t).toISOString())} · ATG measured ${num(r.v, 0)} L`}</title></circle>
          ))}
        </g>
      )}
      {inRange.map((e) => {
        const kind = MOVEMENT_LABELS[e.kind]?.label ?? e.kind.toLowerCase();
        const incoming = e.kind === 'DELIVERY_IN';
        return (
          <circle key={e.id} cx={x(e.at)} cy={y(e.after)} r={incoming ? 5 : e.kind === 'DISPENSE' ? 3 : 4.5}
            fill={incoming ? '#1b9a3a' : e.kind === 'DISPENSE' ? '#1f2937' : '#f59e0b'} stroke="#fff" strokeWidth="1.2">
            <title>{`${when(new Date(e.at).toISOString())} · ${kind} ${signed(e.litres)} L · level ${num(e.after, 0)} L`}</title>
          </circle>
        );
      })}
    </svg>
  );
}

/* ── one tank's card: chart plus the figures behind it ───────── */
function TrendCard({ tank, domain, scale, site }: { tank: TankData; domain: Domain; scale: ScaleKey; site: string }) {
  const { level, events, opening, readings, forecast } = tank;
  const { t0, t1 } = domain;
  const inRange = events.filter((e) => e.at > t0 && e.at <= t1);
  const sum = (pick: (e: TankEvent) => boolean) => inRange.filter(pick).reduce((s, e) => s + e.litres, 0);
  const dispensed = -sum((e) => e.kind === 'DISPENSE');
  const received = sum((e) => e.kind === 'DELIVERY_IN');
  const other = sum((e) => e.kind !== 'DISPENSE' && e.kind !== 'DELIVERY_IN');
  const net = Number(level.bookLitres) - levelAt(events, opening, t0);
  const hasAtg = readings.some((r) => r.t >= t0 && r.t <= t1);

  return (
    <section className="card trend-card">
      <div className="card-head">
        <div>
          <h2>{productName(level.product)} <small className="muted">Tank {String(tank.no).padStart(2, '0')}</small></h2>
          <small className="muted">{site}</small>
        </div>
        {level.belowReorder
          ? <span className="chip chip-pending_approval">low level</span>
          : <span className="chip chip-authorized">{num(Number(level.percent), 0)}% full</span>}
      </div>
      <TrendChart tank={tank} domain={domain} scale={scale} />
      <div className="trend-legend">
        <span><i className="lg-line" style={{ background: productColor(level.product) }} />Book level</span>
        <span><i className="lg-dot" />Dispense</span>
        <span><i className="lg-dot in" />Delivery in</span>
        <span><i className="lg-dot adj" />Adjustment</span>
        {hasAtg && <span><i className="lg-dash" />ATG measured</span>}
      </div>
      <div className="trend-kpis">
        <div><b>{num(Number(level.bookLitres), 0)} L</b><small>now</small></div>
        <div><b className={net < 0 ? 'neg' : net > 0 ? 'pos' : ''}>{signed(net)} L</b><small>net change</small></div>
        <div><b>{num(dispensed, 0)} L</b><small>dispensed</small></div>
        <div><b>{num(received, 0)} L</b><small>received</small></div>
        {other !== 0 && <div><b>{signed(other)} L</b><small>adjustments</small></div>}
        <div>
          <b>{forecast?.daysOfCover != null ? `${num(Number(forecast.daysOfCover), 1)} days` : '—'}</b>
          <small>cover{forecast?.predictedStockout ? ` · empty ~${forecast.predictedStockout}` : ''}</small>
        </div>
        <div><b>{forecast ? `${num(Number(forecast.averageDailyLitres), 0)} L` : '—'}</b><small>avg / day (14 d)</small></div>
      </div>
      {forecast?.reorderNow && (
        <div className="notice-warn">Below the reorder level — a delivery of about <b>{num(Number(forecast.suggestedOrderLitres), 0)} L</b> would bring this tank to 90%.</div>
      )}
    </section>
  );
}

/* ── the Tank trends tab ─────────────────────────────────────── */
export default function TankTrends() {
  const fetchAll = useCallback(async () => {
    const [levels, movements, stockout, readings, sites] = await Promise.all([
      api.stock(), api.stockMovements(), api.stockout(),
      api.tankReadings().catch((): TankReading[] => []), api.listSites().catch(() => []),
    ]);
    return { levels, movements, stockout, readings, sites, loadedAt: Date.now() };
  }, []);
  const data = useLoad(fetchAll);
  const [tankPick, setTankPick] = useState('ALL');
  const [range, setRange] = useState<RangeKey>('24h');
  const [scale, setScale] = useState<ScaleKey>('fit');

  useEffect(() => {
    const t = setInterval(() => void data.reload(), REFRESH_MS);
    return () => clearInterval(t);
    // data.reload is a stable reference from useLoad
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data.reload]);

  if (data.loading) return <section className="card"><div className="empty">Loading tank trends…</div></section>;
  if (!data.data) return <Notice error={data.error} />;

  const { levels, movements, stockout, readings, sites, loadedAt } = data.data;
  const numbers = numberTanks(levels);
  const siteName = (code: string) => sites.find((s) => s.code === code)?.name ?? code;
  const tanks: TankData[] = levels.map((l) => {
    const key = tankKey(l.siteCode, l.product);
    const { events, opening } = tankEvents(Number(l.bookLitres), movements.filter((m) => m.siteCode === l.siteCode && m.product === l.product));
    return {
      level: l, key, no: numbers.get(key) ?? 1, events, opening,
      readings: readings.filter((r) => r.siteCode === l.siteCode && r.product === l.product)
        .map((r) => ({ t: Date.parse(r.at), v: Number(r.volumeLitres) })).sort((a, b) => a.t - b.t),
      forecast: stockout.find((s) => s.siteCode === l.siteCode && s.product === l.product),
    };
  });

  // when the ledger page is full, anything older than its oldest line is not known
  const oldest = movements.length ? Math.min(...movements.map((m) => Date.parse(m.at))) : loadedAt - DAY;
  const truncated = movements.length >= LEDGER_PAGE;
  const rangeMs = RANGES.find(([k]) => k === range)?.[2] ?? 0;
  const wanted = range === 'all' ? oldest - Math.min(3_600_000, Math.max(loadedAt - oldest, 60_000) * 0.05) : loadedAt - rangeMs;
  const domain: Domain = { t0: truncated ? Math.max(wanted, oldest) : wanted, t1: loadedAt };

  const shown = tankPick === 'ALL' ? tanks : tanks.filter((t) => t.key === tankPick);
  const tankOptions: [string, string][] = [['ALL', 'All tanks'],
    ...tanks.map((t): [string, string] => [t.key, `${productName(t.level.product)} · ${siteName(t.level.siteCode)} · Tank ${String(t.no).padStart(2, '0')}`])];

  const rows = shown.flatMap((t) => t.events.filter((e) => e.at > domain.t0 && e.at <= domain.t1).map((e) => ({ tank: t, e })))
    .sort((a, b) => b.e.at - a.e.at);
  const exportSpec = (): ExportSpec => ({
    title: 'Tank movements',
    subtitle: `${tankPick === 'ALL' ? 'All tanks' : tankOptions.find(([k]) => k === tankPick)?.[1]} · ${RANGES.find(([k]) => k === range)?.[1]} · ${rows.length} movements`,
    filename: 'tank-movements',
    columns: [
      { header: 'When', type: 'datetime' }, { header: 'Site' }, { header: 'Product' }, { header: 'Type' },
      { header: 'Litres', type: 'litres' }, { header: 'Level after (L)', type: 'litres' },
    ],
    rows: rows.map(({ tank, e }) => [new Date(e.at).toISOString(), siteName(tank.level.siteCode), productName(tank.level.product),
      MOVEMENT_LABELS[e.kind]?.label ?? e.kind.toLowerCase(), e.litres, e.after]),
  });

  return (
    <>
      <Notice error={data.error && data.data ? data.error : ''} />
      <section className="card">
        <div className="form-row trend-controls">
          <Select label="Tank" value={tankPick} onChange={setTankPick} options={tankOptions} />
          <Select label="Period" value={range} onChange={(v) => setRange(v as RangeKey)} options={RANGES.map(([k, text]): [string, string] => [k, text])} />
          <Select label="Level scale" value={scale} onChange={(v) => setScale(v as ScaleKey)}
            options={[['fit', 'Fit to the data'], ['full', 'Full tank (0 – capacity)']]} />
          <button type="button" className="mini-btn" onClick={() => void data.reload()}>Refresh</button>
        </div>
        <small className="muted">
          Levels are rebuilt from the stock ledger (every dispense, delivery and adjustment), so they match the book stock exactly. Updated {when(new Date(loadedAt).toISOString())}.
          {truncated && ` The ledger returns the latest ${LEDGER_PAGE} movements, so history before ${when(new Date(oldest).toISOString())} is not shown.`}
        </small>
      </section>

      <div className={shown.length === 1 ? 'trend-grid single' : 'trend-grid'}>
        {shown.map((t) => <TrendCard key={t.key} tank={t} domain={domain} scale={scale} site={siteName(t.level.siteCode)} />)}
        {shown.length === 0 && <section className="card"><div className="empty">No tanks configured.</div></section>}
      </div>

      <section className="card tbl-scroll" style={{ marginTop: '0.85rem' }}>
        <div className="card-head">
          <h2>Tank movements</h2>
          <div className="head-tools"><small className="muted">{rows.length} in this period</small><ExportMenu build={exportSpec} disabled={rows.length === 0} /></div>
        </div>
        <table>
          <thead><tr><th>When</th><th>Tank</th><th>Type</th><th>Litres</th><th>Level after</th></tr></thead>
          <tbody>
            {rows.length === 0 && <tr><td colSpan={5} className="empty">No stock movements in this period.</td></tr>}
            {rows.slice(0, 60).map(({ tank, e }) => {
              const kind = MOVEMENT_LABELS[e.kind];
              return (
                <tr key={e.id}>
                  <td>{when(new Date(e.at).toISOString())}</td>
                  <td><b>{productName(tank.level.product)}</b><br /><small>{siteName(tank.level.siteCode)} · Tank {String(tank.no).padStart(2, '0')}</small></td>
                  <td><span className={`chip ${kind?.chip ?? ''}`}>{kind?.label ?? e.kind.toLowerCase()}</span></td>
                  <td className={e.litres < 0 ? 'neg' : 'pos'}><b>{signed(e.litres)} L</b></td>
                  <td>{num(e.after, 0)} L</td>
                </tr>
              );
            })}
          </tbody>
        </table>
        {rows.length > 60 && <small className="muted">Showing the latest 60 of {rows.length}; export for the full list.</small>}
      </section>
    </>
  );
}
