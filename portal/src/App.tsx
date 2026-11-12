import { useCallback, useEffect, useState, type CSSProperties } from 'react';
import {
  api,
  sessionStore,
  setUnauthorizedHandler,
  type Branding,
  type DashboardKpis,
  type Driver,
  type FuelOrder,
  type FuelTransaction,
  type OtpResponse,
  type Receipt,
  type Session,
  type Site,
  type ValidateResponse,
  type Vehicle,
} from './api';
import Login from './Login';
import CustomerPages from './CustomerPages';
import Deliveries from './DeliveryPages';
import FleetPages from './FleetPages';
import OrderPages from './OrderPages';
import StaffPages, { Messages, STAFF_NAV, staffPageAllowed } from './StaffPages';
import { LiveTanks } from './Pts2Pages';
import { CUSTOMER_ROLE, OMC_ROLE, buildAlerts, isOmcRole } from './customerData';
import OmcConsole, { OMC_HOME, OMC_NAV } from './OmcConsole';
import { loadCurrencies, money, moneyFor } from './currency';
import { Ic, StatusChip, num } from './ui';
import './App.css';

/* ── chart: real hourly cumulative data ──────────────────── */
interface ChartPoint { label: string; dispensed: number; ordered: number }

function buildHourly(orders: FuelOrder[], transactions: FuelTransaction[]): ChartPoint[] {
  const now = new Date();
  const endHour = Math.max(18, now.getHours() + (now.getHours() % 2 === 0 ? 2 : 1));
  const points: ChartPoint[] = [];
  for (let h = 6; h <= endHour; h += 2) {
    const boundary = new Date(now);
    boundary.setHours(h, 0, 0, 0);
    points.push({
      label: `${String(h).padStart(2, '0')}:00`,
      dispensed: transactions
        .filter((t) => new Date(t.dispensedAt) <= boundary)
        .reduce((s, t) => s + Number(t.volumeLitres), 0),
      ordered: orders
        .filter((o) => new Date(o.createdAt) <= boundary)
        .reduce((s, o) => s + Number(o.quantityLitres), 0),
    });
  }
  return points;
}

function LineChart({ data }: { data: ChartPoint[] }) {
  const W = 560, H = 210, PL = 42, PB = 24, PT = 12;
  const rawMax = Math.max(60, ...data.map((p) => Math.max(p.dispensed, p.ordered)));
  const step = rawMax > 400 ? 100 : rawMax > 160 ? 50 : 20;
  const max = Math.ceil((rawMax * 1.15) / step) * step;
  const x = (i: number) => PL + (i * (W - PL - 10)) / Math.max(data.length - 1, 1);
  const y = (v: number) => PT + (H - PT - PB) * (1 - v / max);
  const pts = (sel: (p: ChartPoint) => number) =>
    data.map((p, i) => `${x(i)},${y(sel(p))}`).join(' ');
  const gridVals = [0, 0.25, 0.5, 0.75, 1].map((f) => Math.round(max * f));

  const now = new Date();
  let cur = 0;
  data.forEach((p, i) => {
    if (Number(p.label.slice(0, 2)) <= now.getHours()) cur = i;
  });
  const tipLeftPct = Math.min((cur / Math.max(data.length - 1, 1)) * 82, 62);

  return (
    <div className="chart-wrap">
      <svg viewBox={`0 0 ${W} ${H}`} className="chart">
        {gridVals.map((g) => (
          <g key={g}>
            <line x1={PL} x2={W - 8} y1={y(g)} y2={y(g)} className="gridline" />
            <text x={PL - 8} y={y(g) + 3} className="axis" textAnchor="end">{g}</text>
          </g>
        ))}
        <polyline points={pts((p) => p.ordered)} className="line-b" />
        <polyline points={pts((p) => p.dispensed)} className="line-a" />
        {data.map((p, i) => <circle key={`b${i}`} cx={x(i)} cy={y(p.ordered)} r="3" className="dot-b" />)}
        {data.map((p, i) => <circle key={`a${i}`} cx={x(i)} cy={y(p.dispensed)} r="3" className="dot-a" />)}
        <line x1={x(cur)} x2={x(cur)} y1={PT} y2={H - PB} className="cursor-line" />
        {data.map((p, i) => (
          <text key={p.label} x={x(i)} y={H - 6} className="axis" textAnchor="middle">{p.label}</text>
        ))}
      </svg>
      <div className="chart-tip" style={{ left: `${tipLeftPct}%` }}>
        <strong>Today · {data[cur]?.label}</strong>
        <span><i className="dot g" /> Dispensed <b>{data[cur]?.dispensed.toFixed(1)} L</b></span>
        <span><i className="dot d" /> Ordered <b>{data[cur]?.ordered.toFixed(1)} L</b></span>
      </div>
    </div>
  );
}

