import { useEffect, useMemo, useState } from 'react';
import { api, type Registered, type Session, type Site } from './api';
import { ADMIN_ROLE, OMC_ROLE, isFinanceRole, isSupplierRole } from './customerData';
import CountryCurrencyFields from './CountryCurrencyFields';
import { Pts2ConnectionPage, Pts2PricesPage } from './Pts2Pages';
import { currencyOf, loadCurrencies, money, moneyFor } from './currency';
import Deliveries from './DeliveryPages';
import FinancePages from './FinancePages';
import { Reconciliation, Sentinel } from './OpsPages';
import {
  Field, Notice, PageHead, Rows, Select, StatStrip, StatusChip, num, useAction, useLoad, when,
} from './ui';

/* ── navigation: which staff roles can open which page ───────── */
export interface NavEntry { key: string; icon: string; label: string; title: string; group: string; roles: string[] }

const ALL_STAFF = ['Station Manager', 'Attendant', 'Finance', ADMIN_ROLE, OMC_ROLE];

export const STAFF_NAV: NavEntry[] = [
  { key: 'deliveries', icon: 'truck', label: 'Deliveries', title: 'Deliveries', group: 'Operations', roles: ALL_STAFF },
  { key: 'reconciliation', icon: 'scale', label: 'Reconciliation', title: 'Daily reconciliation', group: 'Operations', roles: ALL_STAFF },
  { key: 'pts2', icon: 'device', label: 'PTS-2 Connection', title: 'PTS-2 connection', group: 'Operations', roles: ['Station Manager', ADMIN_ROLE] },
  { key: 'pump-prices', icon: 'tag', label: 'Pump Prices', title: 'Pump prices', group: 'Operations', roles: ['Station Manager', ADMIN_ROLE] },
  { key: 'devices', icon: 'device', label: 'Integrations / Devices', title: 'Integrations & devices', group: 'Operations', roles: ALL_STAFF },
  { key: 'cctv', icon: 'camera', label: 'CCTV events', title: 'CCTV events', group: 'Operations', roles: ALL_STAFF },
  { key: 'insights', icon: 'insights', label: 'Insights', title: 'Insights', group: 'Operations', roles: ALL_STAFF },
  { key: 'pricing', icon: 'tag', label: 'Pricing', title: 'Pricing', group: 'Finance & risk', roles: ['Finance', ADMIN_ROLE, OMC_ROLE] },
  { key: 'finance', icon: 'finance', label: 'Finance', title: 'Finance', group: 'Finance & risk', roles: ['Finance', ADMIN_ROLE, OMC_ROLE] },
  { key: 'sentinel', icon: 'sentinel', label: 'Sentinel room', title: 'Sentinel room', group: 'Finance & risk', roles: ['Station Manager', ADMIN_ROLE, OMC_ROLE] },
  { key: 'orgs', icon: 'supplier', label: 'Organizations', title: 'Organizations', group: 'Platform', roles: [ADMIN_ROLE] },
  { key: 'branding', icon: 'tag', label: 'Branding', title: 'Branding', group: 'Platform', roles: ['Station Manager'] },
  { key: 'audit', icon: 'audit', label: 'Audit log', title: 'Audit log', group: 'Platform', roles: [ADMIN_ROLE] },
  { key: 'messages', icon: 'message', label: 'Notifications', title: 'Notifications', group: 'Platform', roles: ALL_STAFF },
];

export const staffPageAllowed = (page: string, role: string) =>
  STAFF_NAV.some((n) => n.key === page && n.roles.includes(role));

/* ── Organizations (admin) ───────────────────────────────────── */
const EMPTY_ORG = {
  name: '', type: 'CUSTOMER', country: 'ZA', currency: 'ZAR', contactEmail: '', contactPhone: '',
  registrationNo: '', creditLimit: '0', terms: 'NET_30', monthlyBudget: '0', adminName: '',
};

