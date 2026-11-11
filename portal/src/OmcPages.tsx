import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import {
  api, type Driver, type FuelOrder, type FuelTransaction, type Organization, type OtpResponse, type OtpStatus, type OtpView,
  type Registered, type Standing, type Vehicle,
} from './api';
import CountryCurrencyFields from './CountryCurrencyFields';
import { currencyOf, loadCurrencies, moneyFor, sharedCurrency } from './currency';
import { MIN_VEHICLE_YEAR, VEHICLE_TYPES, maxVehicleYear, validYear } from './customerData';
import ExportMenu from './ExportMenu';
import type { ExportSpec } from './exporter';
import { OrderTimeline } from './OrderPages';
import {
  BulkResultBox, FilterBar, OneTimeBox, ReasonForm, SelectBox, SelectionBar, lower, matches, runBulk, slug, sumOf, useSelection,
  type BulkResultData, type OmcGo,
} from './OmcShared';
import {
  Field, Ic, Notice, PageHead, Rows, Select, StatStrip, StatusChip, money, num, useAction, useLoad, when,
} from './ui';

/* ── Order Management ─────────────────────────────────────────── */
type OrderFilter = 'ALL' | 'PENDING_APPROVAL' | 'PENDING_CUSTOMER_APPROVAL' | 'AUTHORIZED' | 'FULFILLED' | 'REJECTED' | 'CANCELLED';
const ORDER_FILTERS: [OrderFilter, string][] = [
  ['ALL', 'All'], ['PENDING_APPROVAL', 'Awaiting approval'], ['PENDING_CUSTOMER_APPROVAL', 'Awaiting customer'],
  ['AUTHORIZED', 'Authorized'], ['FULFILLED', 'Fulfilled'], ['REJECTED', 'Rejected'], ['CANCELLED', 'Cancelled'],
];
const orderInFilter = (o: FuelOrder, f: OrderFilter) => f === 'ALL' || o.status === f;
type OrderAction = { id: string; kind: 'reject' | 'cancel' | 'amend' };

function AmendForm({ order, onDone, onCancel }: { order: FuelOrder; onDone: () => Promise<void>; onCancel: () => void }) {
  const [litres, setLitres] = useState(String(order.quantityLitres));
  const [destination, setDestination] = useState(order.destination ?? '');
  const [costCentre, setCostCentre] = useState(order.costCentre ?? '');
  const act = useAction();

  const submit = () => act.run(async () => {
    const payload: { quantityLitres?: number; destination?: string; costCentre?: string } = {};
    if (Number(litres) !== Number(order.quantityLitres)) payload.quantityLitres = Number(litres);
    if (destination.trim() !== (order.destination ?? '')) payload.destination = destination.trim();
    if (costCentre.trim() !== (order.costCentre ?? '')) payload.costCentre = costCentre.trim();
    if (Object.keys(payload).length === 0) throw new Error('Change at least one field to amend the order.');
    await api.amendOrder(order.id, payload);
    await onDone();
  });

  return (
    <form className="form-row" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      <Field label="Litres" type="number" step="0.1" min="1" value={litres} onChange={setLitres} required />
      <Field label="Destination" value={destination} onChange={setDestination} />
      <Field label="Cost centre" value={costCentre} onChange={setCostCentre} />
      <button type="submit" className="btn-ok" disabled={act.busy}>{act.busy ? 'Saving…' : 'Save amendment'}</button>
      <button type="button" className="mini-btn" onClick={onCancel} disabled={act.busy}>Back</button>
      <small className="muted" style={{ flexBasis: '100%' }}>The order is re-priced at the customer&apos;s contract price and checked against the vehicle&apos;s tank.</small>
      {act.error && <div className="error inline" style={{ flexBasis: '100%' }}>{act.error}</div>}
    </form>
  );
}

