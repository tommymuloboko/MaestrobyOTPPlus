import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, type BulkResult, type Driver, type FuelOrder, type OrderHistory, type Session, type Site, type Vehicle } from './api';
import BulkImport from './BulkImport';
import { money, moneyFor } from './currency';
import { Ic, StatusChip, errorText, useLoad, when } from './ui';

type FuelType = 'PETROL' | 'DIESEL';
const productFor = (t: FuelType) => (t === 'DIESEL' ? 'DIESEL_50' : 'ULP_95');
const fuelLabel = (product: string) => (product.startsWith('ULP') ? 'Petrol' : 'Diesel');

interface Props {
  page: string;
  user: Session;
  sites: Site[];
  vehicles: Vehicle[];
  drivers: Driver[];
  orders: FuelOrder[];
  go: (page: string) => void;
  reload: () => Promise<void>;
}

function BackLink({ go, to = 'dashboard' }: { go: (p: string) => void; to?: string }) {
  return (
    <button type="button" className="back" onClick={() => go(to)}><Ic n="back" s={14} /> Back</button>
  );
}

function Section({ icon, title, children }: { icon: string; title: string; children: React.ReactNode }) {
  return (
    <fieldset className="form-section">
      <legend><span className="sec-ic"><Ic n={icon} s={14} /></span>{title}</legend>
      {children}
    </fieldset>
  );
}

const siteLabel = (s: Site) => `${s.name} (${s.code})`;