function BrandingCard() {
  const current = useLoad(api.branding);
  const act = useAction();
  const [name, setName] = useState('');
  const [color, setColor] = useState('#2DB94D');
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (current.data) {
      setName(current.data.brandName);
      setColor(current.data.primaryColor);
    }
  }, [current.data]);

  const save = () => act.run(async () => {
    await api.setBranding(name.trim(), color);
    setSaved(true);
    await current.reload();
  });

  return (
    <section className="card" style={{ marginBottom: 16 }}>
      <div className="card-head"><h2>White-label branding</h2><small className="muted">Shown to your customers in their portal</small></div>
      <Notice error={act.error} />
      <form className="row2" onSubmit={(e) => { e.preventDefault(); setSaved(false); void save(); }}>
        <Field label="Brand name" value={name} onChange={setName} required />
        <Field label="Primary colour" type="color" value={color} onChange={setColor} required />
        <button type="submit" className="cta green" disabled={act.busy || !name.trim()}>Save branding</button>
      </form>
      {saved && <small className="muted">Saved. Customers see this the next time they sign in.</small>}
    </section>
  );
}

function BrandingPage() {
  return (
    <>
      <PageHead icon="supplier" title="Branding" sub="Your name and colour in your customers' portal" />
      <BrandingCard />
    </>
  );
}

function Organizations() {
  const orgs = useLoad(api.organizations);
  const act = useAction();
  const [form, setForm] = useState(EMPTY_ORG);
  const [created, setCreated] = useState<Registered | null>(null);
  const set = (k: keyof typeof EMPTY_ORG) => (v: string) => setForm((f) => ({ ...f, [k]: v }));

  const submit = () => act.run(async () => {
    setCreated(null);
    const result = await api.registerOrganization({
      ...form,
      creditLimit: Number(form.creditLimit),
      monthlyBudget: Number(form.monthlyBudget),
      contactPhone: form.contactPhone || null,
      registrationNo: form.registrationNo || null,
    });
    setCreated(result);
    setForm(EMPTY_ORG);
    await loadCurrencies();
    await orgs.reload();
  });

  return (
    <>
      <PageHead icon="supplier" title="Organizations" sub="Register customers and suppliers on the platform" />
      <div className="row-2" style={{ marginTop: 0 }}>
        <section className="card">
          <div className="card-head"><h2>Register organization</h2></div>
          <Notice error={act.error} />
          {created && (
            <div className="otp-box">
              <strong>{created.organization.name} registered</strong>
              <span>Login: <b>{created.loginEmail}</b></span>
              <span>Temporary password: <b className="mono">{created.temporaryPassword}</b></span>
              <small>Shown once only — hand it to the organization&apos;s administrator now.</small>
            </div>
          )}
          <form onSubmit={(e) => { e.preventDefault(); void submit(); }}>
            <Field label="Organization name" value={form.name} onChange={set('name')} required />
            <div className="row2">
              <Select label="Type" value={form.type} onChange={set('type')} options={['CUSTOMER', 'SUPPLIER']} />
              <Field label="Registration no." value={form.registrationNo} onChange={set('registrationNo')} />
            </div>
            <CountryCurrencyFields country={form.country} currency={form.currency}
              onCountryChange={set('country')} onCurrencyChange={set('currency')} />
            <div className="row2">
              <Field label="Administrator name" value={form.adminName} onChange={set('adminName')} required />
              <Field label="Administrator email" type="email" value={form.contactEmail} onChange={set('contactEmail')} required />
            </div>
            <Field label="Phone" value={form.contactPhone} onChange={set('contactPhone')} />
            {form.type === 'CUSTOMER' && (
              <div className="row2">
                <Field label="Credit limit" type="number" min="0" value={form.creditLimit} onChange={set('creditLimit')} />
                <Select label="Terms" value={form.terms} onChange={set('terms')} options={['PREPAID', 'NET_7', 'NET_30', 'NET_60']} />
              </div>
            )}
            {form.type === 'CUSTOMER' && (
              <Field label="Monthly budget" type="number" min="0" value={form.monthlyBudget} onChange={set('monthlyBudget')} />
            )}
            <button type="submit" className="cta green wide" disabled={act.busy}>Register organization</button>
          </form>
        </section>
        <section className="card tbl-scroll">
          <div className="card-head"><h2>Registered organizations</h2><small className="muted">{orgs.data?.length ?? 0}</small></div>
          <table>
            <thead><tr><th>Name</th><th>Type</th><th>Country</th><th>Contact</th><th>Status</th></tr></thead>
            <tbody>
              <Rows state={orgs} cols={5} empty="No organizations.">
                {(rows) => rows.map((o) => (
                  <tr key={o.id}>
                    <td><b>{o.name}</b><br /><small>{o.registrationNo ?? ''}</small></td>
                    <td>{o.type.toLowerCase()}</td>
                    <td>{o.country} · {o.currency}</td>
                    <td>{o.contactEmail}</td>
                    <td><StatusChip status={o.status} /></td>
                  </tr>
                ))}
              </Rows>
            </tbody>
          </table>
        </section>
      </div>
    </>
  );
}

