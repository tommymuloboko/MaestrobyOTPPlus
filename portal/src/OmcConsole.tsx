import { useEffect, useState, type ReactNode } from 'react';
import { api, type Driver, type FuelOrder, type FuelTransaction, type Session, type Site, type Vehicle } from './api';
import Deliveries from './DeliveryPages';
import FinancePages, { Erp, type FinanceTab } from './FinancePages';
import AddSiteForm from './FacilitiesAdmin';
import { KIND_LABELS } from './sites';
import { Phase2, type OmcGo } from './OmcShared';
import {
  CustomerManagement, DriverManagement, OrderManagement, OtpManagement, VehicleManagement,
} from './OmcPages';
import { CustomerBalances, ReportsAnalytics } from './OmcReports';
import { Reconciliation, Sentinel } from './OpsPages';
import StaffPages, { StockCards } from './StaffPages';
import TankTrends from './TankTrends';
import UsersAdmin from './UsersAdmin';
import { Ic, Notice, PageHead, StatStrip, StatusChip, Tabs, money, num, useLoad, when } from './ui';

export interface OmcNavEntry { key: string; icon: string; label: string; sub: string }

export const OMC_HOME = 'omc-overview';
export const OMC_NAV: OmcNavEntry[] = [
  { key: 'omc-overview', icon: 'grid', label: 'Overview', sub: 'Network-wide KPIs, operational health and critical alerts' },
  { key: 'omc-orders', icon: 'orders', label: 'Order Management', sub: 'Review, approve, reject, amend and cancel orders' },
  { key: 'omc-customers', icon: 'users', label: 'Customer Management', sub: 'Register companies, set contracts, pricing and credit limits' },
  { key: 'omc-transporters', icon: 'route', label: 'Transporter Management', sub: 'Transport companies and their fleets' },
  { key: 'omc-drivers', icon: 'userCheck', label: 'Driver Management', sub: 'Verify drivers, assign vehicles and manage OTP access' },
  { key: 'omc-vehicles', icon: 'truck', label: 'Vehicle Management', sub: 'Register vehicles, set tank capacities, track fuelling history' },
  { key: 'omc-facilities', icon: 'warehouse', label: 'Facilities Management', sub: 'Stations, depots and fuel depots' },
  { key: 'omc-inventory', icon: 'tank', label: 'Tanks', sub: 'ATG tanks, stock levels, deliveries and variances' },
  { key: 'omc-pumps', icon: 'gauge', label: 'Pump & Meter Monitoring', sub: 'Live dispensing, equipment status and connectivity' },
  { key: 'omc-otp', icon: 'key', label: 'OTP Management', sub: 'Issue, revoke, regenerate and monitor OTP authorizations' },
  { key: 'omc-fraud', icon: 'alert', label: 'Fraud & Risk Centre', sub: 'Suspicious transactions and investigations' },
  { key: 'omc-finance', icon: 'finance', label: 'Financial Management', sub: 'Pricing, customer balances, credit control and reconciliation' },
  { key: 'omc-reports', icon: 'report', label: 'Reports & Analytics', sub: 'Operational, financial, inventory and customer reporting' },
  { key: 'omc-users', icon: 'shield', label: 'Users & Permissions', sub: 'User accounts, roles and approval limits' },
  { key: 'omc-settings', icon: 'settings', label: 'Settings & Integrations', sub: 'SMS, payment gateways, Maestro Controller and ERP' },
];

const REFRESH_MS = 15000;