/* ── New fuel order ─────────────────────────────────────── */
function NewOrder({ sites, vehicles, drivers, go, reload }: Props) {
  const [siteCode, setSiteCode] = useState('');
  const [driverName, setDriverName] = useState('');
  const [vehicleReg, setVehicleReg] = useState('');
  const [fuelType, setFuelType] = useState<FuelType>('DIESEL');
  const [qty, setQty] = useState('');
  const [destination, setDestination] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [created, setCreated] = useState<FuelOrder | null>(null);

  const activeVehicles = vehicles.filter((v) => v.active);
  const activeDrivers = drivers.filter((d) => d.active);
  const vehicle = activeVehicles.find((v) => v.registration === vehicleReg);
  const litres = Number(qty);
  const [price, setPrice] = useState<number | null>(null);
  const product = productFor(fuelType);
  useEffect(() => {
    let live = true;
    api.resolvePrice(product, litres > 0 ? litres : 1, siteCode || undefined)
      .then((p) => { if (live) setPrice(p.unitPrice); })
      .catch(() => { if (live) setPrice(null); });
    return () => { live = false; };
  }, [product, litres, siteCode]);
  // name of the driver whose assigned vehicle filled the vehicle field, if it was auto-filled
  const [autoFrom, setAutoFrom] = useState('');

  const problem = useMemo(() => {
    if (!vehicle) return '';
    if (vehicle.fuelType !== fuelType) return `${vehicle.registration} takes ${vehicle.fuelType.toLowerCase()}`;
    if (litres > Number(vehicle.tankCapacityLitres)) {
      return `${litres} L exceeds the ${vehicle.tankCapacityLitres} L tank of ${vehicle.registration}`;
    }
    return '';
  }, [vehicle, fuelType, litres]);

  const pickVehicle = (reg: string) => {
    setAutoFrom('');
    setVehicleReg(reg);
    const v = activeVehicles.find((x) => x.registration === reg);
    if (v) setFuelType(v.fuelType);
  };

  const pickDriver = (name: string) => {
    setDriverName(name);
    const d = activeDrivers.find((x) => x.name === name);
    const assigned = d?.vehicleReg ? activeVehicles.find((x) => x.registration === d.vehicleReg) : undefined;
    if (assigned) {
      setVehicleReg(assigned.registration);
      setFuelType(assigned.fuelType);
      setAutoFrom(name);
    } else if (autoFrom) {
      // the previous driver's vehicle was auto-filled and this driver has none, so don't leave it behind
      setVehicleReg('');
      setAutoFrom('');
    }
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      const order = await api.createOrder({
        siteCode, driverName, vehicleReg, fuelProduct: productFor(fuelType),
        quantityLitres: litres, destination, costCentre: 'CC-100',
      });
      await reload();
      setCreated(order);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not submit the order');
    } finally {
      setBusy(false);
    }
  };

  if (created) {
    return (
      <div className="form-page">
        <div className="card success-card">
          <span className="success-ic"><Ic n="check" s={28} /></span>
          <h2>Order {created.number} submitted</h2>
          <p>{created.quantityLitres} L of {fuelLabel(created.fuelProduct).toLowerCase()} for {created.vehicleReg} at {created.siteName}.
            The supplier will review it; once approved the driver receives a one-time code.</p>
          <div className="success-actions">
            <button className="cta green" onClick={() => go('my-orders')}>View my orders</button>
            <button className="cta" onClick={() => { setCreated(null); setQty(''); setDestination(''); }}>New order</button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="form-page fit">
      <div className="form-head">
        <BackLink go={go} />
        <h1 className="form-title">New Fuel Order</h1>
        <span className="form-sub">Request fuel for a vehicle</span>
      </div>

      <form className="card order-form fit" onSubmit={submit}>
        {error && <div className="error" role="alert">{error}</div>}

        <Section icon="pin" title="Station Site">
          <label>Select Fuel Station
            <select required value={siteCode} onChange={(e) => setSiteCode(e.target.value)}>
              <option value="">-- Select a station --</option>
              {sites.map((s) => <option key={s.code} value={s.code}>{siteLabel(s)}</option>)}
            </select>
          </label>
        </Section>

        <Section icon="user" title="Driver Information">
          <label>Select Driver
            <select required value={driverName} onChange={(e) => pickDriver(e.target.value)}>
              <option value="">Select Driver</option>
              {activeDrivers.map((d) => <option key={d.id} value={d.name}>{d.name}{d.licenseNo ? ` (${d.licenseNo})` : ''}</option>)}
            </select>
          </label>
          {activeDrivers.length === 0 && (
            <small className="hint">No drivers yet. <a onClick={() => go('drivers')}>Add a driver</a> first.</small>
          )}
          {driverName && !autoFrom && !activeDrivers.find((d) => d.name === driverName)?.vehicleReg && (
            <small className="hint">{driverName} has no assigned vehicle, so pick a vehicle.</small>
          )}
        </Section>

        <Section icon="truck" title="Vehicle Details">
          <label>Select Vehicle
            <select required value={vehicleReg} onChange={(e) => pickVehicle(e.target.value)}>
              <option value="">Select Vehicle</option>
              {activeVehicles.map((v) => (
                <option key={v.id} value={v.registration}>
                  {v.registration}{v.description ? ` — ${v.description}` : ''} ({v.fuelType.toLowerCase()})
                </option>
              ))}
            </select>
          </label>
          {vehicle && (
            <dl className="vehicle-card">
              <div><dt>Registration</dt><dd>{vehicle.registration}</dd></div>
              <div><dt>Vehicle</dt><dd>{vehicle.description ?? '—'}</dd></div>
              <div><dt>Fuel</dt><dd>{vehicle.fuelType === 'DIESEL' ? 'Diesel' : 'Petrol'}</dd></div>
              <div><dt>Tank</dt><dd>{vehicle.tankCapacityLitres} L</dd></div>
            </dl>
          )}
          {autoFrom && vehicle && <small className="hint">Filled in from {autoFrom}'s assigned vehicle. You can change it.</small>}
          {activeVehicles.length === 0 && (
            <small className="hint">No vehicles yet. <a onClick={() => go('vehicles')}>Add a vehicle</a> first.</small>
          )}
        </Section>

        <Section icon="fuel" title="Fuel Request">
          <div className="row2">
            <label>Fuel Type
              <select value={fuelType} onChange={(e) => setFuelType(e.target.value as FuelType)}>
                <option value="PETROL">Petrol</option>
                <option value="DIESEL">Diesel</option>
              </select>
            </label>
            <label>Fuel Volume Allocated (Litres)
              <input required type="number" min="1" step="any" value={qty} placeholder="e.g. 60"
                onChange={(e) => setQty(e.target.value)} />
            </label>
          </div>
          <label>Destination <span className="opt">(optional)</span>
            <input value={destination} placeholder="Where is the vehicle heading?"
              onChange={(e) => setDestination(e.target.value)} />
          </label>
          {problem && <div className="error inline" role="alert">{problem}</div>}
          {litres > 0 && !problem && price !== null && (
            <small className="hint">Estimated cost {money(litres * price)} at your contract price of {money(price)} / L</small>
          )}
        </Section>

        <button type="submit" className="cta green wide" disabled={busy || !!problem}>
          {busy ? 'Submitting…' : 'Submit Fuel Order'}
        </button>
      </form>
    </div>
  );
}

/* ── Bulk order ─────────────────────────────────────────── */
interface Row { key: number; vehicleReg: string; driverName: string; qty: string }

function BulkOrder({ sites, vehicles, drivers, go, reload }: Props) {
  const [siteCode, setSiteCode] = useState('');
  const [fuelType, setFuelType] = useState<FuelType>('DIESEL');
  const [destination, setDestination] = useState('');
  const [rows, setRows] = useState<Row[]>([{ key: 1, vehicleReg: '', driverName: '', qty: '' }]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [created, setCreated] = useState<FuelOrder[] | null>(null);
  const [importing, setImporting] = useState(false);

  // rows read from Excel replace the table so the user can still review and edit them before submitting
  const loadFromExcel = (result: BulkResult) => {
    setRows(result.allocations.map((a, i) => ({
      key: i + 1, vehicleReg: a.vehicleReg, driverName: a.driverName, qty: String(a.quantityLitres),
    })));
  };
  const activeVehicles = vehicles.filter((v) => v.active && v.fuelType === fuelType);
  const activeDrivers = drivers.filter((d) => d.active);
  const total = rows.reduce((s, r) => s + (Number(r.qty) || 0), 0);
  const setRow = (key: number, patch: Partial<Row>) =>
    setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  const used = (key: number) => rows.filter((r) => r.key !== key).map((r) => r.vehicleReg);

  const overCapacity = (r: Row) => {
    const v = vehicles.find((x) => x.registration === r.vehicleReg);
    return v && Number(r.qty) > Number(v.tankCapacityLitres) ? `Exceeds the ${v.tankCapacityLitres} L tank` : '';
  };
  const invalid = rows.some((r) => !r.vehicleReg || !r.driverName || !(Number(r.qty) > 0) || overCapacity(r));

  const changeFuel = (t: FuelType) => {
    setFuelType(t);
    setRows((rs) => rs.map((r) => ({ ...r, vehicleReg: '' })));
  };

  // choosing a driver fills the row's vehicle with theirs, unless it is the wrong fuel or already used in another row
  const pickDriver = (key: number, name: string) => {
    const d = activeDrivers.find((x) => x.name === name);
    const assigned = d?.vehicleReg ? activeVehicles.find((v) => v.registration === d.vehicleReg) : undefined;
    const usable = assigned && !used(key).includes(assigned.registration);
    setRow(key, usable ? { driverName: name, vehicleReg: assigned.registration } : { driverName: name });
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      const made = await api.createBulkOrder({
        siteCode, fuelProduct: productFor(fuelType), destination, costCentre: 'CC-100',
        items: rows.map((r) => ({ vehicleReg: r.vehicleReg, driverName: r.driverName, quantityLitres: Number(r.qty) })),
      });
      await reload();
      setCreated(made);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not submit the bulk order');
    } finally {
      setBusy(false);
    }
  };

  if (created) {
    return (
      <div className="form-page">
        <div className="card success-card">
          <span className="success-ic"><Ic n="check" s={28} /></span>
          <h2>Bulk order {created[0]?.bulkRef} submitted</h2>
          <p>{created.length} allocations totalling {created.reduce((s, o) => s + Number(o.quantityLitres), 0)} L.
            Each truck gets its own authorized quantity and one-time code once the supplier approves.</p>
          <div className="success-actions">
            <button className="cta green" onClick={() => go('my-orders')}>View my orders</button>
            <button className="cta" onClick={() => { setCreated(null); setRows([{ key: 1, vehicleReg: '', driverName: '', qty: '' }]); }}>New bulk order</button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="form-page wide">
      <BackLink go={go} />
      <h1 className="form-title">Bulk Order</h1>
      <p className="form-sub">Split one fuel order across several vehicles — each gets its own authorized quantity</p>

      <form className="card order-form" onSubmit={submit}>
        {error && <div className="error" role="alert">{error}</div>}

        <Section icon="pin" title="Station Site">
          <label>Select Fuel Station
            <select required value={siteCode} onChange={(e) => setSiteCode(e.target.value)}>
              <option value="">-- Select a station --</option>
              {sites.map((s) => <option key={s.code} value={s.code}>{siteLabel(s)}</option>)}
            </select>
          </label>
        </Section>

        <Section icon="fuel" title="Fuel Request">
          <div className="row2">
            <label>Fuel Type
              <select value={fuelType} onChange={(e) => changeFuel(e.target.value as FuelType)}>
                <option value="PETROL">Petrol</option>
                <option value="DIESEL">Diesel</option>
              </select>
            </label>
            <label>Destination <span className="opt">(optional)</span>
              <input value={destination} onChange={(e) => setDestination(e.target.value)} />
            </label>
          </div>
        </Section>

        <Section icon="truck" title="Vehicle Allocations">
          <div className="alloc-foot">
            <small className="muted">Type each allocation, or load many at once from a spreadsheet.</small>
            <button type="button" className="cta" onClick={() => setImporting(!importing)}>
              <Ic n="sheet" s={13} /> Import from Excel
            </button>
          </div>
          {importing && (
            <BulkImport kind="orders" noun="allocations" fuelProduct={productFor(fuelType)} templateFuelType={fuelType}
              onDone={loadFromExcel} onClose={() => setImporting(false)} />
          )}
          <div className="alloc-rows">
            {rows.map((r) => (
              <div className="alloc-row" key={r.key}>
                <label>Vehicle
                  <select required value={r.vehicleReg} onChange={(e) => setRow(r.key, { vehicleReg: e.target.value })}>
                    <option value="">Select Vehicle</option>
                    {activeVehicles.filter((v) => !used(r.key).includes(v.registration)).map((v) => (
                      <option key={v.id} value={v.registration}>{v.registration}{v.description ? ` — ${v.description}` : ''}</option>
                    ))}
                  </select>
                </label>
                <label>Driver
                  <select required value={r.driverName} onChange={(e) => pickDriver(r.key, e.target.value)}>
                    <option value="">Select Driver</option>
                    {activeDrivers.map((d) => <option key={d.id} value={d.name}>{d.name}</option>)}
                  </select>
                </label>
                <label>Litres
                  <input required type="number" min="1" step="any" value={r.qty}
                    onChange={(e) => setRow(r.key, { qty: e.target.value })} />
                </label>
                <button type="button" className="icon-del" title="Remove" disabled={rows.length === 1}
                  onClick={() => setRows((rs) => rs.filter((x) => x.key !== r.key))}>
                  <Ic n="trash" s={15} />
                </button>
                {overCapacity(r) && <small className="row-err">{overCapacity(r)}</small>}
              </div>
            ))}
          </div>
          <div className="alloc-foot">
            <button type="button" className="cta" onClick={() => setRows((rs) => [...rs, { key: Math.max(...rs.map((x) => x.key)) + 1, vehicleReg: '', driverName: '', qty: '' }])}>
              <Ic n="plus" s={13} /> Add vehicle
            </button>
            <span className="total">Total <b>{total.toLocaleString()} L</b> across {rows.length} {rows.length === 1 ? 'vehicle' : 'vehicles'}</span>
          </div>
          {activeVehicles.length === 0 && <small className="hint">No registered {fuelType.toLowerCase()} vehicles. <a onClick={() => go('vehicles')}>Add one</a>.</small>}
        </Section>

        <button type="submit" className="cta green wide" disabled={busy || invalid || !siteCode}>
          {busy ? 'Submitting…' : 'Submit Bulk Order'}
        </button>
      </form>
    </div>
  );
}

/* ── My orders ──────────────────────────────────────────── */
const FILTERS = ['ALL', 'PENDING_CUSTOMER_APPROVAL', 'PENDING_APPROVAL', 'AUTHORIZED', 'FULFILLED', 'REJECTED'];

export function OrderTimeline({ id }: { id: string }) {
  const fetchHistory = useCallback(() => api.orderHistory(id), [id]);
  const history = useLoad<OrderHistory[]>(fetchHistory);
  if (history.loading) return <small className="muted">Loading history…</small>;
  if (history.error && !history.data) return <small className="reason">{history.error}</small>;
  if (!history.data?.length) return <small className="muted">No status changes recorded.</small>;
  return (
    <ul className="timeline">
      {history.data.map((h) => (
        <li key={h.id}>
          <b>{h.fromStatus ? `${h.fromStatus.replaceAll('_', ' ').toLowerCase()} → ` : ''}{h.toStatus.replaceAll('_', ' ').toLowerCase()}</b>
          <small>{when(h.at)} · {h.actor}{h.reason ? ` · ${h.reason}` : ''}</small>
        </li>
      ))}
    </ul>
  );
}

function MyOrders({ orders, go, reload }: Props) {
  const [filter, setFilter] = useState('ALL');
  const [open, setOpen] = useState('');
  const [declining, setDeclining] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const shown = filter === 'ALL' ? orders : orders.filter((o) => o.status === filter);
  const count = (f: string) => (f === 'ALL' ? orders.length : orders.filter((o) => o.status === f).length);

  const decide = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError('');
    try {
      await fn();
      setDeclining('');
      setReason('');
      await reload();
    } catch (e) {
      setError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="page-head">
        <span className="page-ic"><Ic n="orders" s={20} /></span>
        <div><h2>My orders</h2><small>Every fuel order you have placed</small></div>
        <div className="page-actions">
          <button className="cta" onClick={() => go('bulk-order')}><Ic n="bulk" s={13} /> Bulk order</button>
          <button className="cta green" onClick={() => go('new-order')}><Ic n="plus" s={13} /> New order</button>
        </div>
      </div>
      {error && <div className="error inline">{error}</div>}
      <section className="card">
        <div className="filters">
          {FILTERS.map((f) => (
            <button key={f} className={filter === f ? 'filter active' : 'filter'} onClick={() => setFilter(f)}>
              {f === 'ALL' ? 'All' : f.replaceAll('_', ' ').toLowerCase()} <b>{count(f)}</b>
            </button>
          ))}
        </div>
        <div className="tbl-scroll">
        <table>
          <thead><tr><th>Order</th><th>Station</th><th>Vehicle · driver</th><th>Fuel</th><th>Litres</th><th>Price</th><th>Destination</th><th>Placed</th><th>Status</th><th /></tr></thead>
          <tbody>
            {shown.flatMap((o) => [
              <tr key={o.id}>
                <td><b>{o.number}</b>{o.bulkRef && <><br /><span className="chip chip-approved">{o.bulkRef}</span></>}</td>
                <td>{o.siteName}{o.siteCode && <><br /><small>{o.siteCode}</small></>}</td>
                <td>{o.vehicleReg}<br /><small>{o.driverName}</small></td>
                <td>{fuelLabel(o.fuelProduct)}</td>
                <td>{o.quantityLitres}</td>
                <td>{moneyFor(Number(o.unitPriceSnapshot), o.customerName)} / L</td>
                <td>{o.destination ?? '—'}</td>
                <td>{new Date(o.createdAt).toLocaleString()}</td>
                <td>
                  <StatusChip status={o.status} />{o.rejectionReason && <small className="reason">{o.rejectionReason}</small>}
                  {o.status === 'PENDING_CUSTOMER_APPROVAL' && (
                    <div className="inline-actions" style={{ marginTop: '0.4rem' }}>
                      <button className="btn-ok" disabled={busy} onClick={() => void decide(() => api.acceptOrder(o.id))}>Accept</button>
                      <button className="btn-ghost" disabled={busy} onClick={() => { setDeclining(o.id); setOpen(o.id); }}>Decline</button>
                    </div>
                  )}
                </td>
                <td><button className="mini-btn" onClick={() => setOpen(open === o.id ? '' : o.id)}>{open === o.id ? 'Hide' : 'History'}</button></td>
              </tr>,
              ...(open === o.id ? [
                <tr key={`${o.id}-history`}>
                  <td colSpan={10}>
                    <OrderTimeline id={o.id} />
                    {declining === o.id && (
                      <form className="form-row" style={{ marginTop: '0.7rem' }}
                        onSubmit={(e) => { e.preventDefault(); void decide(() => api.declineOrder(o.id, reason)); }}>
                        <label>Reason for declining
                          <input value={reason} onChange={(e) => setReason(e.target.value)} required />
                        </label>
                        <button type="submit" className="btn-ghost" disabled={busy}>Confirm decline</button>
                        <button type="button" className="mini-btn" onClick={() => setDeclining('')}>Cancel</button>
                      </form>
                    )}
                  </td>
                </tr>,
              ] : []),
            ])}
            {shown.length === 0 && <tr><td colSpan={10} className="empty">No orders here yet.</td></tr>}
          </tbody>
        </table>
        </div>
      </section>
    </>
  );
}

export default function OrderPages(props: Props) {
  switch (props.page) {
    case 'new-order': return <NewOrder {...props} />;
    case 'bulk-order': return <BulkOrder {...props} />;
    default: return <MyOrders {...props} />;
  }
}