/* ── Pricing ─────────────────────────────────────────────────── */
function ruleLabel(mode: string, value: number, organization: string) {
  if (mode === 'FIXED') return `${moneyFor(value, organization)} / L`;
  if (mode === 'DISCOUNT_PCT') return `−${num(value, 2)}%`;
  return `−${moneyFor(value, organization)} / L`;
}

function Pricing({ user, sites }: { user: Session; sites: Site[] }) {
  const canEdit = isFinanceRole(user.role);
  const list = useLoad(api.listPrices);
  const rules = useLoad(api.priceRules);
  const history = useLoad(api.priceHistory);
  const orgs = useLoad(api.organizations);
  const act = useAction();
  const [form, setForm] = useState({ organization: '', product: '', siteCode: '', mode: 'FIXED', value: '', minLitres: '', validFrom: '' });
  const set = (k: keyof typeof form) => (v: string) => setForm((f) => ({ ...f, [k]: v }));
  const customers = (orgs.data ?? []).filter((o) => o.type === 'CUSTOMER');
  const products = (list.data ?? []).map((p) => p.product);
  const organization = form.organization || customers[0]?.name || '';
  const product = form.product || products[0] || '';
  const refresh = () => Promise.all([rules.reload(), history.reload()]);

  const propose = () => act.run(async () => {
    await api.proposeRule({
      organization, product, siteCode: form.siteCode || null, mode: form.mode, value: Number(form.value),
      minLitres: form.minLitres ? Number(form.minLitres) : null, validFrom: form.validFrom || null,
    });
    setForm((f) => ({ ...f, value: '', minLitres: '', validFrom: '' }));
    await refresh();
    return 'Price change proposed — a different Finance user must approve it.';
  });

  const decide = (id: string, approve: boolean) => act.run(async () => {
    if (approve) await api.approveRule(id); else await api.rejectRule(id);
    await refresh();
    return approve ? 'Price change approved and now active.' : 'Price change rejected.';
  });

  return (
    <>
      <PageHead icon="tag" title="Pricing" sub="Customer prices with four-eyes approval: the proposer can never approve their own change" />
      <Notice error={act.error} ok={act.ok} />
      <div className="row-2" style={{ marginTop: 0 }}>
        <section className="card">
          <div className="card-head"><h2>List prices</h2></div>
          <table>
            <thead><tr><th>Product</th><th>Price</th><th>Valid from</th></tr></thead>
            <tbody>
              <Rows state={list} cols={3} empty="No list prices.">
                {(rows) => rows.map((p) => (
                  <tr key={p.product}><td><b>{p.product}</b></td><td>{money(p.unitPrice, p.currency)} / L</td><td>{p.validFrom}</td></tr>
                ))}
              </Rows>
            </tbody>
          </table>
        </section>
        {canEdit && (
          <section className="card">
            <div className="card-head"><h2>Propose a price change</h2></div>
            <form onSubmit={(e) => { e.preventDefault(); void propose(); }}>
              <div className="row2">
                <Select label="Customer" value={organization} onChange={set('organization')} options={customers.map((c) => c.name)} />
                <Select label="Product" value={product} onChange={set('product')} options={products} />
              </div>
              <div className="row2">
                <Select label="Site" value={form.siteCode} onChange={set('siteCode')}
                  options={[['', 'All sites'], ...sites.map((s): [string, string] => [s.code, s.name])]} />
                <Select label="Type" value={form.mode} onChange={set('mode')}
                  options={[['FIXED', 'Fixed price / L'], ['DISCOUNT_PCT', 'Discount %'], ['DISCOUNT_ABS', 'Discount / L']]} />
              </div>
              <div className="row2">
                <Field label={form.mode === 'DISCOUNT_PCT' ? 'Value (%)' : `Value (${currencyOf(organization)}${form.mode === 'FIXED' ? ' / L' : ' off / L'})`}
                  type="number" step="0.01" min="0" value={form.value} onChange={set('value')} required />
                <Field label="Minimum litres (optional)" type="number" min="0" value={form.minLitres} onChange={set('minLitres')} />
              </div>
              <Field label="Valid from (optional)" type="date" value={form.validFrom} onChange={set('validFrom')} />
              <button type="submit" className="cta green wide" disabled={act.busy || !organization || !product}>Propose change</button>
            </form>
          </section>
        )}
      </div>
      <section className="card tbl-scroll" style={{ marginTop: '0.85rem' }}>
        <div className="card-head"><h2>Price rules</h2><small className="muted">Signed in as {user.email}</small></div>
        <table>
          <thead><tr><th>Customer</th><th>Product · site</th><th>Rule</th><th>Valid</th><th>Proposed by</th><th>Decided by</th><th>Status</th>{canEdit && <th />}</tr></thead>
          <tbody>
            <Rows state={rules} cols={canEdit ? 8 : 7} empty="No price rules yet.">
              {(rows) => rows.map((r) => (
                <tr key={r.id}>
                  <td><b>{r.organization}</b></td>
                  <td>{r.product}<br /><small>{r.siteCode ?? 'all sites'}{r.minLitres ? ` · min ${num(r.minLitres, 0)} L` : ''}</small></td>
                  <td>{ruleLabel(r.mode, r.value, r.organization)}</td>
                  <td>{r.validFrom}{r.validTo ? ` → ${r.validTo}` : ''}</td>
                  <td>{r.proposedBy}</td>
                  <td>{r.decidedBy ?? '—'}</td>
                  <td><StatusChip status={r.status} /></td>
                  {canEdit && (
                    <td>
                      {r.status === 'PENDING_APPROVAL' && (
                        <div className="inline-actions">
                          <button className="btn-ok" disabled={act.busy} onClick={() => void decide(r.id, true)}>Approve</button>
                          <button className="btn-ghost" disabled={act.busy} onClick={() => void decide(r.id, false)}>Reject</button>
                        </div>
                      )}
                    </td>
                  )}
                </tr>
              ))}
            </Rows>
          </tbody>
        </table>
      </section>
      <section className="card tbl-scroll" style={{ marginTop: '0.85rem' }}>
        <div className="card-head"><h2>Price history</h2><small className="muted">Every approved change</small></div>
        <table>
          <thead><tr><th>Customer</th><th>Product · site</th><th>Previous</th><th>New</th><th>Proposed by</th><th>Approved by</th><th>Effective</th></tr></thead>
          <tbody>
            <Rows state={history} cols={7} empty="No approved changes yet.">
              {(rows) => rows.map((h) => (
                <tr key={h.id}>
                  <td><b>{h.organization}</b></td>
                  <td>{h.product}<br /><small>{h.siteCode ?? 'all sites'}</small></td>
                  <td>{h.previousPrice === null ? '—' : moneyFor(h.previousPrice, h.organization)}</td>
                  <td><b>{moneyFor(h.newPrice, h.organization)}</b></td>
                  <td>{h.proposedBy}</td>
                  <td>{h.approvedBy}</td>
                  <td>{h.effectiveDate}</td>
                </tr>
              ))}
            </Rows>
          </tbody>
        </table>
      </section>
    </>
  );
}