export function OrderManagement({ orders, loaded, reload, go }: { orders: FuelOrder[]; loaded: boolean; reload: () => Promise<void>; go: OmcGo }) {
  const [filter, setFilter] = useState<OrderFilter>('ALL');
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState('');
  const [action, setAction] = useState<OrderAction | null>(null);
  const [issued, setIssued] = useState<OtpResponse | null>(null);
  const act = useAction();
  const [info, setInfo] = useState('');

  const shown = useMemo(
    () => orders.filter((o) => orderInFilter(o, filter) && matches(query, o.number, o.customerName, o.vehicleReg, o.driverName)),
    [orders, filter, query],
  );
  const pendingCount = orders.filter((o) => o.status === 'PENDING_APPROVAL').length;

  // only orders waiting for the supplier can be approved in bulk, and only those in the current filter and search
  const approvable = shown.filter((o) => o.status === 'PENDING_APPROVAL');
  const sel = useSelection(approvable.map((o) => o.id));
  const [confirming, setConfirming] = useState<'selected' | 'all' | null>(null);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulk, setBulk] = useState<BulkResultData<OtpResponse> | null>(null);
  const toApprove = confirming === 'all' ? approvable : approvable.filter((o) => sel.has(o.id));

  const approveMany = async (list: FuelOrder[]) => {
    setConfirming(null);
    setBulkBusy(true);
    setInfo('');
    setIssued(null);
    act.clear();
    try {
      setBulk(await runBulk(list, (o) => o.number, (o) => api.approve(o.id)));
      sel.clear();
    } finally {
      await reload();
      setBulkBusy(false);
    }
  };

  const done = async (message: string) => {
    setAction(null);
    await reload();
    act.clear();
    setInfo(message);
  };
  const approve = (o: FuelOrder) => act.run(async () => {
    setInfo('');
    setIssued(await api.approve(o.id));
    setAction(null);
    await reload();
    return `${o.number} approved.`;
  });

  const exportSpec = (): ExportSpec => {
    const currency = sharedCurrency(shown.map((o) => currencyOf(o.customerName)));
    const amountType = currency ? 'money' : 'number';
    const valueOf = (o: FuelOrder) => Number(o.quantityLitres) * Number(o.unitPriceSnapshot);
    return {
      title: 'Order management',
      subtitle: `${ORDER_FILTERS.find(([k]) => k === filter)?.[1] ?? 'All'} orders${query ? ` matching “${query}”` : ''} · ${shown.length} of ${orders.length}`,
      filename: 'orders',
      currency: currency ?? undefined,
      columns: [
        { header: 'Order' }, { header: 'Customer' }, { header: 'Currency' }, { header: 'Vehicle' }, { header: 'Driver' }, { header: 'Site' }, { header: 'Product' },
        { header: 'Litres', type: 'litres' }, { header: 'Unit price', type: amountType }, { header: 'Value', type: amountType },
        { header: 'Status' }, { header: 'Created', type: 'datetime' },
      ],
      rows: shown.map((o) => [o.number, o.customerName, currencyOf(o.customerName), o.vehicleReg, o.driverName, o.siteName, o.fuelProduct, Number(o.quantityLitres),
        Number(o.unitPriceSnapshot), valueOf(o), lower(o.status), o.createdAt]),
      totals: ['Total', '', '', '', '', '', '', sumOf(shown.map((o) => Number(o.quantityLitres))), '',
        currency ? sumOf(shown.map(valueOf)) : '', '', ''],
    };
  };

  return (
    <>
      <PageHead icon="orders" title="Order Management" sub="Review, approve, reject, amend and cancel orders for every customer" />
      <Notice error={act.error} ok={act.ok} />
      {info && <div className="notice-ok">{info}</div>}
      {issued && (
        <OneTimeBox title={`${issued.orderNumber} approved`} secretLabel="Authorization code" secret={issued.otp} note={issued.note}
          onDismiss={() => setIssued(null)} />
      )}
      {bulk && (
        <BulkResultBox title="Bulk approval" result={bulk} detail={(r) => r.otp} detailLabel="Authorization code"
          note={bulk.done.some((d) => d.result.otp) ? 'Codes are shown once only — they cannot be retrieved again.' : undefined}
          onDismiss={() => setBulk(null)} />
      )}
      <section className="card">
        <div className="card-head">
          <h2>All orders</h2>
          <div className="head-tools">
            <small className="muted">{pendingCount} awaiting your approval</small>
            <ExportMenu build={exportSpec} disabled={shown.length === 0} />
          </div>
        </div>
        <FilterBar options={ORDER_FILTERS} value={filter} onChange={setFilter} count={(k) => orders.filter((o) => orderInFilter(o, k)).length}
          query={query} onQuery={setQuery} placeholder="Order, customer, vehicle…" />
        {approvable.length > 0 && (
          <SelectionBar selected={sel.selected.length} total={approvable.length} noun="awaiting approval" onClear={sel.clear}>
            {confirming ? (
              <span className="select-confirm">
                Approve {toApprove.length} order{toApprove.length === 1 ? '' : 's'} and issue {toApprove.length === 1 ? 'its' : 'their'} authorization code{toApprove.length === 1 ? '' : 's'}?
                <button type="button" className="btn-ok" disabled={bulkBusy || toApprove.length === 0} onClick={() => void approveMany(toApprove)}>Confirm approval</button>
                <button type="button" className="mini-btn" onClick={() => setConfirming(null)}>Back</button>
              </span>
            ) : (
              <>
                <button type="button" className="mini-btn" disabled={bulkBusy} onClick={sel.toggleAll}>{sel.allSelected ? 'Deselect all' : 'Select all'}</button>
                <button type="button" className="btn-ok" disabled={bulkBusy || act.busy || sel.selected.length === 0} onClick={() => setConfirming('selected')}>
                  {bulkBusy ? 'Approving…' : `Approve selected (${sel.selected.length})`}
                </button>
                <button type="button" className="btn-ok" disabled={bulkBusy || act.busy} onClick={() => setConfirming('all')}>Approve all ({approvable.length})</button>
              </>
            )}
          </SelectionBar>
        )}
        <div className="tbl-scroll">
          <table>
            <thead>
              <tr>
                <th className="select-col">
                  <SelectBox label="Select all orders awaiting approval" checked={sel.allSelected} indeterminate={sel.someSelected}
                    disabled={approvable.length === 0 || bulkBusy} onChange={sel.toggleAll} />
                </th>
                <th>Order</th><th>Customer</th><th>Vehicle · driver</th><th>Site</th><th>Litres</th><th>Price</th><th>Status</th><th>Created</th><th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {!loaded && <tr><td colSpan={10} className="empty">Loading orders…</td></tr>}
              {loaded && shown.length === 0 && <tr><td colSpan={10} className="empty">{orders.length === 0 ? 'No orders yet.' : 'No orders match this filter.'}</td></tr>}
              {loaded && shown.map((o) => {
                const pendingSupplier = o.status === 'PENDING_APPROVAL';
                const amendable = pendingSupplier || o.status === 'PENDING_CUSTOMER_APPROVAL';
                const cancellable = amendable || o.status === 'AUTHORIZED';
                const mine = action?.id === o.id ? action.kind : null;
                const expanded = open === o.id || mine !== null;
                return (
                  <Fragment key={o.id}>
                    <tr className={pendingSupplier && sel.has(o.id) ? 'picked' : undefined}>
                      <td className="select-col">
                        {pendingSupplier && <SelectBox label={`Select ${o.number}`} checked={sel.has(o.id)} disabled={bulkBusy} onChange={() => sel.toggle(o.id)} />}
                      </td>
                      <td><b>{o.number}</b><br /><small>{o.fuelProduct}</small></td>
                      <td>{o.customerName}</td>
                      <td>{o.vehicleReg}<br /><small>{o.driverName}</small></td>
                      <td>{o.siteName}</td>
                      <td>{num(o.quantityLitres)}</td>
                      <td>{moneyFor(Number(o.unitPriceSnapshot), o.customerName)} / L<br /><small>{moneyFor(Number(o.quantityLitres) * Number(o.unitPriceSnapshot), o.customerName)}</small></td>
                      <td><StatusChip status={o.status} />{o.rejectionReason && <small className={o.status === 'REJECTED' ? 'reason' : 'muted'} style={{ display: 'block', marginTop: '0.3rem' }}>{o.rejectionReason}</small>}</td>
                      <td>{when(o.createdAt)}</td>
                      <td>
                        <div className="inline-actions row-actions">
                          {pendingSupplier && <button className="btn-ok" disabled={act.busy} onClick={() => void approve(o)}>Approve</button>}
                          {pendingSupplier && <button className="btn-ghost" onClick={() => setAction({ id: o.id, kind: 'reject' })}>Reject</button>}
                          {amendable && <button className="mini-btn" onClick={() => setAction({ id: o.id, kind: 'amend' })}>Amend</button>}
                          {cancellable && <button className="btn-ghost" onClick={() => setAction({ id: o.id, kind: 'cancel' })}>Cancel</button>}
                          <button className="mini-btn" onClick={() => { setOpen(open === o.id ? '' : o.id); if (mine) setAction(null); }}>
                            {expanded ? 'Hide' : 'History'}
                          </button>
                        </div>
                      </td>
                    </tr>
                    {expanded && (
                      <tr>
                        <td colSpan={10}>
                          {mine === 'reject' && (
                            <ReasonForm label="Reason for rejecting" confirm="Confirm rejection" danger onCancel={() => setAction(null)}
                              onSubmit={async (reason) => { await api.reject(o.id, reason); await done(`${o.number} rejected.`); }} />
                          )}
                          {mine === 'cancel' && (
                            <>
                              {o.status === 'AUTHORIZED' && (
                                <div className="notice-warn">This order is authorized: cancelling it <b>revokes its OTP</b>, so the driver can no longer fuel.
                                  {' '}You can check the code in <a className="link" onClick={() => go('omc-otp')}>OTP Management</a>.</div>
                              )}
                              <ReasonForm label="Reason for cancelling" confirm="Confirm cancellation" danger onCancel={() => setAction(null)}
                                onSubmit={async (reason) => { await api.cancelOrder(o.id, reason); await done(`${o.number} cancelled.`); }} />
                            </>
                          )}
                          {mine === 'amend' && (
                            <AmendForm order={o} onCancel={() => setAction(null)} onDone={async () => { await done(`${o.number} amended and re-priced.`); }} />
                          )}
                          {o.status === 'AUTHORIZED' && !mine && (
                            <small className="muted">Authorized — manage the code in <a className="link" onClick={() => go('omc-otp')}>OTP Management</a>. </small>
                          )}
                          <OrderTimeline key={o.status} id={o.id} />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}

/* ── OTP Management ───────────────────────────────────────────── */
type OtpFilter = 'ALL' | OtpStatus;
const OTP_FILTERS: [OtpFilter, string][] = [['ALL', 'All'], ['ACTIVE', 'Active'], ['REDEEMED', 'Redeemed'], ['EXPIRED', 'Expired'], ['REVOKED', 'Revoked']];

export function OtpManagement({ orders }: { orders: FuelOrder[] }) {
  const otps = useLoad(api.listOtps);
  const [info, setInfo] = useState('');
  const [filter, setFilter] = useState<OtpFilter>('ALL');
  const [query, setQuery] = useState('');
  const [action, setAction] = useState<{ id: string; kind: 'revoke' | 'regenerate' } | null>(null);
  const [issued, setIssued] = useState<OtpResponse | null>(null);
  const all = otps.data ?? [];
  const count = (s: OtpStatus) => all.filter((o) => o.status === s).length;
  // a new code can only be issued while the order itself is still authorized
  const orderAuthorized = (o: OtpView) => orders.find((x) => x.id === o.orderId)?.status === 'AUTHORIZED';
  const shown = all
    .filter((o) => (filter === 'ALL' || o.status === filter) && matches(query, o.orderNumber, o.customer, o.vehicleReg, o.driverName, o.siteName))
    .sort((a, b) => b.orderNumber.localeCompare(a.orderNumber, undefined, { numeric: true }));

  const exportSpec = (): ExportSpec => ({
    title: 'OTP authorizations',
    subtitle: `${OTP_FILTERS.find(([k]) => k === filter)?.[1]} codes · ${shown.length} of ${all.length} (codes themselves are never exported)`,
    filename: 'otp-authorizations',
    columns: [
      { header: 'Order' }, { header: 'Customer' }, { header: 'Vehicle' }, { header: 'Driver' }, { header: 'Site' }, { header: 'Product' },
      { header: 'Max litres', type: 'litres' }, { header: 'Status' }, { header: 'Expires', type: 'datetime' }, { header: 'Redeemed', type: 'datetime' },
    ],
    rows: shown.map((o) => [o.orderNumber, o.customer, o.vehicleReg, o.driverName, o.siteName, o.fuelProduct, Number(o.maxVolumeLitres),
      lower(o.status), o.expiresAt, o.redeemedAt]),
  });

  const finish = async (message: string) => {
    setAction(null);
    await otps.reload();
    setInfo(message);
  };

  return (
    <>
      <PageHead icon="key" title="OTP Management" sub="Issue, revoke, regenerate and monitor fuel authorization codes">
        <button className="cta" onClick={() => void otps.reload()}><Ic n="refresh" s={13} /> Refresh</button>
      </PageHead>
      <Notice error={otps.error} />
      {info && <div className="notice-ok">{info}</div>}
      {issued && (
        <OneTimeBox title={`New code for ${issued.orderNumber}`} secretLabel="Authorization code" secret={issued.otp} note={issued.note}
          onDismiss={() => setIssued(null)} />
      )}
      <StatStrip items={[
        { icon: 'key', label: 'Active', value: String(count('ACTIVE')), sub: 'Can be redeemed at a pump now' },
        { icon: 'check', label: 'Redeemed', value: String(count('REDEEMED')), sub: 'Fuel was dispensed' },
        { icon: 'clock', label: 'Expired', value: String(count('EXPIRED')), sub: 'Not used in time' },
        { icon: 'ban', label: 'Revoked', value: String(count('REVOKED')), sub: 'Cancelled by staff' },
      ]} />
      <section className="card" style={{ marginTop: '0.85rem' }}>
        <div className="card-head">
          <h2>Authorizations</h2>
          <div className="head-tools"><small className="muted">The code itself is never displayed after it is issued</small><ExportMenu build={exportSpec} disabled={shown.length === 0} /></div>
        </div>
        <FilterBar options={OTP_FILTERS} value={filter} onChange={setFilter}
          count={(k) => (k === 'ALL' ? all.length : count(k))} query={query} onQuery={setQuery} placeholder="Order, customer, vehicle…" />
        <div className="tbl-scroll">
          <table>
            <thead><tr><th>Order</th><th>Customer</th><th>Vehicle · driver</th><th>Site · product</th><th>Max litres</th><th>Status</th><th>Expires</th><th>Redeemed</th><th>Actions</th></tr></thead>
            <tbody>
              <Rows state={otps} cols={9} empty="No OTP authorizations yet — they appear when an order is approved.">
                {() => (shown.length === 0 ? <tr><td colSpan={9} className="empty">No codes match this filter.</td></tr> : shown.map((o: OtpView) => {
                  const mine = action?.id === o.id ? action.kind : null;
                  return (
                    <Fragment key={o.id}>
                      <tr>
                        <td><b>{o.orderNumber}</b></td>
                        <td>{o.customer}</td>
                        <td>{o.vehicleReg}<br /><small>{o.driverName}</small></td>
                        <td>{o.siteName}<br /><small>{o.fuelProduct}</small></td>
                        <td>{num(o.maxVolumeLitres)} L</td>
                        <td><StatusChip status={o.status} /></td>
                        <td>{when(o.expiresAt)}</td>
                        <td>{when(o.redeemedAt)}</td>
                        <td>
                          <div className="inline-actions row-actions">
                            {o.status === 'ACTIVE' && <button className="btn-ghost" onClick={() => setAction({ id: o.id, kind: 'revoke' })}>Revoke</button>}
                            {o.status !== 'REDEEMED' && orderAuthorized(o) && <button className="mini-btn" onClick={() => setAction({ id: o.id, kind: 'regenerate' })}>Regenerate</button>}
                            {o.status !== 'REDEEMED' && o.status !== 'ACTIVE' && !orderAuthorized(o) && <small className="muted">order no longer authorized</small>}
                          </div>
                        </td>
                      </tr>
                      {mine && (
                        <tr>
                          <td colSpan={9}>
                            {mine === 'revoke' && (
                              <ReasonForm label={`Reason for revoking ${o.orderNumber}`} confirm="Revoke code" danger onCancel={() => setAction(null)}
                                onSubmit={async (reason) => { await api.revokeOtp(o.id, reason); setIssued(null); await finish(`Code for ${o.orderNumber} revoked.`); }} />
                            )}
                            {mine === 'regenerate' && (
                              <>
                                <small className="muted">Issues a brand-new code for {o.orderNumber}; any earlier code stops working.</small>
                                <ReasonForm label="Reason for regenerating" confirm="Regenerate code" onCancel={() => setAction(null)}
                                  onSubmit={async (reason) => { setIssued(await api.regenerateOtp(o.id, reason)); await finish(''); }} />
                              </>
                            )}
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                }))}
              </Rows>
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}

/* ── Driver Management ────────────────────────────────────────── */
type DriverFilter = 'ALL' | 'UNVERIFIED' | 'SUSPENDED';
const DRIVER_FILTERS: [DriverFilter, string][] = [['ALL', 'All'], ['UNVERIFIED', 'Unverified'], ['SUSPENDED', 'Suspended']];
interface DriverBulk { title: string; text: string; list: Driver[]; run: (d: Driver, reason: string) => Promise<Driver>; needsReason?: boolean }

export function DriverManagement({ drivers, loaded, reload }: { drivers: Driver[]; loaded: boolean; reload: () => Promise<void> }) {
  const otps = useLoad(api.listOtps);
  const act = useAction();
  const [filter, setFilter] = useState<DriverFilter>('ALL');
  const [query, setQuery] = useState('');
  const [suspending, setSuspending] = useState('');
  const inFilter = (d: Driver, f: DriverFilter) => f === 'ALL' || (f === 'UNVERIFIED' ? !d.verified : d.accessSuspended);
  const shown = drivers
    .filter((d) => inFilter(d, filter) && matches(query, d.name, d.organization, d.vehicleReg, d.licenseNo, d.phone))
    .sort((a, b) => a.organization.localeCompare(b.organization) || a.name.localeCompare(b.name));
  const activeCodes = (d: Driver) =>
    (otps.data ?? []).filter((o) => o.status === 'ACTIVE' && o.driverName === d.name && o.customer === d.organization).length;

  const change = (fn: () => Promise<unknown>, message: string) => act.run(async () => {
    await fn();
    setSuspending('');
    await Promise.all([reload(), otps.reload()]);
    return message;
  });

  // bulk actions: each one only touches the selected drivers it applies to (e.g. "Verify" skips drivers already verified)
  const sel = useSelection(shown.map((d) => d.id));
  const picked = shown.filter((d) => sel.has(d.id));
  const toVerify = picked.filter((d) => !d.verified);
  const toUnverify = picked.filter((d) => d.verified);
  const toSuspend = picked.filter((d) => !d.accessSuspended);
  const toRestore = picked.filter((d) => d.accessSuspended);
  const allUnverified = shown.filter((d) => !d.verified);
  const [pending, setPending] = useState<DriverBulk | null>(null);
  const [bulkBusy, setBulkBusy] = useState(false);
  const [bulk, setBulk] = useState<{ title: string; data: BulkResultData<Driver> } | null>(null);

  const runMany = async (b: DriverBulk, reason = '') => {
    setPending(null);
    setBulkBusy(true);
    act.clear();
    try {
      setBulk({ title: b.title, data: await runBulk(b.list, (d) => `${d.name} · ${d.organization}`, (d) => b.run(d, reason)) });
      sel.clear();
    } finally {
      await Promise.all([reload(), otps.reload()]);
      setBulkBusy(false);
    }
  };
  const count = (n: number) => `${n} driver${n === 1 ? '' : 's'}`;
  const ask = (b: Omit<DriverBulk, 'text'>, verb: string) => setPending({ ...b, text: `${verb} ${count(b.list.length)}` });

  const exportSpec = (): ExportSpec => ({
    title: 'Driver register',
    subtitle: `${DRIVER_FILTERS.find(([k]) => k === filter)?.[1]} drivers · ${shown.length} of ${drivers.length} (PINs are never exported)`,
    filename: 'drivers',
    columns: [
      { header: 'Customer' }, { header: 'Driver' }, { header: 'Phone' }, { header: 'Licence' }, { header: 'Vehicle' }, { header: 'Verified' },
      { header: 'Verified by' }, { header: 'Verified at', type: 'datetime' }, { header: 'OTP access' }, { header: 'Suspension reason' },
      { header: 'Active codes', type: 'number' },
    ],
    rows: shown.map((d) => [d.organization, d.name, d.phone, d.licenseNo, d.vehicleReg, d.verified ? 'Yes' : 'No', d.verifiedBy, d.verifiedAt,
      d.accessSuspended ? 'Suspended' : 'Active', d.suspendedReason, activeCodes(d)]),
  });

  return (
    <>
      <PageHead icon="userCheck" title="Driver Management" sub="Verify drivers, see their vehicles and control OTP access" />
      <div className="notice-info">
        Drivers and their PINs are created and reset by each customer; PINs are never visible to the OMC. Vehicle assignment is also the customer&apos;s action,
        so the assigned vehicle is shown here read-only. A suspended driver cannot be ordered for and cannot redeem a code.
      </div>
      <Notice error={act.error || otps.error} ok={act.ok} />
      {bulk && <BulkResultBox title={bulk.title} result={bulk.data} onDismiss={() => setBulk(null)} />}
      <section className="card">
        <div className="card-head">
          <h2>Drivers across all customers</h2>
          <div className="head-tools"><small className="muted">{drivers.length} registered</small><ExportMenu build={exportSpec} disabled={shown.length === 0} /></div>
        </div>
        <FilterBar options={DRIVER_FILTERS} value={filter} onChange={setFilter} count={(k) => drivers.filter((d) => inFilter(d, k)).length}
          query={query} onQuery={setQuery} placeholder="Driver, customer, vehicle, licence…" />
        {shown.length > 0 && (
          <SelectionBar selected={sel.selected.length} total={shown.length} noun="drivers" onClear={sel.clear}>
            {pending ? (
              <span className="select-confirm">
                {pending.text}?
                {!pending.needsReason && (
                  <button type="button" className="btn-ok" disabled={bulkBusy || pending.list.length === 0} onClick={() => void runMany(pending)}>Confirm</button>
                )}
                <button type="button" className="mini-btn" onClick={() => setPending(null)}>Back</button>
              </span>
            ) : (
              <>
                <button type="button" className="mini-btn" disabled={bulkBusy} onClick={sel.toggleAll}>{sel.allSelected ? 'Deselect all' : 'Select all'}</button>
                <button type="button" className="btn-ok" disabled={bulkBusy || toVerify.length === 0}
                  onClick={() => ask({ title: 'Bulk verify', list: toVerify, run: (d) => api.verifyDriver(d.id) }, 'Verify')}>
                  Verify selected ({toVerify.length})
                </button>
                <button type="button" className="btn-ok" disabled={bulkBusy || allUnverified.length === 0}
                  onClick={() => ask({ title: 'Verify all unverified', list: allUnverified, run: (d) => api.verifyDriver(d.id) }, 'Verify all unverified:')}>
                  Verify all unverified ({allUnverified.length})
                </button>
                <button type="button" className="mini-btn" disabled={bulkBusy || toUnverify.length === 0}
                  onClick={() => ask({ title: 'Bulk unverify', list: toUnverify, run: (d) => api.unverifyDriver(d.id) }, 'Unverify')}>
                  Unverify selected ({toUnverify.length})
                </button>
                <button type="button" className="btn-ghost" disabled={bulkBusy || toSuspend.length === 0}
                  onClick={() => ask({ title: 'Bulk suspend', list: toSuspend, needsReason: true, run: (d, reason) => api.suspendDriver(d.id, reason) }, 'Suspend')}>
                  Suspend selected ({toSuspend.length})
                </button>
                <button type="button" className="btn-ok" disabled={bulkBusy || toRestore.length === 0}
                  onClick={() => ask({ title: 'Bulk restore', list: toRestore, run: (d) => api.restoreDriver(d.id) }, 'Restore access for')}>
                  Restore selected ({toRestore.length})
                </button>
              </>
            )}
          </SelectionBar>
        )}
        {pending?.needsReason && (
          <ReasonForm label={`Reason for suspending ${count(pending.list.length)}`} confirm="Suspend access" danger onCancel={() => setPending(null)}
            onSubmit={async (reason) => { await runMany(pending, reason); }} />
        )}
        <div className="tbl-scroll">
          <table>
            <thead>
              <tr>
                <th className="select-col">
                  <SelectBox label="Select all drivers" checked={sel.allSelected} indeterminate={sel.someSelected} disabled={shown.length === 0 || bulkBusy} onChange={sel.toggleAll} />
                </th>
                <th>Customer</th><th>Driver</th><th>Licence</th><th>Vehicle</th><th>Verification</th><th>OTP access</th><th>Active codes</th><th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {!loaded && <tr><td colSpan={9} className="empty">Loading drivers…</td></tr>}
              {loaded && shown.length === 0 && <tr><td colSpan={9} className="empty">{drivers.length === 0 ? 'No drivers have been registered by customers yet.' : 'No drivers match this filter.'}</td></tr>}
              {loaded && shown.map((d) => (
                <Fragment key={d.id}>
                  <tr className={sel.has(d.id) ? 'picked' : undefined}>
                    <td className="select-col"><SelectBox label={`Select ${d.name}`} checked={sel.has(d.id)} disabled={bulkBusy} onChange={() => sel.toggle(d.id)} /></td>
                    <td>{d.organization}</td>
                    <td><b>{d.name}</b>{!d.active && <> <span className="chip chip-cancelled">inactive</span></>}<br /><small>{d.phone ?? '—'}</small></td>
                    <td>{d.licenseNo ?? '—'}</td>
                    <td>{d.vehicleReg ?? <small className="muted">not assigned</small>}</td>
                    <td>
                      {d.verified ? <span className="chip chip-valid">verified</span> : <span className="chip chip-pending">unverified</span>}
                      {d.verified && <><br /><small>{d.verifiedBy} · {when(d.verifiedAt)}</small></>}
                    </td>
                    <td>
                      {d.accessSuspended ? <span className="chip chip-critical">suspended</span> : <span className="chip chip-active">active</span>}
                      {d.accessSuspended && d.suspendedReason && <small className="reason">{d.suspendedReason}</small>}
                    </td>
                    <td>{otps.loading ? '…' : activeCodes(d)}</td>
                    <td>
                      <div className="inline-actions row-actions">
                        {d.verified
                          ? <button className="mini-btn" disabled={act.busy} onClick={() => void change(() => api.unverifyDriver(d.id), `${d.name} marked unverified.`)}>Unverify</button>
                          : <button className="btn-ok" disabled={act.busy} onClick={() => void change(() => api.verifyDriver(d.id), `${d.name} verified.`)}>Verify</button>}
                        {d.accessSuspended
                          ? <button className="btn-ok" disabled={act.busy} onClick={() => void change(() => api.restoreDriver(d.id), `${d.name}'s access restored.`)}>Restore</button>
                          : <button className="btn-ghost" onClick={() => setSuspending(d.id)}>Suspend</button>}
                      </div>
                    </td>
                  </tr>
                  {suspending === d.id && (
                    <tr>
                      <td colSpan={9}>
                        <ReasonForm label={`Reason for suspending ${d.name}`} confirm="Suspend access" danger onCancel={() => setSuspending('')}
                          onSubmit={async (reason) => { await change(() => api.suspendDriver(d.id, reason), `${d.name} suspended.`); }} />
                      </td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}

/* ── Vehicle Management ───────────────────────────────────────── */
const FUEL_TYPES: [string, string][] = [['DIESEL', 'Diesel'], ['PETROL', 'Petrol']];
const validTank = (v: string) => Number.isFinite(Number(v)) && Number(v) >= 1 && Number(v) <= 100000;
const TYPE_OPTIONS: [string, string][] = [['', 'Select type'], ...VEHICLE_TYPES.map((t): [string, string] => [t, t])];
const YEAR_HINT = `Year must be between ${MIN_VEHICLE_YEAR} and ${maxVehicleYear()}.`;

function RegisterVehicle({ customers, onDone }: { customers: Organization[]; onDone: () => Promise<void> }) {
  const act = useAction();
  const [customerName, setCustomerName] = useState('');
  const [form, setForm] = useState({ registration: '', description: '', vehicleType: '', model: '', year: '', fuelType: 'DIESEL', tank: '' });
  const set = (k: keyof typeof form) => (v: string) => setForm((f) => ({ ...f, [k]: v }));
  const customer = customerName || customers[0]?.name || '';

  const submit = () => act.run(async () => {
    await api.registerVehicle({
      registration: form.registration.trim(), description: form.description.trim(),
      vehicleType: form.vehicleType, model: form.model.trim(), modelYear: form.year ? Number(form.year) : undefined,
      fuelType: form.fuelType === 'PETROL' ? 'PETROL' : 'DIESEL', tankCapacityLitres: Number(form.tank), customerName: customer,
    });
    setForm({ registration: '', description: '', vehicleType: '', model: '', year: '', fuelType: form.fuelType, tank: '' });
    await onDone();
    return `${form.registration.trim()} registered for ${customer}.`;
  });

  return (
    <section className="card" style={{ marginBottom: '0.85rem' }}>
      <div className="card-head"><h2>Register a vehicle</h2><small className="muted">On behalf of a customer</small></div>
      <Notice error={act.error} ok={act.ok} />
      <form className="form-row" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
        <Select label="Customer" value={customer} onChange={setCustomerName} options={customers.map((c) => c.name)} />
        <Field label="Registration" value={form.registration} onChange={set('registration')} required />
        <Select label="Vehicle type" value={form.vehicleType} onChange={set('vehicleType')} options={TYPE_OPTIONS} />
        <Field label="Model" value={form.model} onChange={set('model')} placeholder="e.g. Hilux" />
        <Field label="Year" value={form.year} onChange={(v) => set('year')(v.replace(/\D/g, '').slice(0, 4))} placeholder={String(maxVehicleYear() - 1)} />
        <Field label="Description" value={form.description} onChange={set('description')} placeholder="e.g. Isuzu FTR 850" required />
        <Select label="Fuel type" value={form.fuelType} onChange={set('fuelType')} options={FUEL_TYPES} />
        <Field label="Tank capacity (L)" type="number" min="1" max="100000" value={form.tank} onChange={set('tank')} required />
        <button type="submit" className="cta green" disabled={act.busy || !customer || !validTank(form.tank) || !validYear(form.year)}>Register vehicle</button>
      </form>
      {form.tank !== '' && !validTank(form.tank) && <small className="reason">Tank capacity must be between 1 and 100,000 litres.</small>}
      {!validYear(form.year) && <small className="reason">{YEAR_HINT}</small>}
    </section>
  );
}

function VehicleEdit({ vehicle, onDone, onCancel }: { vehicle: Vehicle; onDone: () => Promise<void>; onCancel: () => void }) {
  const act = useAction();
  const [description, setDescription] = useState(vehicle.description ?? '');
  const [vehicleType, setVehicleType] = useState(vehicle.vehicleType ?? '');
  const [model, setModel] = useState(vehicle.model ?? '');
  const [year, setYear] = useState(vehicle.modelYear ? String(vehicle.modelYear) : '');
  const [tank, setTank] = useState(String(vehicle.tankCapacityLitres));
  const typeOptions = vehicleType && !VEHICLE_TYPES.includes(vehicleType) ? [...TYPE_OPTIONS, [vehicleType, vehicleType] as [string, string]] : TYPE_OPTIONS;
  const submit = () => act.run(async () => {
    await api.updateVehicle(vehicle.id, {
      description: description.trim(), tankCapacityLitres: Number(tank),
      vehicleType, model: model.trim(), modelYear: year ? Number(year) : undefined,
    });
    await onDone();
  });
  return (
    <form className="form-row" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
      <Field label="Description" value={description} onChange={setDescription} required />
      <Select label="Vehicle type" value={vehicleType} onChange={setVehicleType} options={typeOptions} />
      <Field label="Model" value={model} onChange={setModel} />
      <Field label="Year" value={year} onChange={(v) => setYear(v.replace(/\D/g, '').slice(0, 4))} />
      <Field label="Tank capacity (L)" type="number" min="1" max="100000" value={tank} onChange={setTank} required />
      <button type="submit" className="btn-ok" disabled={act.busy || !validTank(tank) || !validYear(year) || !description.trim()}>{act.busy ? 'Saving…' : 'Save changes'}</button>
      <button type="button" className="mini-btn" onClick={onCancel} disabled={act.busy}>Back</button>
      {!validTank(tank) && <small className="reason" style={{ flexBasis: '100%' }}>Tank capacity must be between 1 and 100,000 litres.</small>}
      {!validYear(year) && <small className="reason" style={{ flexBasis: '100%' }}>{YEAR_HINT}</small>}
      {act.error && <div className="error inline" style={{ flexBasis: '100%' }}>{act.error}</div>}
    </form>
  );
}

function FuellingHistory({ vehicle, orders, onClose }: { vehicle: Vehicle; orders: FuelOrder[]; onClose: () => void }) {
  const panel = useRef<HTMLElement>(null);
  // the panel opens below a long table: bring it into view so its export menu is not pushed off screen
  useEffect(() => { panel.current?.scrollIntoView({ block: 'start' }); }, []);
  const history = useLoad<FuelTransaction[]>(useMemo(() => () => api.vehicleFuelling(vehicle.id), [vehicle.id]));
  const rows = history.data ?? [];
  const orderNo = (id: string) => orders.find((o) => o.id === id)?.number ?? id.slice(0, 8);
  const currency = currencyOf(vehicle.organization);
  const exportSpec = (): ExportSpec => ({
    title: `Fuelling history — ${vehicle.registration}`,
    subtitle: `${vehicle.organization} · latest ${rows.length} dispenses`,
    filename: `fuelling-${slug(vehicle.registration)}`,
    currency,
    columns: [
      { header: 'Date', type: 'datetime' }, { header: 'Order' }, { header: 'Driver' }, { header: 'Site' }, { header: 'Litres', type: 'litres' },
      { header: 'Amount', type: 'money' }, { header: 'Attendant' },
    ],
    rows: rows.map((t) => [t.dispensedAt, orderNo(t.orderId), t.driverName, t.siteName, Number(t.volumeLitres), Number(t.amount), t.attendantName]),
    totals: ['Total', '', '', '', sumOf(rows.map((t) => Number(t.volumeLitres))), sumOf(rows.map((t) => Number(t.amount))), ''],
  });
  return (
    <section ref={panel} className="card tbl-scroll" style={{ marginTop: '0.85rem' }}>
      <div className="card-head">
        <h2>Fuelling history · {vehicle.registration}</h2>
        <div className="head-tools"><ExportMenu build={exportSpec} disabled={rows.length === 0} /><button className="mini-btn" onClick={onClose}>Close</button></div>
      </div>
      <table>
        <thead><tr><th>Date</th><th>Order</th><th>Driver</th><th>Site</th><th>Litres</th><th>Amount</th><th>Attendant</th></tr></thead>
        <tbody>
          <Rows state={history} cols={7} empty="This vehicle has not been fuelled yet.">
            {(list) => list.map((t) => (
              <tr key={t.id}>
                <td>{when(t.dispensedAt)}</td><td>{orderNo(t.orderId)}</td><td>{t.driverName}</td><td>{t.siteName}</td>
                <td>{num(t.volumeLitres)} L</td><td>{money(Number(t.amount), currency)}</td><td>{t.attendantName}</td>
              </tr>
            ))}
          </Rows>
        </tbody>
      </table>
    </section>
  );
}

export function VehicleManagement({ vehicles, orders, transactions, loaded, reload }: {
  vehicles: Vehicle[]; orders: FuelOrder[]; transactions: FuelTransaction[]; loaded: boolean; reload: () => Promise<void>;
}) {
  const orgs = useLoad(api.organizations);
  const [query, setQuery] = useState('');
  const [editing, setEditing] = useState('');
  const [historyFor, setHistoryFor] = useState('');
  const customers = (orgs.data ?? []).filter((o) => o.type === 'CUSTOMER');
  const stats = (v: Vehicle) => {
    const mine = orders.filter((o) => o.vehicleReg === v.registration && o.customerName === v.organization);
    const ids = new Set(mine.map((o) => o.id));
    return { orders: mine.length, litres: sumOf(transactions.filter((t) => ids.has(t.orderId)).map((t) => Number(t.volumeLitres))) };
  };
  const shown = vehicles
    .filter((v) => matches(query, v.registration, v.organization, v.description, v.vehicleType, v.model))
    .sort((a, b) => a.organization.localeCompare(b.organization) || a.registration.localeCompare(b.registration));
  const historyVehicle = vehicles.find((v) => v.id === historyFor);

  const exportSpec = (): ExportSpec => ({
    title: 'Vehicle register',
    subtitle: `${shown.length} of ${vehicles.length} vehicles across all customers`,
    filename: 'vehicles',
    columns: [
      { header: 'Customer' }, { header: 'Registration' }, { header: 'Type' }, { header: 'Model' }, { header: 'Year' },
      { header: 'Description' }, { header: 'Fuel' },
      { header: 'Tank (L)', type: 'litres' }, { header: 'Orders', type: 'number' }, { header: 'Litres drawn', type: 'litres' },
    ],
    rows: shown.map((v) => { const s = stats(v); return [v.organization, v.registration, v.vehicleType ?? '', v.model ?? '', v.modelYear ?? '', v.description, lower(v.fuelType), Number(v.tankCapacityLitres), s.orders, s.litres]; }),
    totals: ['Total', '', '', '', '', '', '', sumOf(shown.map((v) => Number(v.tankCapacityLitres))), sumOf(shown.map((v) => stats(v).orders)), sumOf(shown.map((v) => stats(v).litres))],
  });

  return (
    <>
      <PageHead icon="truck" title="Vehicle Management" sub="Register vehicles, set tank capacities and track fuelling history" />
      <Notice error={orgs.error} />
      <RegisterVehicle customers={customers} onDone={reload} />
      <section className="card">
        <div className="card-head">
          <h2>All vehicles</h2>
          <div className="head-tools">
            <label className="search-box"><Ic n="search" s={13} />
              <input type="search" value={query} placeholder="Registration, customer…" onChange={(e) => setQuery(e.target.value)} />
            </label>
            <ExportMenu build={exportSpec} disabled={shown.length === 0} />
          </div>
        </div>
        <div className="tbl-scroll">
          <table>
            <thead><tr><th>Customer</th><th>Registration</th><th>Type</th><th>Model</th><th>Year</th><th>Description</th><th>Fuel</th><th>Tank</th><th>Orders</th><th>Litres drawn</th><th>Actions</th></tr></thead>
            <tbody>
              {!loaded && <tr><td colSpan={11} className="empty">Loading vehicles…</td></tr>}
              {loaded && shown.length === 0 && <tr><td colSpan={11} className="empty">{vehicles.length === 0 ? 'No vehicles registered yet.' : 'No vehicles match your search.'}</td></tr>}
              {loaded && shown.map((v) => {
                const s = stats(v);
                return (
                  <Fragment key={v.id}>
                    <tr>
                      <td>{v.organization}</td><td><b>{v.registration}</b></td>
                      <td>{v.vehicleType ?? '—'}</td><td>{v.model ?? '—'}</td><td>{v.modelYear ?? '—'}</td>
                      <td>{v.description ?? '—'}</td><td>{lower(v.fuelType)}</td>
                      <td>{num(v.tankCapacityLitres, 0)} L</td><td>{s.orders}</td><td>{num(s.litres)} L</td>
                      <td>
                        <div className="inline-actions row-actions">
                          <button className="mini-btn" onClick={() => setEditing(editing === v.id ? '' : v.id)}>Edit</button>
                          <button className="mini-btn" onClick={() => setHistoryFor(historyFor === v.id ? '' : v.id)}>Fuelling history</button>
                        </div>
                      </td>
                    </tr>
                    {editing === v.id && (
                      <tr><td colSpan={11}><VehicleEdit vehicle={v} onCancel={() => setEditing('')} onDone={async () => { setEditing(''); await reload(); }} /></td></tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      </section>
      {historyVehicle && <FuellingHistory key={historyVehicle.id} vehicle={historyVehicle} orders={orders} onClose={() => setHistoryFor('')} />}
    </>
  );
}

/* ── Customer Management ──────────────────────────────────────── */
const TERMS = ['PREPAID', 'NET_7', 'NET_30', 'NET_60'];
const EMPTY_CUSTOMER = {
  name: '', country: 'ZA', currency: 'ZAR', adminName: '', contactEmail: '', contactPhone: '', creditLimit: '0', terms: 'NET_30', monthlyBudget: '0',
};

function RegisterCustomer({ onDone }: { onDone: () => Promise<void> }) {
  const act = useAction();
  const [form, setForm] = useState(EMPTY_CUSTOMER);
  const [created, setCreated] = useState<Registered | null>(null);
  const set = (k: keyof typeof form) => (v: string) => setForm((f) => ({ ...f, [k]: v }));
  const submit = () => act.run(async () => {
    setCreated(null);
    const result = await api.registerOrganization({
      ...form, type: 'CUSTOMER', creditLimit: Number(form.creditLimit), monthlyBudget: Number(form.monthlyBudget), contactPhone: form.contactPhone || null,
    });
    setCreated(result);
    setForm(EMPTY_CUSTOMER);
    await loadCurrencies();
    await onDone();
  });
  return (
    <section className="card">
      <div className="card-head"><h2>Register customer</h2><small className="muted">Creates the company and its administrator login</small></div>
      <Notice error={act.error} />
      {created && (
        <OneTimeBox title={`${created.organization.name} registered`} secretLabel="Temporary password" secret={created.temporaryPassword}
          note={`Login: ${created.loginEmail}. Hand these to the customer's administrator now.`} onDismiss={() => setCreated(null)} />
      )}
      <form onSubmit={(e) => { e.preventDefault(); void submit(); }}>
        <Field label="Company name" value={form.name} onChange={set('name')} required />
        <CountryCurrencyFields country={form.country} currency={form.currency}
          onCountryChange={set('country')} onCurrencyChange={set('currency')} />
        <div className="row2">
          <Field label="Administrator name" value={form.adminName} onChange={set('adminName')} required />
          <Field label="Administrator email" type="email" value={form.contactEmail} onChange={set('contactEmail')} required />
        </div>
        <Field label="Phone" value={form.contactPhone} onChange={set('contactPhone')} />
        <div className="row2">
          <Field label={`Credit limit (${form.currency})`} type="number" min="0" value={form.creditLimit} onChange={set('creditLimit')} />
          <Select label="Terms" value={form.terms} onChange={set('terms')} options={TERMS} />
        </div>
        <Field label={`Monthly budget (${form.currency})`} type="number" min="0" value={form.monthlyBudget} onChange={set('monthlyBudget')} />
        <button type="submit" className="cta green wide" disabled={act.busy}>{act.busy ? 'Registering…' : 'Register customer'}</button>
      </form>
    </section>
  );
}

function CustomerDetail({ org, standing, orders, go, onSaved, onClose }: {
  org: Organization; standing: Standing | undefined; orders: FuelOrder[]; go: OmcGo; onSaved: () => Promise<void>; onClose: () => void;
}) {
  const act = useAction();
  const [limit, setLimit] = useState(String(standing?.creditLimit ?? 0));
  const [terms, setTerms] = useState(standing?.terms ?? 'NET_30');
  const [budget, setBudget] = useState(String(standing?.monthlyBudget ?? 0));
  const submit = () => act.run(async () => {
    await api.setCredit(org.name, { creditLimit: Number(limit), terms, monthlyBudget: Number(budget) });
    await onSaved();
    return 'Credit terms saved.';
  });
  const mine = orders.filter((o) => o.customerName === org.name);
  return (
    <section className="card" style={{ marginTop: '0.85rem' }}>
      <div className="card-head"><h2>{org.name}</h2><button className="mini-btn" onClick={onClose}>Close</button></div>
      <div className="row-2" style={{ marginTop: 0 }}>
        <div>
          <dl className="kv">
            <dt>Contact</dt><dd>{org.contactEmail ?? '—'}{org.contactPhone ? ` · ${org.contactPhone}` : ''}</dd>
            <dt>Country · currency</dt><dd>{org.country} · {org.currency}</dd>
            <dt>Registered</dt><dd>{when(org.createdAt)}</dd>
            <dt>Orders</dt><dd>{mine.length} ({mine.filter((o) => o.status === 'FULFILLED').length} fulfilled)</dd>
            <dt>Used · committed</dt><dd>{standing ? `${money(standing.used, org.currency)} · ${money(standing.committed, org.currency)}` : '—'}</dd>
            <dt>Available credit</dt><dd>{standing ? money(standing.available, org.currency) : '—'}</dd>
          </dl>
          <div className="inline-actions row-actions">
            <button className="cta" onClick={() => go('omc-finance', 'pricing')}><Ic n="tag" s={13} /> Contract prices</button>
            <button className="cta" onClick={() => go('omc-finance', 'finance-statements', org.name)}><Ic n="receipt" s={13} /> Statement</button>
          </div>
        </div>
        <div>
          <h3 className="sub-h">Credit terms</h3>
          <Notice error={act.error} ok={act.ok} />
          <form onSubmit={(e) => { e.preventDefault(); void submit(); }}>
            <div className="row2">
              <Field label={`Credit limit (${org.currency ?? 'ZAR'})`} type="number" min="0" value={limit} onChange={setLimit} required />
              <Select label="Terms" value={terms} onChange={setTerms} options={TERMS} />
            </div>
            <Field label={`Monthly budget (${org.currency ?? 'ZAR'})`} type="number" min="0" value={budget} onChange={setBudget} required />
            <button type="submit" className="cta green wide" disabled={act.busy}>{act.busy ? 'Saving…' : 'Save credit terms'}</button>
          </form>
        </div>
      </div>
    </section>
  );
}

export function CustomerManagement({ orders, go }: { orders: FuelOrder[]; go: OmcGo }) {
  const orgs = useLoad(api.organizations);
  const standings = useLoad(api.standings);
  const [selected, setSelected] = useState('');
  const customers = (orgs.data ?? []).filter((o) => o.type === 'CUSTOMER');
  const standingOf = (name: string) => (standings.data ?? []).find((s) => s.organization === name);
  const ordersOf = (name: string) => orders.filter((o) => o.customerName === name).length;
  const refresh = async () => { await Promise.all([orgs.reload(), standings.reload()]); };
  const current = customers.find((c) => c.name === selected);

  const exportSpec = (): ExportSpec => {
    const currency = sharedCurrency(customers.map((c) => c.currency ?? currencyOf(c.name)));
    const amountType = currency ? 'money' : 'number';
    return {
      title: 'Customers',
      subtitle: `${customers.length} registered customers with credit standing`,
      filename: 'customers',
      currency: currency ?? undefined,
      columns: [
        { header: 'Customer' }, { header: 'Contact' }, { header: 'Country' }, { header: 'Currency' }, { header: 'Status' },
        { header: 'Credit limit', type: amountType }, { header: 'Terms' }, { header: 'Used', type: amountType }, { header: 'Committed', type: amountType },
        { header: 'Available', type: amountType }, { header: 'Month spend', type: amountType }, { header: 'Orders', type: 'number' },
      ],
      rows: customers.map((c) => { const s = standingOf(c.name); return [c.name, c.contactEmail, c.country, c.currency, lower(c.status),
        s?.creditLimit, s?.terms, s?.used, s?.committed, s?.available, s?.monthSpend, ordersOf(c.name)]; }),
    };
  };

  return (
    <>
      <PageHead icon="users" title="Customer Management" sub="Register companies and set their contracts, pricing and credit limits" />
      <Notice error={orgs.error || standings.error} />
      <div className="row-2" style={{ marginTop: 0, gridTemplateColumns: 'minmax(0, 1.9fr) minmax(0, 1fr)', alignItems: 'start' }}>
        <section className="card">
          <div className="card-head">
            <h2>Customers</h2>
            <div className="head-tools"><small className="muted">{customers.length} registered</small><ExportMenu build={exportSpec} disabled={customers.length === 0} /></div>
          </div>
          <div className="tbl-scroll">
            <table>
              <thead><tr><th>Customer</th><th>Country</th><th>Status</th><th>Credit limit · terms</th><th>Used</th><th>Committed</th><th>Available</th><th>Month spend</th><th>Orders</th></tr></thead>
              <tbody>
                <Rows state={{ ...orgs, data: orgs.data ? customers : null }} cols={9} empty="No customers registered yet.">
                  {(rows) => rows.map((c) => {
                    const s = standingOf(c.name);
                    return (
                      <tr key={c.id} className={selected === c.name ? 'clickable selected' : 'clickable'} onClick={() => setSelected(c.name)}>
                        <td><b>{c.name}</b><br /><small>{c.contactEmail ?? ''}</small></td>
                        <td>{c.country} · {c.currency}</td>
                        <td><StatusChip status={c.status} /></td>
                        <td>{s ? <>{money(s.creditLimit, c.currency)}<br /><small>{lower(s.terms)}</small></> : '—'}</td>
                        <td>{s ? money(s.used, c.currency) : '—'}</td><td>{s ? money(s.committed, c.currency) : '—'}</td><td>{s ? money(s.available, c.currency) : '—'}</td>
                        <td>{s ? money(s.monthSpend, c.currency) : '—'}</td><td>{ordersOf(c.name)}</td>
                      </tr>
                    );
                  })}
                </Rows>
              </tbody>
            </table>
          </div>
          <small className="muted">Select a customer to edit credit terms or open their prices and statement.</small>
        </section>
        <RegisterCustomer onDone={refresh} />
      </div>
      {current && (
        <CustomerDetail key={current.name}
          org={current} standing={standingOf(current.name)} orders={orders} go={go} onSaved={refresh} onClose={() => setSelected('')} />
      )}
    </>
  );
}