/** Reloads the given loaders every 15 seconds while the page is open. */
function useAutoRefresh(reloaders: (() => Promise<void>)[]) {
  useEffect(() => {
    const t = setInterval(() => void Promise.all(reloaders.map((r) => r())), REFRESH_MS);
    return () => clearInterval(t);
    // the reloaders are stable references from useLoad
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, reloaders);
}

/* ── Overview ─────────────────────────────────────────────────── */
const CRITICAL = ['CRITICAL', 'HIGH'];
const isControllerRisk = (rule: string) => /offline|controller|heartbeat|silent/i.test(rule);

function Overview({ orders, loaded, go }: { orders: FuelOrder[]; loaded: boolean; go: OmcGo }) {
  const dash = useLoad(api.dashboard);
  const devices = useLoad(api.devices);
  const events = useLoad(api.riskEvents);
  useAutoRefresh([dash.reload, devices.reload, events.reload]);
  const d = dash.data;
  const online = (devices.data ?? []).filter((x) => x.online).length;
  const offline = (devices.data ?? []).length - online;
  const open = (events.data ?? []).filter((e) => e.status === 'OPEN');
  const alerts = open.filter((e) => CRITICAL.includes(e.severity)).slice(0, 8);
  const controllerOffline = open.filter((e) => isControllerRisk(e.rule)).length;
  const pending = orders.filter((o) => o.status === 'PENDING_APPROVAL');
  const v = (x: string | null | undefined) => (d ? x ?? '—' : '…');

  return (
    <>
      <PageHead icon="grid" title="Overview" sub="Network-wide KPIs, operational health and critical alerts">
        <button className="cta" onClick={() => void Promise.all([dash.reload(), devices.reload(), events.reload()])}><Ic n="refresh" s={13} /> Refresh</button>
      </PageHead>
      <Notice error={dash.error} />
      <StatStrip items={[
        { icon: 'drop', label: 'Litres today', value: v(d && num(d.litresToday)), sub: d ? `${d.dispensesToday} dispenses` : 'Loading' },
        { icon: 'wallet', label: 'Sales today', value: v(d && money(d.salesToday)), sub: 'Dispensed fuel value' },
        { icon: 'clock', label: 'Orders pending', value: v(d && String(d.ordersPending)), sub: 'Awaiting supplier approval' },
        { icon: 'alert', label: 'Open risk events', value: v(d && String(d.openRiskEvents)), sub: d ? `${d.criticalRiskEvents} critical` : 'Loading' },
      ]} />
      <div style={{ marginTop: '0.85rem' }}>
        <StatStrip items={[
          { icon: 'scale', label: 'Variance exceptions', value: v(d && String(d.openVarianceExceptions)), sub: 'Open reconciliation items' },
          { icon: 'gauge', label: 'Tanks below reorder', value: v(d && String(d.tanksBelowReorder)), sub: 'Needs a delivery' },
          { icon: 'warn', label: 'Overdue invoices', value: v(d && String(d.overdueInvoices)), sub: 'Past due date' },
          { icon: 'receipt', label: 'Receivables', value: v(d && money(d.outstandingReceivables)), sub: 'Outstanding balance' },
        ]} />
      </div>
      <div className="row-2">
        <section className="card">
          <div className="card-head"><h2>Operational health</h2><button className="mini-btn" onClick={() => go('omc-pumps')}>Equipment</button></div>
          <dl className="kv">
            <dt>Devices online</dt><dd>{devices.loading ? '…' : <>{online} of {(devices.data ?? []).length} {offline > 0 && <span className="chip chip-offline">{offline} offline</span>}</>}</dd>
            <dt>Tanks below reorder</dt><dd>{d ? <>{d.tanksBelowReorder} {d.tanksBelowReorder > 0 && <span className="chip chip-pending_approval">needs delivery</span>}</> : '…'}</dd>
            <dt>Controller-offline alerts</dt><dd>{events.loading ? '…' : <>{controllerOffline} {controllerOffline > 0 && <span className="chip chip-critical">open</span>}</>}</dd>
            <dt>Open variance exceptions</dt><dd>{d ? d.openVarianceExceptions : '…'}</dd>
          </dl>
          <Notice error={devices.error || events.error} />
        </section>
        <section className="card">
          <div className="card-head"><h2>Orders awaiting approval</h2><button className="mini-btn green" onClick={() => go('omc-orders')}>Review in Order Management</button></div>
          {!loaded ? <div className="empty">Loading orders…</div> : pending.length === 0 ? <div className="empty">Nothing is waiting for approval.</div> : (
            <ul className="mini-list">
              {pending.slice(0, 6).map((o) => (
                <li key={o.id}><b>{o.number}</b><span>{o.customerName} · {o.vehicleReg}</span><span>{num(o.quantityLitres)} L</span></li>
              ))}
              {pending.length > 6 && <li><small className="muted">and {pending.length - 6} more</small></li>}
            </ul>
          )}
        </section>
      </div>
      <section className="card" style={{ marginTop: '0.85rem' }}>
        <div className="card-head"><h2>Critical alerts</h2><button className="mini-btn" onClick={() => go('omc-fraud')}>Open Fraud & Risk Centre</button></div>
        {events.loading ? <div className="empty">Loading alerts…</div> : events.error && !events.data ? <div className="empty err">{events.error}</div>
          : alerts.length === 0 ? <div className="empty">No open critical or high-severity alerts.</div> : (
            <ul className="mini-list alerts">
              {alerts.map((e) => (
                <li key={e.id} className="clickable" onClick={() => go('omc-fraud')}>
                  <StatusChip status={e.severity} />
                  <b>{e.rule.replaceAll('_', ' ').toLowerCase()}</b>
                  <span>{e.details}</span>
                  <small>{[e.organization, e.siteCode, e.vehicleReg].filter(Boolean).join(' · ')} · {when(e.createdAt)}</small>
                </li>
              ))}
            </ul>
          )}
      </section>
    </>
  );
}

/* ── Phase 2 pages ────────────────────────────────────────────── */
function Transporters() {
  return (
    <>
      <PageHead icon="route" title="Transporter Management" sub="Transport companies and their fleets" />
      <Phase2 title="Transporter Management" intro="Not available yet. Nothing on this page is live, and no transporter data exists in the system.">
        <p>When it ships, this module will let the OMC:</p>
        <ul className="plain-list">
          <li>register transport companies that own fleets and haul fuel for customers;</li>
          <li>manage each transporter&apos;s vehicles and drivers;</li>
          <li>link a transporter to the customers it hauls for.</li>
        </ul>
        <p className="muted">It needs a new organisation type in the platform (today only customers and suppliers exist), which is why it is scheduled for Phase 2.</p>
      </Phase2>
    </>
  );
}

const ROLES: [string, string][] = [
  ['Fleet Manager', "Customer role: places and tracks orders for their own organisation, manages its vehicles and drivers, and sees its own invoices and balance."],
  ['Station Manager', 'Supplier role: approves or rejects orders, issues and manages OTP codes, dispenses fuel and runs depot operations (deliveries, reconciliation, Sentinel).'],
  ['Attendant', 'Pump terminal: validates an OTP with the driver PIN and records the dispense. Nothing else.'],
  ['Finance', 'Finance functions: pricing proposals and approvals (four-eyes), invoicing, payments, ledger, settlement, FX and ERP.'],
  ['OMC Administrator', 'Supplier, finance and staff privileges. May register customers and register vehicles on their behalf. Cannot register suppliers or read the audit log.'],
  ['Platform Admin', 'Everything, including the audit log and registering suppliers and any organisation.'],
];

function UsersPermissions({ user }: { user: Session }) {
  return (
    <>
      <PageHead icon="shield" title="Users & Permissions" sub="Add, edit, deactivate and delete user accounts" />
      <UsersAdmin me={user} />
      <section className="card tbl-scroll" style={{ marginTop: '0.85rem' }}>
        <div className="card-head"><h2>Roles</h2><small className="muted">As enforced by the backend; the roles themselves are fixed</small></div>
        <table>
          <thead><tr><th>Role</th><th>What it can do today</th></tr></thead>
          <tbody>
            {ROLES.map(([role, text]) => (
              <tr key={role}><td><b>{role}</b>{role === user.role && <> <span className="chip chip-active">you</span></>}</td><td>{text}</td></tr>
            ))}
          </tbody>
        </table>
      </section>
    </>
  );
}

/* ── Facilities ───────────────────────────────────────────────── */
function Facilities({ sites, reloadSites }: { sites: Site[]; reloadSites: () => Promise<void> }) {
  const stock = useLoad(api.stock);
  const devices = useLoad(api.devices);
  useAutoRefresh([stock.reload, devices.reload]);
  const [adding, setAdding] = useState(false);
  return (
    <>
      <PageHead icon="warehouse" title="Facilities Management" sub="Stations, depots and fuel depots">
        <button className="cta green" onClick={() => setAdding(!adding)}>{adding ? 'Close' : '+ Add site'}</button>
      </PageHead>
      {adding && <AddSiteForm onAdded={async () => { await Promise.all([reloadSites(), stock.reload()]); }} />}
      <Notice error={stock.error || devices.error} />
      {sites.length === 0 && <section className="card"><div className="empty">No sites found.</div></section>}
      <div className="row-3 even" style={{ marginTop: 0 }}>
        {sites.map((s) => {
          const tanks = (stock.data ?? []).filter((t) => t.siteCode === s.code);
          const devs = (devices.data ?? []).filter((x) => x.siteCode === s.code);
          return (
            <section className="card" key={s.code}>
              <div className="card-head"><h2>{s.name}</h2><span className="chip chip-planned">{s.code}</span></div>
              <dl className="kv">
                <dt>Type</dt><dd>{KIND_LABELS[s.kind ?? ''] ?? s.kind ?? '—'}</dd>
                <dt>PTS-2 controller</dt><dd className="mono">{s.pts2Id ?? '—'}</dd>
              </dl>
              <h3 className="sub-h">Tanks</h3>
              {stock.loading ? <div className="empty">Loading tanks…</div> : tanks.length === 0 ? <div className="empty">No tanks reported.</div> : tanks.map((t) => (
                <div key={t.product} style={{ marginBottom: '0.6rem' }}>
                  <div className="space-between"><b>{t.product}</b><small>{num(t.bookLitres, 0)} / {num(t.capacityLitres, 0)} L · {num(t.percent, 0)}%</small></div>
                  <div className="usage-bar"><i style={{ width: `${Math.min(t.percent, 100)}%` }} className={t.belowReorder ? 'hot' : ''} /></div>
                  {t.belowReorder && <small className="reason">Below reorder level</small>}
                </div>
              ))}
              <h3 className="sub-h">Devices</h3>
              {devices.loading ? <div className="empty">Loading devices…</div> : devs.length === 0 ? <div className="empty">No devices have reported.</div> : devs.map((x) => (
                <div key={x.id} className="space-between" style={{ marginBottom: '0.35rem' }}>
                  <span><b>{x.deviceId}</b> <small>{x.kind}</small></span><StatusChip status={x.online ? 'online' : 'offline'} />
                </div>
              ))}
            </section>
          );
        })}
      </div>
    </>
  );
}

/* ── Tabbed modules built from existing pages ─────────────────── */
function Inventory({ user, sites }: { user: Session; sites: Site[] }) {
  const [tab, setTab] = useState<'tanks' | 'trends' | 'recon' | 'deliveries'>('tanks');
  return (
    <>
      <PageHead icon="tank" title="Tanks" sub="ATG tanks, stock levels, deliveries and variances" />
      <Tabs tabs={[['tanks', 'Tanks'], ['trends', 'Tank trends'], ['recon', 'Reconciliation'], ['deliveries', 'Deliveries']]} value={tab} onChange={setTab} />
      {tab === 'tanks' && <StockCards />}
      {tab === 'trends' && <TankTrends />}
      {tab === 'recon' && <Reconciliation sites={sites} />}
      {tab === 'deliveries' && <Deliveries user={user} sites={sites} />}
    </>
  );
}

function FraudRisk({ user, sites }: { user: Session; sites: Site[] }) {
  const [tab, setTab] = useState<'sentinel' | 'cctv'>('sentinel');
  return (
    <>
      <PageHead icon="alert" title="Fraud & Risk Centre" sub="Suspicious transactions and investigations" />
      <Tabs tabs={[['sentinel', 'Sentinel room'], ['cctv', 'CCTV events']]} value={tab} onChange={setTab} />
      {tab === 'sentinel' ? <Sentinel /> : <StaffPages page="cctv" user={user} sites={sites} />}
    </>
  );
}

type FinTab = 'pricing' | 'balances' | 'finance';
function Financial({ user, sites, hint }: { user: Session; sites: Site[]; hint?: { tab?: string; customer?: string } }) {
  const hinted = hint?.tab ?? 'pricing';
  const [tab, setTab] = useState<FinTab>(hinted.startsWith('finance') ? 'finance' : hinted === 'balances' ? 'balances' : 'pricing');
  const financeTab: FinanceTab = hinted === 'finance-statements' ? 'statements' : hinted === 'finance-fx' ? 'fx' : 'invoices';
  return (
    <>
      <PageHead icon="finance" title="Financial Management" sub="Pricing, customer balances, credit control and reconciliation" />
      <Tabs tabs={[['pricing', 'Pricing'], ['balances', 'Customer balances'], ['finance', 'Finance']]} value={tab} onChange={setTab} />
      {tab === 'pricing' && <StaffPages page="pricing" user={user} sites={sites} />}
      {tab === 'balances' && <CustomerBalances />}
      {tab === 'finance' && <FinancePages initialTab={financeTab} customer={hint?.customer} />}
    </>
  );
}

/* ── Settings & Integrations ──────────────────────────────────── */
const SIMULATED = [
  ['SMS gateway', 'Notifications are recorded and marked “sent (simulated)”; no real SMS leaves the system.'],
  ['Card payment gateway', 'Card payments are simulated; no card processor is connected.'],
  ['Fiscal reference', 'Invoice fiscal references are generated locally, not issued by a tax authority.'],
  ['CCTV / ONVIF source', 'CCTV events are posted manually (or by tests); there is no live camera feed.'],
];

function Settings({ go }: { go: OmcGo }) {
  const devices = useLoad(api.devices);
  useAutoRefresh([devices.reload]);
  const list = devices.data ?? [];
  const online = list.filter((x) => x.online).length;
  const lastSeen = list.map((x) => x.lastSeen).sort().pop();
  return (
    <>
      <PageHead icon="settings" title="Settings & Integrations" sub="SMS, payment gateways, Maestro Controller and ERP" />
      <Notice error={devices.error} />
      <div className="row-2" style={{ marginTop: 0 }}>
        <section className="card">
          <div className="card-head"><h2>Maestro Controller / ATG devices</h2><button className="mini-btn" onClick={() => go('omc-pumps')}>Open monitoring</button></div>
          {devices.loading ? <div className="empty">Loading devices…</div> : (
            <dl className="kv">
              <dt>Online</dt><dd>{online} of {list.length}</dd>
              <dt>Offline</dt><dd>{list.length - online}</dd>
              <dt>Last report</dt><dd>{lastSeen ? when(lastSeen) : 'No device has reported yet'}</dd>
            </dl>
          )}
          <small className="muted">Read-only status; devices connect to the platform on their own.</small>
        </section>
        <section className="card">
          <div className="card-head"><h2>Currency (FX rates)</h2><button className="mini-btn green" onClick={() => go('omc-finance', 'finance-fx')}>Open FX rates</button></div>
          <p className="muted">Exchange rates are maintained on the Financial Management page.</p>
        </section>
      </div>
      <div style={{ marginTop: '0.85rem' }}><Erp /></div>
      <section className="card" style={{ marginTop: '0.85rem' }}>
        <div className="card-head"><h2>Simulated in this build</h2><span className="chip chip-planned">Configuration planned for Phase 2</span></div>
        <table>
          <thead><tr><th>Integration</th><th>Current behaviour</th></tr></thead>
          <tbody>{SIMULATED.map(([n, t]) => <tr key={n}><td><b>{n}</b></td><td>{t}</td></tr>)}</tbody>
        </table>
        <small className="muted">Configuring these integrations is planned for Phase 2; there are no settings to change here yet.</small>
      </section>
    </>
  );
}

/* ── console router ───────────────────────────────────────────── */
interface Props {
  page: string;
  user: Session;
  sites: Site[];
  orders: FuelOrder[];
  vehicles: Vehicle[];
  drivers: Driver[];
  transactions: FuelTransaction[];
  loaded: boolean;
  reload: () => Promise<void>;
  reloadSites: () => Promise<void>;
  go: (page: string) => void;
}

export default function OmcConsole({ page, user, sites, orders, vehicles, drivers, transactions, loaded, reload, reloadSites, go }: Props) {
  const [hint, setHint] = useState<{ page: string; tab?: string; customer?: string } | null>(null);
  useEffect(() => { if (hint && hint.page !== page) setHint(null); }, [page, hint]);
  const navigate: OmcGo = (target, tab, customer) => { setHint({ page: target, tab, customer }); go(target); };
  const pageHint = hint && hint.page === page ? hint : undefined;

  const view = (): ReactNode => {
    switch (page) {
      case 'omc-orders': return <OrderManagement orders={orders} loaded={loaded} reload={reload} go={navigate} />;
      case 'omc-customers': return <CustomerManagement orders={orders} go={navigate} />;
      case 'omc-transporters': return <Transporters />;
      case 'omc-drivers': return <DriverManagement drivers={drivers} loaded={loaded} reload={reload} />;
      case 'omc-vehicles': return <VehicleManagement vehicles={vehicles} orders={orders} transactions={transactions} loaded={loaded} reload={reload} />;
      case 'omc-facilities': return <Facilities sites={sites} reloadSites={reloadSites} />;
      case 'omc-inventory': return <Inventory user={user} sites={sites} />;
      case 'omc-pumps': return <StaffPages page="devices" user={user} sites={sites} />;
      case 'omc-otp': return <OtpManagement orders={orders} />;
      case 'omc-fraud': return <FraudRisk user={user} sites={sites} />;
      case 'omc-finance': return <Financial user={user} sites={sites} hint={pageHint} />;
      case 'omc-reports': return <ReportsAnalytics user={user} sites={sites} orders={orders} transactions={transactions} />;
      case 'omc-users': return <UsersPermissions user={user} />;
      case 'omc-settings': return <Settings go={navigate} />;
      default: return <Overview orders={orders} loaded={loaded} go={navigate} />;
    }
  };
  return <>{view()}</>;
}