/* ── Audit log (admin) ───────────────────────────────────────── */
function Audit() {
  const audit = useLoad(api.audit);
  const [q, setQ] = useState('');
  const rows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (audit.data ?? []).filter((r) => !needle || `${r.actorEmail} ${r.path} ${r.method} ${r.status}`.toLowerCase().includes(needle));
  }, [audit.data, q]);
  return (
    <>
      <PageHead icon="audit" title="Audit log" sub="Every API request, who made it and what it returned">
        <button className="cta" onClick={() => void audit.reload()}>Refresh</button>
      </PageHead>
      <section className="card tbl-scroll">
        <div className="form-row">
          <Field label="Filter by user, path, method or status" value={q} onChange={setQ} placeholder="e.g. finance@maestro.test or 403" />
        </div>
        <table>
          <thead><tr><th>When</th><th>Actor</th><th>Request</th><th>Status</th><th>IP</th></tr></thead>
          <tbody>
            {audit.loading || (audit.error && !audit.data)
              ? <tr><td colSpan={5} className="empty">{audit.loading ? 'Loading…' : audit.error}</td></tr>
              : rows.map((r) => (
                <tr key={r.id}>
                  <td>{when(r.at)}</td>
                  <td><b>{r.actorEmail}</b><br /><small>{r.actorRole ?? ''}</small></td>
                  <td><span className="mono">{r.method} {r.path}</span></td>
                  <td><span className={`chip ${r.status >= 400 ? 'chip-failed' : 'chip-ok'}`}>{r.status}</span></td>
                  <td><small>{r.ip}</small></td>
                </tr>
              ))}
            {!audit.loading && !audit.error && rows.length === 0 && <tr><td colSpan={5} className="empty">No matching entries.</td></tr>}
          </tbody>
        </table>
      </section>
    </>
  );
}