/* ── donut from live order statuses ──────────────────────── */
const DONUT_COLORS: Record<string, string> = {
  AUTHORIZED: '#2db94d',
  FULFILLED: '#1a1d1f',
  PENDING_APPROVAL: '#c7ecd0',
  REJECTED: '#ff6a55',
};
const DONUT_LABELS: Record<string, string> = {
  AUTHORIZED: 'Authorized',
  FULFILLED: 'Fulfilled',
  PENDING_APPROVAL: 'Waiting',
  REJECTED: 'Rejected',
};

function Donut({ orders }: { orders: FuelOrder[] }) {
  const keys = Object.keys(DONUT_COLORS);
  const counts = keys.map((k) => orders.filter((o) => o.status === k).length);
  const total = counts.reduce((a, b) => a + b, 0);
  let acc = 0;
  const stops = total
    ? keys.map((k, i) => {
        const from = (acc / total) * 360;
        acc += counts[i];
        const to = (acc / total) * 360;
        return `${DONUT_COLORS[k]} ${from}deg ${to}deg`;
      }).join(', ')
    : '#eceef0 0deg 360deg';
  return (
    <>
      <div className="donut" style={{ background: `conic-gradient(${stops})` }}>
        <div className="donut-hole">
          <strong>{total}</strong>
          <small>Total orders</small>
        </div>
      </div>
      <div className="donut-legend">
        {keys.map((k, i) => (
          <div key={k}>
            <span className="dot" style={{ background: DONUT_COLORS[k] }} />
            <div>
              <small>{DONUT_LABELS[k]}</small>
              <strong>{total ? Math.round((counts[i] / total) * 100) : 0}% · {counts[i]}</strong>
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

function Spark() {
  const bars = [60, 80, 45, 90, 70, 100, 55];
  return (
    <div className="spark">
      {bars.map((b, i) => <i key={i} style={{ height: `${b}%` }} />)}
    </div>
  );
}

/* ── static demo data for non-core pages ─────────────────── */
const CUSTOMERS = [
  { name: 'Acme Logistics', price: 21.45, terms: 'NET 30', credit: 250000 },
  { name: 'BuildCo Mining', price: 20.9, terms: 'NET 7', credit: 500000 },
  { name: 'Walk-in (list price)', price: 22.3, terms: 'PREPAID', credit: 0 },
];

const ROLES = [
  { code: 'ORG_ADMIN', scope: 'Organization', desc: 'Manages branches, users, vehicles, budgets' },
  { code: 'FLEET_MANAGER', scope: 'Organization', desc: 'Vehicles, drivers, fuel limits, order approvals' },
  { code: 'DRIVER', scope: 'Organization', desc: 'Requests fuel, redeems OTP at pump' },
  { code: 'ATTENDANT', scope: 'Site', desc: 'Validates OTP, operates pump, captures signatures' },
  { code: 'STATION_MANAGER', scope: 'Site', desc: 'Station oversight: pumps, tanks, shifts' },
  { code: 'DEPOT_MANAGER', scope: 'Site', desc: 'Depot stock, loading bays, schedules' },
  { code: 'FINANCE', scope: 'Organization', desc: 'Pricing (four-eyes), billing, reconciliation' },
  { code: 'PLATFORM_ADMIN', scope: 'Platform', desc: 'Platform administration' },
];

const PAGES: Record<string, string> = {
  dashboard: 'Dashboard',
  vehicles: 'Fleet · All vehicles',
  drivers: 'Fleet · Drivers directory',
  limits: 'Fleet · Fuel limits',
  orders: 'Orders & dispensing',
  deliveries: 'Deliveries',
  wetstock: 'Wetstock',
  analytics: 'Analytics & reports',
  customers: 'Customers',
  team: 'Team & roles',
  helpdesk: 'Help & support',
};

const CUSTOMER_PAGES: Record<string, string> = {
  dashboard: 'Dashboard',
  'new-order': 'New order',
  'bulk-order': 'Bulk order',
  'my-orders': 'My orders',
  deliveries: 'Deliveries',
  messages: 'Notifications',
  drivers: 'Drivers',
  vehicles: 'Vehicles',
  trips: 'Trips & Routes',
  allocations: 'Fuel Allocations',
  balance: 'My balance',
  suppliers: 'Fuel Suppliers',
  fraud: 'Fraud & Alerts',
  insights: 'Smart Insights',
  reports: 'Reports',
  invoices: 'Invoices & Payments',
  settings: 'Settings',
  helpdesk: 'Help & support',
};
const CUSTOMER_ONLY_PAGES = ['trips', 'allocations', 'balance', 'suppliers', 'fraud', 'insights', 'reports', 'invoices', 'settings'];
const ORDER_PAGES = ['new-order', 'bulk-order', 'my-orders'];

/* ── main ────────────────────────────────────────────────── */
function Portal({ user, onLogout }: { user: Session; onLogout: () => void }) {
  const isCustomer = user.role === CUSTOMER_ROLE;
  const isOmc = isOmcRole(user.role);
  const canApprove = user.role === 'Station Manager' || user.role === 'Platform Admin' || user.role === OMC_ROLE;
  const canDispense = canApprove || user.role === 'Attendant';

  const home = isOmc ? OMC_HOME : 'dashboard';
  const [page, setPage] = useState(home);
  const [loaded, setLoaded] = useState(false);
  const [currenciesReady, setCurrenciesReady] = useState(false);
  const [orders, setOrders] = useState<FuelOrder[]>([]);
  const [transactions, setTransactions] = useState<FuelTransaction[]>([]);
  const [sites, setSites] = useState<Site[]>([]);
  const [fleetVehicles, setFleetVehicles] = useState<Vehicle[]>([]);
  const [fleetDrivers, setFleetDrivers] = useState<Driver[]>([]);
  const [error, setError] = useState('');
  const [issuedOtp, setIssuedOtp] = useState<OtpResponse | null>(null);
  const [dash, setDash] = useState<DashboardKpis | null>(null);
  const [brand, setBrand] = useState<Branding | null>(null);

  const [customer, setCustomer] = useState(isCustomer ? user.organization : 'Acme Logistics');
  const [siteCode, setSiteCode] = useState('SITE-JHB-001');
  const [product, setProduct] = useState('DIESEL_50');
  const [qty, setQty] = useState('60');
  const [vehicle, setVehicle] = useState('CA 123-456');
  const [driver, setDriver] = useState('S. Dlamini');

  const [otp, setOtp] = useState('');
  const [pin, setPin] = useState('');
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const [validated, setValidated] = useState<ValidateResponse | null>(null);
  const [volume, setVolume] = useState('');

  const refresh = useCallback(async () => {
    try {
      const [o, t, v, d, k] = await Promise.all([
        api.listOrders(), api.listTransactions(), api.listVehicles(), api.listDrivers(),
        isCustomer ? Promise.resolve(null) : api.dashboard().catch(() => null),
      ]);
      setOrders(o);
      setTransactions(t);
      setFleetVehicles(v);
      setFleetDrivers(d);
      setDash(k);
      setLoaded(true);
    } catch (e) {
      setError(String(e));
    }
  }, [isCustomer]);

  useEffect(() => {
    api.listSites().then(setSites).catch(() => undefined);
  }, []);

  // Amounts are formatted from this lookup, so pages wait for it rather than flashing the wrong currency.
  useEffect(() => {
    void loadCurrencies(user.organization).then(() => setCurrenciesReady(true));
  }, [user.organization]);

  useEffect(() => {
    if (!isCustomer) return;
    api.branding().then(setBrand).catch(() => undefined);
  }, [isCustomer]);

  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, 4000);
    return () => clearInterval(timer);
  }, [refresh]);

  const run = async (fn: () => Promise<void>) => {
    setError('');
    try {
      await fn();
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const litres = transactions.reduce((s, t) => s + Number(t.volumeLitres), 0);
  const revenue = transactions.reduce((s, t) => s + Number(t.amount), 0);
  const pending = orders.filter((o) => o.status === 'PENDING_APPROVAL').length;
  const fulfilled = orders.filter((o) => o.status === 'FULFILLED').length;
  const rate = orders.length ? Math.round((fulfilled / orders.length) * 100) : 0;
  const alertCount = isCustomer ? buildAlerts(orders, transactions).length : 0;
  const receiptCustomer = receipt ? orders.find((o) => o.number === receipt.orderNumber)?.customerName : undefined;
  const now = new Date();

  const litresFor = (reg: string) =>
    transactions.filter((t) => t.vehicleReg === reg).reduce((s, t) => s + Number(t.volumeLitres), 0);

  const navItem = (key: string, icon: string, label: string, badge?: number) => (
    <a key={key} className={page === key ? 'nav-item active' : 'nav-item'} onClick={() => setPage(key)}>
      <Ic n={icon} /> {label}
      {badge !== undefined && badge > 0 && <span className="badge">{badge}</span>}
    </a>
  );
  const navSub = (key: string, label: string, badge?: number) => (
    <a key={key} className={page === key ? 'nav-sub active' : 'nav-sub'} onClick={() => setPage(key)}>
      {label}
      {badge !== undefined && badge > 0 && <span className="badge">{badge}</span>}
    </a>
  );

  /* ── reusable cards ── */
  const orderFormCard = (
    <section className="card" id="order-form">
      <div className="card-head"><h2>New fuel order</h2><small className="muted">Customer workspace</small></div>
      <form onSubmit={(e) => {
        e.preventDefault();
        run(async () => {
          await api.createOrder({
            customerName: customer, siteCode, fuelProduct: product,
            quantityLitres: Number(qty), vehicleReg: vehicle, driverName: driver,
            costCentre: 'CC-100',
          });
        });
      }}>
        {!isCustomer && (
          <label>Customer
            <select value={customer} onChange={(e) => setCustomer(e.target.value)}>
              <option>Acme Logistics</option>
              <option>BuildCo Mining</option>
              <option>Walk-in (list price)</option>
            </select>
          </label>
        )}
        <label>Station
          <select value={siteCode} onChange={(e) => setSiteCode(e.target.value)}>
            {sites.map((s) => <option key={s.code} value={s.code}>{s.name} ({s.code})</option>)}
          </select>
        </label>
        <div className="row2">
          <label>Product
            <select value={product} onChange={(e) => setProduct(e.target.value)}>
              <option>DIESEL_50</option><option>ULP_93</option><option>ULP_95</option>
            </select>
          </label>
          <label>Litres
            <input type="number" value={qty} onChange={(e) => setQty(e.target.value)} />
          </label>
        </div>
        <div className="row2">
          <label>Vehicle
            <input value={vehicle} onChange={(e) => setVehicle(e.target.value)} />
          </label>
          <label>Driver
            <input value={driver} onChange={(e) => setDriver(e.target.value)} />
          </label>
        </div>
        <button type="submit" className="cta green wide">Submit order</button>
      </form>
    </section>
  );

  const attendantCard = (
    <section className="card">
      <div className="card-head"><h2>Attendant terminal</h2><small className="muted">OTP &amp; dispense</small></div>
      <div className="attendant">
        <label>OTP
          <input value={otp} maxLength={6} inputMode="numeric" placeholder="6-digit code"
            onChange={(e) => { setOtp(e.target.value.replace(/\D/g, '')); setValidated(null); }} />
        </label>
        <label>Driver PIN
          <input type="password" value={pin} maxLength={4} inputMode="numeric" placeholder="4-digit PIN"
            autoComplete="off" onChange={(e) => { setPin(e.target.value.replace(/\D/g, '')); setValidated(null); }} />
        </label>
        <button className="cta" disabled={otp.length !== 6 || pin.length !== 4} onClick={() => run(async () => {
          const v = await api.validateOtp(otp, pin);
          setValidated(v);
          setVolume(String(v.maxVolumeLitres));
        })}>Validate</button>
      </div>
      {validated && (
        <div className="validated">
          <p>
            <b>{validated.orderNumber}</b> — {validated.driverName} · {validated.vehicleReg}<br />
            {validated.fuelProduct} · max <strong>{validated.maxVolumeLitres} L</strong><br />
            <small>{validated.siteName}</small>
          </p>
          <label>Dispensed litres
            <input type="number" value={volume} onChange={(e) => setVolume(e.target.value)} />
          </label>
          <button className="btn-ok" onClick={() => run(async () => {
            const tx = await api.completeDispense(otp, pin, Number(volume));
            setReceipt(await api.receipt(tx.id));
            setValidated(null);
            setOtp('');
            setPin('');
          })}>Complete dispense</button>
        </div>
      )}
      {receipt && (
        <div className="receipt">
          <b>Receipt {receipt.receiptNo}</b>
          <span>{receipt.orderNumber} · {receipt.vehicleReg} · {receipt.driverName}</span>
          <span>{receipt.litres} L at {moneyFor(receipt.unitPrice, receiptCustomer)} = <b>{moneyFor(receipt.amount, receiptCustomer)}</b></span>
          <small>{receipt.siteName} · {new Date(receipt.at).toLocaleString()} · {receipt.attendantName}</small>
          <button className="btn-ghost" onClick={() => setReceipt(null)}>Dismiss</button>
        </div>
      )}
    </section>
  );

  const quickActionsCard = (
    <section className="card">
      <div className="card-head"><h2>Quick actions</h2><small className="muted">Fuel your fleet</small></div>
      <div className="quick-actions">
        <button onClick={() => setPage('new-order')}><span className="page-ic"><Ic n="newOrder" s={18} /></span><b>New order</b><small>Fuel one vehicle</small></button>
        <button onClick={() => setPage('bulk-order')}><span className="page-ic"><Ic n="bulk" s={18} /></span><b>Bulk order</b><small>Split across several trucks</small></button>
        <button onClick={() => setPage('vehicles')}><span className="page-ic"><Ic n="truck" s={18} /></span><b>Vehicles</b><small>Manage your fleet</small></button>
        <button onClick={() => setPage('drivers')}><span className="page-ic"><Ic n="users" s={18} /></span><b>Drivers</b><small>Manage your drivers</small></button>
      </div>
    </section>
  );

  const transactionsCard = (
    <section className="card">
      <div className="card-head"><h2>Fuel transactions</h2><small className="muted">Immutable record</small></div>
      <table>
        <thead>
          <tr><th>Vehicle</th><th>Litres</th><th>Amount</th><th>When</th></tr>
        </thead>
        <tbody>
          {transactions.slice(0, 8).map((t) => (
            <tr key={t.id}>
              <td><b>{t.vehicleReg}</b><br /><small>{t.driverName}</small></td>
              <td>{t.volumeLitres}</td>
              <td>{t.amount.toFixed(2)}</td>
              <td>{new Date(t.dispensedAt).toLocaleTimeString()}</td>
            </tr>
          ))}
          {transactions.length === 0 && (
            <tr><td colSpan={4} className="empty">No transactions yet.</td></tr>
          )}
        </tbody>
      </table>
    </section>
  );

  const activeOrdersCard = (title = 'Active orders', list = orders.slice(0, 4)) => (
    <section className="card">
      <div className="card-head"><h2>{title}</h2><b className="dots">⋮</b></div>
      {issuedOtp && (
        <div className="otp-box">
          <strong>OTP {issuedOtp.orderNumber}: {issuedOtp.otp}</strong>
          <small>{issuedOtp.note}</small>
        </div>
      )}
      <div className="fleet-list">
        {list.map((o) => (
          <div className="fleet-row" key={o.id}>
            <div className="fleet-top">
              <span className="fleet-id">{o.number} <small>· {o.quantityLitres} L {o.fuelProduct}</small></span>
              <StatusChip status={o.status} />
            </div>
            <div className="fleet-mid">
              <span className="truck-ic"><Ic n="truck" s={20} /></span>
              <div className="route">
                <span className="route-end"><b>{o.vehicleReg}</b><small>{o.driverName}</small></span>
                <div className="route-bar"><i style={{ width: o.status === 'FULFILLED' ? '100%' : o.status === 'AUTHORIZED' ? '55%' : '15%' }} /><em /></div>
                <span className="route-end right"><b>{o.siteName.split(' ')[0]}</b><small>{o.customerName}</small></span>
              </div>
            </div>
            {canApprove && o.status === 'PENDING_APPROVAL' && (
              <div className="fleet-actions">
                <button className="btn-ok" onClick={() => run(async () => setIssuedOtp(await api.approve(o.id)))}>Approve</button>
                <button className="btn-ghost" onClick={() => {
                  const reason = prompt('Rejection reason?') ?? 'No reason given';
                  run(async () => { await api.reject(o.id, reason); });
                }}>Reject</button>
              </div>
            )}
            {o.rejectionReason && <small className="reason">{o.rejectionReason}</small>}
          </div>
        ))}
        {list.length === 0 && <div className="empty">Nothing here yet.</div>}
      </div>
    </section>
  );

  const chartCard = (
    <section className="card">
      <div className="card-head">
        <h2>Dispensing performance</h2>
        <span className="pill sm">Daily <Ic n="chevron" s={11} /></span>
      </div>
      <div className="seg">
        <span className="seg-item active"><i className="dot g" /> Dispensed</span>
        <span className="seg-item"><i className="dot d" /> Ordered</span>
      </div>
      <LineChart data={buildHourly(orders, transactions)} />
    </section>
  );

  const mapCard = (
    <section className="card">
      <div className="card-head">
        <h2>Delivery map</h2>
        <span className="pill sm"><Ic n="search" s={11} /> Search for fleet</span>
      </div>
      <div className="map">
        <span className="hub" style={{ left: '14%', top: '58%' }}>Mainline Hub</span>
        <span className="hub" style={{ left: '52%', top: '40%' }}>Depot North</span>
        <span className="hub" style={{ left: '76%', top: '66%' }}>Depot East</span>
        <span className="trk" style={{ left: '8%', top: '22%' }}><i className="dot g" /> TRC-042</span>
        <span className="trk" style={{ left: '38%', top: '14%' }}><i className="dot o" /> TRC-017</span>
        <span className="trk" style={{ left: '66%', top: '26%' }}><i className="dot g" /> CA 123-456</span>
        <span className="trk" style={{ left: '44%', top: '68%' }}><i className="dot k" /> TRC-008</span>
        <div className="map-legend">
          <span><i className="dot g" /> In transit</span>
          <span><i className="dot o" /> Pick-up</span>
          <span><i className="dot k" /> Stationary</span>
          <span><i className="dot r" /> Delayed</span>
        </div>
      </div>
    </section>
  );

  const loadingCard = (
    <section className="card">
      <div className="card-head"><h2>Current loading status</h2><b className="dots">⋮</b></div>
      <div className="load-grid">
        <div className="load-stat"><strong>{String(dash?.ordersPending ?? pending).padStart(2, '0')}</strong><small>Orders being reviewed</small><Spark /></div>
        <div className="load-stat"><strong>{rate}%</strong><small>Fulfilment rate</small><Spark /></div>
        <div className="load-stat"><strong>{(dash?.litresToday ?? litres).toFixed(1)} L</strong><small>{dash ? 'Volume today' : 'Total volume'}</small><Spark /></div>
        <div className="load-stat"><strong>{money(dash?.salesToday ?? revenue)}</strong><small>{dash ? 'Sales today' : 'Total sales'}</small><Spark /></div>
      </div>
    </section>
  );

  const donutCard = (
    <section className="card">
      <div className="card-head"><h2>Order status</h2><b className="dots">⋮</b></div>
      <Donut orders={orders} />
    </section>
  );

  /* ── pages ── */
  const reload = async () => { await refresh(); };

  const renderPage = () => {
    if (isOmc && page.startsWith('omc-')) {
      return (
        <OmcConsole page={page} user={user} sites={sites} orders={orders} vehicles={fleetVehicles} drivers={fleetDrivers}
          transactions={transactions} loaded={loaded} reload={reload} reloadSites={async () => { setSites(await api.listSites()); }} go={setPage} />
      );
    }
    if (ORDER_PAGES.includes(page)) {
      return (
        <OrderPages page={page} user={user} sites={sites} vehicles={fleetVehicles} drivers={fleetDrivers}
          orders={orders} go={setPage} reload={reload} />
      );
    }
    if (page === 'vehicles' || page === 'drivers') {
      return (
        <FleetPages page={page} user={user} vehicles={fleetVehicles} drivers={fleetDrivers}
          orders={orders} transactions={transactions} reload={reload} />
      );
    }
    if (isCustomer && page === 'deliveries') return <Deliveries user={user} sites={sites} />;
    if (isCustomer && page === 'messages') return <Messages />;
    if (isCustomer && CUSTOMER_ONLY_PAGES.includes(page)) {
      return (
        <CustomerPages page={page} user={user} orders={orders} transactions={transactions}
          mapCard={mapCard} chartCard={chartCard} onLogout={onLogout} />
      );
    }
    if (!isCustomer && staffPageAllowed(page, user.role)) {
      return <StaffPages page={page} user={user} sites={sites} />;
    }
    switch (page) {
      case 'limits':
        return (
          <section className="card">
            <div className="card-head"><h2>Fuel limits</h2><small className="muted">Enforced at order + authorization time</small></div>
            <table>
              <thead><tr><th>Scope</th><th>Period</th><th>Limit</th><th>Used</th><th>Usage</th></tr></thead>
              <tbody>
                {[
                  { scope: 'Vehicle · CA 123-456', period: 'DAY', max: 120, used: litresFor('CA 123-456') },
                  { scope: 'Driver · S. Dlamini', period: 'WEEK', max: 400, used: litres },
                  { scope: 'Department · Logistics', period: 'MONTH', max: 5000, used: litres },
                ].map((l) => (
                  <tr key={l.scope}>
                    <td><b>{l.scope}</b></td>
                    <td>{l.period}</td>
                    <td>{l.max} L</td>
                    <td>{l.used.toFixed(1)} L</td>
                    <td>
                      <div className="usage-bar">
                        <i style={{ width: `${Math.min((l.used / l.max) * 100, 100)}%` }}
                          className={l.used / l.max > 0.8 ? 'hot' : ''} />
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        );
      case 'orders':
        return (
          <>
            <div className="row-3">
              {orderFormCard}
              {activeOrdersCard(isCustomer ? 'My fuel orders' : 'Supplier review inbox', orders)}
              {canDispense && attendantCard}
            </div>
            <div className="row-2">
              {transactionsCard}
              {donutCard}
            </div>
          </>
        );
      case 'wetstock':
        return (
          <>
            <LiveTanks />
            <div className="row-2">
              {chartCard}
              {loadingCard}
            </div>
          </>
        );
      case 'analytics':
        return (
          <>
            <div className="row-2">
              {chartCard}
              {donutCard}
            </div>
            <div className="row-2">
              {loadingCard}
              {transactionsCard}
            </div>
          </>
        );
      case 'customers':
        return (
          <section className="card">
            <div className="card-head"><h2>Customers</h2><small className="muted">Independent pricing per contract</small></div>
            <table>
              <thead><tr><th>Customer</th><th>Contract price (DIESEL_50)</th><th>Terms</th><th>Credit limit</th><th>Orders</th><th>Litres</th><th>Revenue</th></tr></thead>
              <tbody>
                {CUSTOMERS.map((c) => {
                  const cOrders = orders.filter((o) => o.customerName === c.name);
                  const cTx = transactions.filter((t) => cOrders.some((o) => o.vehicleReg === t.vehicleReg));
                  return (
                    <tr key={c.name}>
                      <td><b>{c.name}</b></td>
                      <td>{moneyFor(c.price, c.name)} / L</td>
                      <td>{c.terms}</td>
                      <td>{c.credit ? moneyFor(c.credit, c.name) : '—'}</td>
                      <td>{cOrders.length}</td>
                      <td>{cTx.reduce((s, t) => s + Number(t.volumeLitres), 0).toFixed(1)}</td>
                      <td>{moneyFor(cTx.reduce((s, t) => s + Number(t.amount), 0), c.name)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </section>
        );
      case 'team':
        return (
          <section className="card">
            <div className="card-head"><h2>Team &amp; roles</h2><small className="muted">Scoped RBAC</small></div>
            <table>
              <thead><tr><th>Role</th><th>Scope</th><th>Responsibilities</th></tr></thead>
              <tbody>
                {ROLES.map((r) => (
                  <tr key={r.code}>
                    <td><b>{r.code}</b></td>
                    <td><span className="chip chip-authorized">{r.scope}</span></td>
                    <td>{r.desc}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        );
      case 'helpdesk':
        return (
          <section className="card">
            <div className="card-head"><h2>Help &amp; support</h2></div>
            <p className="help-text">
              This is the Maestro FuelOrder™ walking skeleton. The full architecture lives in the
              <b> docs/</b> folder of this workspace: system overview, architecture, data model, API design,
              core workflows, Maestro Sentinel™ security &amp; fraud, infrastructure and the delivery roadmap.
            </p>
            <p className="help-text">
              Core flow to demo: <b>New fuel order → Approve (OTP issued) → Attendant terminal: validate OTP →
              Complete dispense</b>. Rejected orders never generate an OTP; redeemed OTPs are never reusable.
            </p>
          </section>
        );
      default:
        return (
          <>
            <section className="card ops">
              <div className="ops-head">
                <h2>Operations overview</h2>
                <small>Last updated: Today, {now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} <b>⋮</b></small>
              </div>
              <div className="ops-grid">
                <div className="stat">
                  <span className="stat-label"><Ic n="box" s={13} /> Total orders</span>
                  <div className="stat-row"><strong>{orders.length}</strong></div>
                  <small>From all channels</small>
                </div>
                <div className="stat">
                  <span className="stat-label"><Ic n="drop" s={13} /> {dash ? 'Litres dispensed today' : 'Litres dispensed'}</span>
                  <div className="stat-row"><strong>{num(dash?.litresToday ?? litres)}</strong></div>
                  <small>{dash ? `${dash.dispensesToday} dispenses today` : 'Across all sites'}</small>
                </div>
                <div className="stat">
                  <span className="stat-label"><Ic n="clock" s={13} /> Awaiting approval</span>
                  <div className="stat-row"><strong>{dash?.ordersPending ?? pending}</strong></div>
                  <small>Supplier inbox</small>
                </div>
                {dash ? (
                  <div className="stat">
                    <span className="stat-label"><Ic n="alert" s={13} /> Open risk events</span>
                    <div className="stat-row"><strong>{dash.openRiskEvents}</strong>{dash.criticalRiskEvents > 0 && <span className="delta down">{dash.criticalRiskEvents} critical</span>}</div>
                    <small>{dash.tanksBelowReorder} tank(s) below reorder · {dash.openVarianceExceptions} variance exception(s)</small>
                  </div>
                ) : (
                  <div className="stat">
                    <span className="stat-label"><Ic n="check" s={13} /> Fulfilment rate</span>
                    <div className="stat-row"><strong>{rate}%</strong></div>
                    <small>Orders completed</small>
                  </div>
                )}
              </div>
            </section>

            <div className="row-2">
              {chartCard}
              {mapCard}
            </div>

            <div className="row-3">
              {activeOrdersCard()}
              {loadingCard}
              {donutCard}
            </div>

            <div className="row-3">
              {isCustomer ? quickActionsCard : orderFormCard}
              {canDispense && attendantCard}
              {transactionsCard}
            </div>
          </>
        );
    }
  };

  const brandColor = brand && /^#[0-9a-f]{6}$/i.test(brand.primaryColor ?? '') ? brand.primaryColor : null;
  const brandStyle = isCustomer && brandColor
    ? ({
        '--green': brandColor,
        '--green-dark': `color-mix(in srgb, ${brandColor} 80%, #000)`,
        '--green-soft': `color-mix(in srgb, ${brandColor} 14%, #fff)`,
        '--green-faint': `color-mix(in srgb, ${brandColor} 28%, #fff)`,
      } as CSSProperties)
    : undefined;
  const brandName = isCustomer && brand?.brandName ? brand.brandName : 'Maestro';
  const staffGroups = [...new Set(STAFF_NAV.map((n) => n.group))];

  return (
    <div className="shell" style={brandStyle}>
      {/* ══ SIDEBAR ══ */}
      <aside className="sidebar">
        <div className="logo" onClick={() => setPage(home)} style={{ cursor: 'pointer' }}>
          <span className="logo-mark">{brandName.charAt(0).toUpperCase()}</span>
          <span className="logo-text">{brandName}</span>
        </div>

        <div className="search">
          <Ic n="search" s={13} />
          <input placeholder="Search…" />
          <kbd>⌘F</kbd>
        </div>

        {isCustomer ? (
          <>
            <span className="nav-label">Main menu</span>
            <nav>
              {navItem('dashboard', 'grid', 'Dashboard')}
              {navItem('new-order', 'newOrder', 'New order')}
              {navItem('bulk-order', 'bulk', 'Bulk order')}
              {navItem('my-orders', 'orders', 'My orders', pending)}
              {navItem('deliveries', 'truck', 'Deliveries')}
            </nav>
            <span className="nav-label">Fleet</span>
            <nav>
              {navItem('drivers', 'users', 'Drivers')}
              {navItem('vehicles', 'truck', 'Vehicles')}
              {navItem('trips', 'route', 'Trips & Routes')}
              {navItem('allocations', 'fuel', 'Fuel Allocations')}
              {navItem('suppliers', 'supplier', 'Fuel Suppliers')}
            </nav>
            <span className="nav-label">Account</span>
            <nav>
              {navItem('balance', 'wallet', 'My balance')}
              {navItem('invoices', 'receipt', 'Invoices & Payments')}
              {navItem('messages', 'message', 'Notifications')}
              {navItem('reports', 'report', 'Reports')}
              {navItem('insights', 'insights', 'Smart Insights')}
              {navItem('fraud', 'alert', 'Fraud & Alerts', alertCount || undefined)}
              {navItem('settings', 'settings', 'Settings')}
            </nav>
          </>
        ) : isOmc ? (
          <>
            <span className="nav-label">OMC console</span>
            <nav>
              {OMC_NAV.map((n) => navItem(n.key, n.icon, n.label, n.key === 'omc-orders' ? pending : undefined))}
            </nav>
          </>
        ) : (
          <>
            <span className="nav-label">Main menu</span>
            <nav>
              {navItem('dashboard', 'grid', 'Dashboard')}
              <a className={['vehicles', 'drivers', 'limits'].includes(page) ? 'nav-item active' : 'nav-item'}
                onClick={() => setPage('vehicles')}>
                <Ic n="truck" /> Fleet management <span className="chev"><Ic n="chevron" s={12} /></span>
              </a>
              {navSub('vehicles', 'All vehicles')}
              {navSub('drivers', 'Drivers directory')}
              {navSub('limits', 'Fuel limits', 2)}
              {navItem('orders', 'box', 'Orders & dispensing', pending)}
              {navItem('wetstock', 'drop', 'Wetstock')}
              {navItem('analytics', 'chart', 'Analytics & reports')}
            </nav>
            {staffGroups.map((group) => {
              const items = STAFF_NAV.filter((n) => n.group === group && n.roles.includes(user.role));
              return items.length === 0 ? null : (
                <div key={group}>
                  <span className="nav-label">{group}</span>
                  <nav>{items.map((n) => navItem(n.key, n.icon, n.label))}</nav>
                </div>
              );
            })}
          </>
        )}

        <span className="nav-label">Support</span>
        <nav>
          {!isCustomer && !isOmc && navItem('customers', 'users', 'Customers')}
          {!isCustomer && !isOmc && navItem('team', 'shield', 'Team & roles')}
          {navItem('helpdesk', 'help', 'Help & support')}
        </nav>

        <div className="plan-card">
          <span className="plan-ic"><Ic n="zap" s={14} /></span>
          <strong>Premium plan</strong>
          <small>Adding more sites is not a concern</small>
          <button className="plan-btn">Upgrade plan</button>
        </div>
      </aside>

      {/* ══ CONTENT ══ */}
      <div className="content">
        <header className="topbar">
          <span className="crumb">{isOmc ? OMC_NAV.find((n) => n.key === page)?.label ?? STAFF_NAV.find((n) => n.key === page)?.title ?? PAGES[page] : (isCustomer ? CUSTOMER_PAGES[page] : STAFF_NAV.find((n) => n.key === page)?.title ?? PAGES[page]) ?? PAGES[page]}</span>
          <div className="topbar-right">
            <span className="pill"><Ic n="calendar" s={13} /> Jan – Nov 2026 <Ic n="chevron" s={12} /></span>
            <span className="icon-btn" role="button" title="Notifications" style={{ cursor: 'pointer' }} onClick={() => setPage('messages')}><Ic n="bell" s={15} /></span>
            <div className="user-chip">
              <span className="avatar">{user.name.split(' ').map((p) => p[0]).join('').slice(0, 2).toUpperCase()}</span>
              <div className="user-meta">
                <b>{user.name}</b>
                <small>{user.role}</small>
              </div>
              <button className="signout" onClick={onLogout}>Sign out</button>
            </div>
            <button className="cta green" onClick={() => setPage(isCustomer ? 'new-order' : isOmc ? 'omc-orders' : 'orders')}><span className="plus">+</span> Quick order</button>
          </div>
        </header>

        {error && <div className="error" onClick={() => setError('')}>{error}</div>}

        {currenciesReady && renderPage()}
      </div>
    </div>
  );
}

/* ── auth gate ───────────────────────────────────────────── */
export default function App() {
  const [user, setUser] = useState<Session | null>(() => sessionStore.get());

  useEffect(() => {
    setUnauthorizedHandler(() => setUser(null));
  }, []);

  const logout = async () => {
    try {
      await api.logout();
    } catch {
      // token may already be invalid; clear locally regardless
    }
    sessionStore.clear();
    setUser(null);
  };

  return user ? <Portal user={user} onLogout={logout} /> : <Login onLogin={setUser} />;
}