/* ── Insights ────────────────────────────────────────────────── */
function Insights() {
  const dash = useLoad(api.dashboard);
  const consumption = useLoad(api.consumption);
  const anomalies = useLoad(api.anomalies);
  const stockout = useLoad(api.stockout);
  const d = dash.data;
  return (
    <>
      <PageHead icon="insights" title="Insights" sub="Consumption, anomalies and stock-out forecast" />
      <Notice error={dash.error} />
      {d && (
        <>
          <StatStrip items={[
            { icon: 'drop', label: 'Litres today', value: num(d.litresToday), sub: `${d.dispensesToday} dispenses` },
            { icon: 'wallet', label: 'Sales today', value: money(d.salesToday), sub: 'Dispensed fuel value' },
            { icon: 'clock', label: 'Orders pending', value: String(d.ordersPending), sub: 'Awaiting supplier approval' },
            { icon: 'alert', label: 'Open risk events', value: String(d.openRiskEvents), sub: `${d.criticalRiskEvents} critical` },
          ]} />
          <div style={{ marginTop: '0.85rem' }}>
            <StatStrip items={[
              { icon: 'scale', label: 'Variance exceptions', value: String(d.openVarianceExceptions), sub: 'Open reconciliation items' },
              { icon: 'gauge', label: 'Tanks below reorder', value: String(d.tanksBelowReorder), sub: 'Needs a delivery' },
              { icon: 'warn', label: 'Overdue invoices', value: String(d.overdueInvoices), sub: 'Past due date' },
              { icon: 'receipt', label: 'Receivables', value: money(d.outstandingReceivables), sub: 'Outstanding balance' },
            ]} />
          </div>
        </>
      )}
      {dash.loading && <section className="card"><div className="empty">Loading dashboard…</div></section>}
      <div className="row-2">
        <section className="card tbl-scroll">
          <div className="card-head"><h2>Consumption by vehicle</h2></div>
          <table>
            <thead><tr><th>Vehicle</th><th>Fills</th><th>Litres</th><th>Avg fill</th><th>L / active day</th><th>Cost</th></tr></thead>
            <tbody>
              <Rows state={consumption} cols={6} empty="No dispenses yet.">
                {(rows) => rows.map((c) => (
                  <tr key={c.vehicle}><td><b>{c.vehicle}</b></td><td>{c.fills}</td><td>{num(c.litres)}</td><td>{num(c.averageFill)}</td><td>{num(c.litresPerActiveDay)}</td><td>{money(c.cost)}</td></tr>
                ))}
              </Rows>
            </tbody>
          </table>
        </section>
        <section className="card tbl-scroll">
          <div className="card-head"><h2>Anomalies</h2><small className="muted">Fills more than 2σ above the vehicle&apos;s norm</small></div>
          <table>
            <thead><tr><th>Vehicle</th><th>Litres</th><th>Usual</th><th>z-score</th><th>When</th></tr></thead>
            <tbody>
              <Rows state={anomalies} cols={5} empty="No anomalies detected.">
                {(rows) => rows.map((a) => (
                  <tr key={`${a.vehicle}-${a.at}`}><td><b>{a.vehicle}</b></td><td>{num(a.litres)}</td><td>{num(a.usual)}</td><td><span className="chip chip-high">{a.zScore}σ</span></td><td>{when(a.at)}</td></tr>
                ))}
              </Rows>
            </tbody>
          </table>
        </section>
      </div>
      <section className="card tbl-scroll" style={{ marginTop: '0.85rem' }}>
        <div className="card-head"><h2>Stock-out forecast</h2><small className="muted">Based on the last 14 days of sales</small></div>
        <table>
          <thead><tr><th>Site · product</th><th>Book stock</th><th>Avg / day</th><th>Days of cover</th><th>Predicted stock-out</th><th>Reorder</th></tr></thead>
          <tbody>
            <Rows state={stockout} cols={6} empty="No tanks configured.">
              {(rows) => rows.map((s) => (
                <tr key={`${s.siteCode}-${s.product}`}>
                  <td><b>{s.siteCode}</b><br /><small>{s.product}</small></td>
                  <td>{num(s.bookLitres, 0)} L</td>
                  <td>{num(s.averageDailyLitres, 2)} L</td>
                  <td>{s.daysOfCover === null ? '—' : num(s.daysOfCover)}</td>
                  <td>{s.predictedStockout ?? '—'}</td>
                  <td>{s.reorderNow
                    ? <span className="chip chip-critical">order {num(s.suggestedOrderLitres, 0)} L</span>
                    : <span className="chip chip-ok">ok</span>}</td>
                </tr>
              ))}
            </Rows>
          </tbody>
        </table>
      </section>
    </>
  );
}

/* ── Integrations / devices ──────────────────────────────────── */
function Devices() {
  const devices = useLoad(api.devices);
  const tanks = useLoad(api.tankReadings);
  const pumps = useLoad(api.pumpEvents);
  const refresh = () => Promise.all([devices.reload(), tanks.reload(), pumps.reload()]);
  const reloadDevices = devices.reload;
  const reloadTanks = tanks.reload;
  const reloadPumps = pumps.reload;
  useEffect(() => {
    const t = setInterval(() => void Promise.all([reloadDevices(), reloadTanks(), reloadPumps()]), 15000);
    return () => clearInterval(t);
  }, [reloadDevices, reloadTanks, reloadPumps]);
  const online = (devices.data ?? []).filter((d) => d.online).length;
  return (
    <>
      <PageHead icon="device" title="Integrations & devices" sub="Tank gauges and pump controllers reporting to the platform">
        <button className="cta" onClick={() => void refresh()}>Refresh</button>
      </PageHead>
      <StatStrip items={[
        { icon: 'device', label: 'Devices', value: String(devices.data?.length ?? 0), sub: `${online} online` },
        { icon: 'warn', label: 'Offline', value: String((devices.data?.length ?? 0) - online), sub: 'No report for over 5 minutes' },
        { icon: 'drop', label: 'Tank readings', value: String(tanks.data?.length ?? 0), sub: 'Most recent stored' },
        { icon: 'gauge', label: 'Pump events', value: String(pumps.data?.length ?? 0), sub: 'Most recent stored' },
      ]} />
      <section className="card tbl-scroll" style={{ marginTop: '0.85rem' }}>
        <div className="card-head"><h2>Devices</h2></div>
        <table>
          <thead><tr><th>Device</th><th>Site</th><th>Kind</th><th>Last seen</th><th>State</th></tr></thead>
          <tbody>
            <Rows state={devices} cols={5} empty="No devices have reported yet.">
              {(rows) => rows.map((d) => (
                <tr key={d.id}>
                  <td><b>{d.deviceId}</b></td><td>{d.siteCode}</td><td>{d.kind}</td><td>{when(d.lastSeen)}</td>
                  <td><StatusChip status={d.online ? 'online' : 'offline'} /></td>
                </tr>
              ))}
            </Rows>
          </tbody>
        </table>
      </section>
      <div className="row-2">
        <section className="card tbl-scroll">
          <div className="card-head"><h2>Latest tank readings</h2><small className="muted">15 °C corrected volume</small></div>
          <table>
            <thead><tr><th>Site · product</th><th>Volume</th><th>@15 °C</th><th>Temp</th><th>Water</th><th>At</th></tr></thead>
            <tbody>
              <Rows state={tanks} cols={6} empty="No tank readings yet.">
                {(rows) => rows.slice(0, 25).map((r) => (
                  <tr key={r.id}>
                    <td><b>{r.siteCode}</b><br /><small>{r.product}</small></td>
                    <td>{num(r.volumeLitres, 0)} L</td>
                    <td>{num(r.tcVolumeLitres, 0)} L</td>
                    <td>{r.temperatureC === null ? '—' : `${num(r.temperatureC)} °C`}</td>
                    <td>{r.waterMm === null ? '—' : `${num(r.waterMm)} mm`}</td>
                    <td>{when(r.at)}</td>
                  </tr>
                ))}
              </Rows>
            </tbody>
          </table>
        </section>
        <section className="card tbl-scroll">
          <div className="card-head"><h2>Latest pump events</h2></div>
          <table>
            <thead><tr><th>Site · pump</th><th>Kind</th><th>Value</th><th>At</th></tr></thead>
            <tbody>
              <Rows state={pumps} cols={4} empty="No pump events yet.">
                {(rows) => rows.slice(0, 25).map((p) => (
                  <tr key={p.id}><td><b>{p.siteCode}</b><br /><small>{p.pumpId}</small></td><td>{p.kind}</td><td>{num(p.value, 2)}</td><td>{when(p.at)}</td></tr>
                ))}
              </Rows>
            </tbody>
          </table>
        </section>
      </div>
    </>
  );
}

/* ── CCTV ────────────────────────────────────────────────────── */
function Cctv({ user, sites }: { user: Session; sites: Site[] }) {
  const events = useLoad(api.cctvEvents);
  const act = useAction();
  const canPost = isSupplierRole(user.role);
  const [form, setForm] = useState({ siteCode: '', cameraId: 'CAM-1', kind: 'CONTAINER_DETECTED', plate: '', confidence: '0.9', clipRef: '' });
  const set = (k: keyof typeof form) => (v: string) => setForm((f) => ({ ...f, [k]: v }));
  const siteCode = form.siteCode || sites[0]?.code || '';

  const post = () => act.run(async () => {
    const e = await api.postCctvEvent({
      ...form, siteCode, confidence: Number(form.confidence), plate: form.plate || null, clipRef: form.clipRef || null,
    });
    await events.reload();
    return e.riskEventId ? 'Event stored and linked to a new Sentinel risk event.' : 'Event stored (no risk raised).';
  });

  return (
    <>
      <PageHead icon="camera" title="CCTV events" sub="Detections from the site video system, linked to the dispense they overlap" />
      <div className="row-3" style={{ marginTop: 0 }}>
        <section className="card tbl-scroll" style={{ gridColumn: canPost ? undefined : '1 / -1' }}>
          <div className="card-head"><h2>Events</h2><button className="mini-btn" onClick={() => void events.reload()}>Refresh</button></div>
          <table>
            <thead><tr><th>Site · camera</th><th>Kind</th><th>Plate</th><th>Confidence</th><th>Clip</th><th>Risk</th><th>At</th></tr></thead>
            <tbody>
              <Rows state={events} cols={7} empty="No CCTV events yet.">
                {(rows) => rows.map((e) => (
                  <tr key={e.id}>
                    <td><b>{e.siteCode}</b><br /><small>{e.cameraId}</small></td>
                    <td>{e.kind.replaceAll('_', ' ').toLowerCase()}</td>
                    <td>{e.plate ?? '—'}</td>
                    <td>{Math.round(e.confidence * 100)}%</td>
                    <td>{e.clipRef ?? '—'}</td>
                    <td>{e.riskEventId ? <span className="chip chip-high">raised</span> : '—'}</td>
                    <td>{when(e.at)}</td>
                  </tr>
                ))}
              </Rows>
            </tbody>
          </table>
        </section>
        {canPost && (
          <section className="card" style={{ gridColumn: 'span 2' }}>
            <div className="card-head"><h2>Simulate an event</h2><small className="muted">Stands in for the site video system</small></div>
            <Notice error={act.error} ok={act.ok} />
            <form onSubmit={(e) => { e.preventDefault(); void post(); }}>
              <div className="row2">
                <Select label="Site" value={siteCode} onChange={set('siteCode')} options={sites.map((s): [string, string] => [s.code, s.name])} />
                <Field label="Camera" value={form.cameraId} onChange={set('cameraId')} required />
              </div>
              <div className="row2">
                <Select label="Kind" value={form.kind} onChange={set('kind')}
                  options={['CONTAINER_DETECTED', 'NOZZLE_AWAY', 'ATTENDANT_BEHAVIOR', 'ANPR']} />
                <Field label="Confidence (0–1)" type="number" step="0.01" min="0" value={form.confidence} onChange={set('confidence')} required />
              </div>
              <div className="row2">
                <Field label="Plate (ANPR)" value={form.plate} onChange={set('plate')} />
                <Field label="Clip reference" value={form.clipRef} onChange={set('clipRef')} />
              </div>
              <button type="submit" className="cta green wide" disabled={act.busy || !siteCode}>Post event</button>
            </form>
          </section>
        )}
      </div>
    </>
  );
}

/* ── Notifications (staff and customers) ─────────────────────── */
export function Messages() {
  const items = useLoad(api.notifications);
  return (
    <>
      <PageHead icon="message" title="Notifications" sub="SMS and in-app messages sent on your behalf">
        <button className="cta" onClick={() => void items.reload()}>Refresh</button>
      </PageHead>
      <section className="card tbl-scroll">
        <table>
          <thead><tr><th>When</th><th>Channel</th><th>Type</th><th>Message</th><th>To</th><th>Status</th></tr></thead>
          <tbody>
            <Rows state={items} cols={6} empty="No notifications yet.">
              {(rows) => rows.map((n) => (
                <tr key={n.id}>
                  <td>{when(n.createdAt)}</td>
                  <td><StatusChip status={n.channel} /></td>
                  <td>{n.kind.replaceAll('_', ' ').toLowerCase()}</td>
                  <td>{n.message}</td>
                  <td>{n.recipientName ?? '—'}{n.phone && <><br /><small>{n.phone}</small></>}</td>
                  <td><StatusChip status={n.status} /></td>
                </tr>
              ))}
            </Rows>
          </tbody>
        </table>
      </section>
    </>
  );
}

export default function StaffPages({ page, user, sites }: { page: string; user: Session; sites: Site[] }) {
  switch (page) {
    case 'orgs': return <Organizations />;
    case 'branding': return <BrandingPage />;
    case 'pricing': return <Pricing user={user} sites={sites} />;
    case 'finance': return <FinancePages />;
    case 'sentinel': return <Sentinel />;
    case 'audit': return <Audit />;
    case 'devices': return <Devices />;
    case 'pts2': return <Pts2ConnectionPage sites={sites} canEdit={user.role === ADMIN_ROLE} />;
    case 'pump-prices': return <Pts2PricesPage sites={sites} canEdit={user.role === ADMIN_ROLE} />;
    case 'reconciliation': return <Reconciliation sites={sites} />;
    case 'deliveries': return <Deliveries user={user} sites={sites} />;
    case 'cctv': return <Cctv user={user} sites={sites} />;
    case 'insights': return <Insights />;
    case 'messages': return <Messages />;
    default: return null;
  }
}
