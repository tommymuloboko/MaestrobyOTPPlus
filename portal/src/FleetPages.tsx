import { useState } from 'react';
import { api, type Driver, type FuelOrder, type FuelTransaction, type Session, type Vehicle } from './api';
import BulkImport from './BulkImport';
import { CUSTOMER_ROLE, VEHICLE_TYPES, maxVehicleYear, MIN_VEHICLE_YEAR, sum, validYear } from './customerData';
import ExportMenu from './ExportMenu';
import type { ExportSpec } from './exporter';
import { Ic, Toast, type ToastMessage } from './ui';

interface Props {
  page: string;
  user: Session;
  vehicles: Vehicle[];
  drivers: Driver[];
  orders: FuelOrder[];
  transactions: FuelTransaction[];
  reload: () => Promise<void>;
}

const litres = (n: number) => `${n.toLocaleString(undefined, { maximumFractionDigits: 1 })} L`;

function Vehicles({ user, vehicles, drivers, orders, transactions, reload }: Props) {
  const canEdit = user.role === CUSTOMER_ROLE;
  const [open, setOpen] = useState(false);
  const [importing, setImporting] = useState(false);
  const [registration, setRegistration] = useState('');
  const [description, setDescription] = useState('');
  const [vehicleType, setVehicleType] = useState('');
  const [model, setModel] = useState('');
  const [year, setYear] = useState('');
  const [fuelType, setFuelType] = useState('DIESEL');
  const [capacity, setCapacity] = useState('');
  const [error, setError] = useState('');
  const [toast, setToast] = useState<ToastMessage | null>(null);
  const [busy, setBusy] = useState(false);
  const shown = vehicles.filter((v) => v.active);
  const activeDrivers = drivers.filter((d) => d.active);
  const driverOf = (reg: string) => activeDrivers.find((d) => d.vehicleReg === reg);
  const show = (title: string, detail?: string) => setToast({ id: Date.now(), title, detail });

  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setToast(null);
    setBusy(true);
    try {
      await api.addVehicle({
        registration, description, vehicleType, model, modelYear: year ? Number(year) : undefined,
        fuelType, tankCapacityLitres: Number(capacity),
      });
      await reload();
      show('Vehicle added', registration.trim().toUpperCase());
      setRegistration(''); setDescription(''); setVehicleType(''); setModel(''); setYear(''); setCapacity(''); setOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not add the vehicle');
    } finally {
      setBusy(false);
    }
  };

  const assignDriver = async (v: Vehicle, driverId: string) => {
    setError('');
    setToast(null);
    try {
      await api.assignDriver(v.id, driverId || null);
      await reload();
      const name = activeDrivers.find((d) => d.id === driverId)?.name;
      if (name) show('Vehicle assigned', `${v.registration} is now assigned to ${name}`);
      else show('Vehicle unassigned', `${v.registration} no longer has a driver`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not assign the driver');
    }
  };

  const drawn = (reg: string) => sum(transactions.filter((t) => t.vehicleReg === reg).map((t) => Number(t.volumeLitres)));

  const buildExport = (): ExportSpec => ({
    title: 'Vehicles',
    subtitle: `${shown.length} registered vehicle${shown.length === 1 ? '' : 's'}${canEdit ? ` · ${user.organization}` : ''}`,
    filename: 'vehicles',
    columns: [
      ...(canEdit ? [] : [{ header: 'Customer' }]),
      { header: 'Registration' }, { header: 'Type' }, { header: 'Model' }, { header: 'Year' }, { header: 'Description' },
      { header: 'Driver' }, { header: 'Fuel' },
      { header: 'Tank (L)', type: 'litres' }, { header: 'Orders', type: 'number' }, { header: 'Litres drawn (L)', type: 'litres' },
    ],
    rows: shown.map((v) => [
      ...(canEdit ? [] : [v.organization]),
      v.registration, v.vehicleType ?? '', v.model ?? '', v.modelYear ?? '', v.description ?? '', driverOf(v.registration)?.name ?? '',
      v.fuelType === 'DIESEL' ? 'Diesel' : 'Petrol',
      Number(v.tankCapacityLitres), orders.filter((o) => o.vehicleReg === v.registration).length, drawn(v.registration),
    ]),
  });

  return (
    <>
      <div className="page-head">
        <span className="page-ic"><Ic n="truck" s={20} /></span>
        <div><h2>Vehicles</h2><small>{shown.length} registered</small></div>
        <div className="page-actions">
          <ExportMenu build={buildExport} disabled={shown.length === 0} />
          {canEdit && (
            <>
              <button className="cta" onClick={() => setImporting(!importing)}><Ic n="sheet" s={13} /> Import from Excel</button>
              <button className="cta green" onClick={() => setOpen(!open)}><Ic n="plus" s={13} /> Add vehicle</button>
            </>
          )}
        </div>
      </div>

      {importing && (
        <BulkImport kind="vehicles" noun="vehicles" onDone={reload} onClose={() => setImporting(false)} />
      )}

      {toast && <Toast toast={toast} onClose={() => setToast(null)} />}
      {!open && error && <div className="error" role="alert">{error}</div>}

      {open && (
        <form className="card inline-form" onSubmit={add}>
          {error && <div className="error" role="alert">{error}</div>}
          <div className="inline-grid">
            <label>Registration<input required value={registration} placeholder="CA 123-456" onChange={(e) => setRegistration(e.target.value)} /></label>
            <label>Vehicle type
              <select value={vehicleType} onChange={(e) => setVehicleType(e.target.value)}>
                <option value="">Select type</option>
                {VEHICLE_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
            </label>
            <label>Model<input value={model} maxLength={60} placeholder="e.g. Hilux" onChange={(e) => setModel(e.target.value)} /></label>
            <label>Year
              <input inputMode="numeric" value={year} maxLength={4} placeholder={String(maxVehicleYear() - 1)}
                onChange={(e) => setYear(e.target.value.replace(/\D/g, ''))} />
            </label>
            <label>Description<input value={description} placeholder="Make and model" onChange={(e) => setDescription(e.target.value)} /></label>
            <label>Fuel type
              <select value={fuelType} onChange={(e) => setFuelType(e.target.value)}>
                <option value="DIESEL">Diesel</option><option value="PETROL">Petrol</option>
              </select>
            </label>
            <label>Tank capacity (L)<input required type="number" min="1" step="any" value={capacity} onChange={(e) => setCapacity(e.target.value)} /></label>
          </div>
          {!validYear(year) && <small className="reason">Year must be between {MIN_VEHICLE_YEAR} and {maxVehicleYear()}.</small>}
          <div className="inline-actions">
            <button type="submit" className="cta green" disabled={busy || !validYear(year)}>{busy ? 'Saving…' : 'Save vehicle'}</button>
            <button type="button" className="btn-ghost" onClick={() => setOpen(false)}>Cancel</button>
          </div>
        </form>
      )}

      <section className="card">
        <table>
          <thead>
            <tr>{!canEdit && <th>Customer</th>}<th>Registration</th><th>Type</th><th>Model</th><th>Year</th><th>Description</th><th>Driver</th><th>Fuel</th><th>Tank</th><th>Orders</th><th>Litres drawn</th>{canEdit && <th></th>}</tr>
          </thead>
          <tbody>
            {shown.map((v) => (
              <tr key={v.id}>
                {!canEdit && <td>{v.organization}</td>}
                <td><b>{v.registration}</b></td>
                <td>{v.vehicleType ?? '—'}</td>
                <td>{v.model ?? '—'}</td>
                <td>{v.modelYear ?? '—'}</td>
                <td>{v.description ?? '—'}</td>
                <td>
                  {canEdit ? (
                    <select className="cell-select" value={driverOf(v.registration)?.id ?? ''} onChange={(e) => assignDriver(v, e.target.value)}>
                      <option value="">None</option>
                      {activeDrivers.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
                    </select>
                  ) : (driverOf(v.registration)?.name ?? '—')}
                </td>
                <td><span className={`chip ${v.fuelType === 'DIESEL' ? 'chip-fulfilled' : 'chip-authorized'}`}>{v.fuelType.toLowerCase()}</span></td>
                <td>{litres(Number(v.tankCapacityLitres))}</td>
                <td>{orders.filter((o) => o.vehicleReg === v.registration).length}</td>
                <td>{litres(drawn(v.registration))}</td>
                {canEdit && (
                  <td><button className="icon-del" title="Remove vehicle"
                    onClick={async () => { if (confirm(`Remove ${v.registration}?`)) { await api.removeVehicle(v.id); await reload(); } }}>
                    <Ic n="trash" s={15} /></button></td>
                )}
              </tr>
            ))}
            {shown.length === 0 && <tr><td colSpan={12} className="empty">No vehicles registered yet.</td></tr>}
          </tbody>
        </table>
      </section>
    </>
  );
}

function Drivers({ user, vehicles, drivers, orders, transactions, reload }: Props) {
  const canEdit = user.role === CUSTOMER_ROLE;
  const [open, setOpen] = useState(false);
  const [importing, setImporting] = useState(false);
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [licenseNo, setLicenseNo] = useState('');
  const [vehicleReg, setVehicleReg] = useState('');
  const [issued, setIssued] = useState<{ name: string; pin: string } | null>(null);
  const [error, setError] = useState('');
  const [toast, setToast] = useState<ToastMessage | null>(null);
  const [busy, setBusy] = useState(false);
  const shown = drivers.filter((d) => d.active);
  const fleet = vehicles.filter((v) => v.active);
  const show = (title: string, detail?: string) => setToast({ id: Date.now(), title, detail });

  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setToast(null);
    setBusy(true);
    try {
      const r = await api.addDriver({ name, phone, licenseNo, vehicleReg });
      await reload();
      setIssued({ name: r.driver.name, pin: r.pin });
      show('Driver created', r.driver.vehicleReg
        ? `${r.driver.name} is assigned to ${r.driver.vehicleReg}`
        : r.driver.name);
      setName(''); setPhone(''); setLicenseNo(''); setVehicleReg(''); setOpen(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not add the driver');
    } finally {
      setBusy(false);
    }
  };

  // choosing a vehicle in the table assigns it straight away
  const assign = async (d: Driver, reg: string) => {
    setError('');
    setToast(null);
    try {
      await api.assignVehicle(d.id, reg);
      await reload();
      if (reg) show('Vehicle assigned', `${reg} is now assigned to ${d.name}`);
      else show('Vehicle unassigned', `${d.name} no longer has a vehicle`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not assign the vehicle');
    }
  };

  const drawn = (n: string) => sum(transactions.filter((t) => t.driverName === n).map((t) => Number(t.volumeLitres)));

  // PINs are stored hashed and never exported
  const buildExport = (): ExportSpec => ({
    title: 'Drivers',
    subtitle: `${shown.length} registered driver${shown.length === 1 ? '' : 's'}${canEdit ? ` · ${user.organization}` : ''}`,
    filename: 'drivers',
    columns: [
      ...(canEdit ? [] : [{ header: 'Customer' }]),
      { header: 'Driver' }, { header: 'Phone' }, { header: 'Licence' }, { header: 'Assigned vehicle' },
      { header: 'Orders', type: 'number' }, { header: 'Litres drawn (L)', type: 'litres' },
    ],
    rows: shown.map((d) => [
      ...(canEdit ? [] : [d.organization]),
      d.name, d.phone ?? '', d.licenseNo ?? '', d.vehicleReg ?? '',
      orders.filter((o) => o.driverName === d.name).length, drawn(d.name),
    ]),
  });

  return (
    <>
      <div className="page-head">
        <span className="page-ic"><Ic n="users" s={20} /></span>
        <div><h2>Drivers</h2><small>{shown.length} registered</small></div>
        <div className="page-actions">
          <ExportMenu build={buildExport} disabled={shown.length === 0} />
          {canEdit && (
            <>
              <button className="cta" onClick={() => setImporting(!importing)}><Ic n="sheet" s={13} /> Import from Excel</button>
              <button className="cta green" onClick={() => setOpen(!open)}><Ic n="plus" s={13} /> Add driver</button>
            </>
          )}
        </div>
      </div>

      {importing && (
        <BulkImport kind="drivers" noun="drivers" onDone={reload} onClose={() => setImporting(false)} />
      )}

      {toast && <Toast toast={toast} onClose={() => setToast(null)} />}
      {!open && error && <div className="error" role="alert">{error}</div>}

      {issued && (
        <div className="otp-box">
          <strong>PIN for {issued.name}: {issued.pin}</strong>
          <small>Sent to the driver by SMS. This is the only time it is shown; the attendant asks the driver for it at the pump.</small>
          <button className="btn-ghost" onClick={() => setIssued(null)}>Got it</button>
        </div>
      )}

      {open && (
        <form className="card inline-form" onSubmit={add}>
          {error && <div className="error" role="alert">{error}</div>}
          <div className="inline-grid">
            <label>Full name<input required value={name} placeholder="S. Dlamini" onChange={(e) => setName(e.target.value)} /></label>
            <label>Phone<input value={phone} placeholder="+27 82 555 0100" onChange={(e) => setPhone(e.target.value)} /></label>
            <label>Licence number<input value={licenseNo} onChange={(e) => setLicenseNo(e.target.value)} /></label>
            <label>Assigned vehicle
              <select value={vehicleReg} onChange={(e) => setVehicleReg(e.target.value)}>
                <option value="">None</option>
                {fleet.map((v) => <option key={v.id} value={v.registration}>{v.registration}</option>)}
              </select>
            </label>
          </div>
          <small className="hint">The phone number receives the driver's PIN and fuel codes by SMS.</small>
          <div className="inline-actions">
            <button type="submit" className="cta green" disabled={busy}>{busy ? 'Saving…' : 'Save driver'}</button>
            <button type="button" className="btn-ghost" onClick={() => setOpen(false)}>Cancel</button>
          </div>
        </form>
      )}

      <section className="card">
        <table>
          <thead>
            <tr>{!canEdit && <th>Customer</th>}<th>Driver</th><th>Phone</th><th>Licence</th><th>Assigned vehicle</th><th>Orders</th><th>Litres drawn</th>{canEdit && <th></th>}</tr>
          </thead>
          <tbody>
            {shown.map((d) => (
              <tr key={d.id}>
                {!canEdit && <td>{d.organization}</td>}
                <td><b>{d.name}</b></td>
                <td>{d.phone ?? '—'}</td>
                <td>{d.licenseNo ?? '—'}</td>
                <td>
                  {canEdit ? (
                    <select className="cell-select" value={d.vehicleReg ?? ''} onChange={(e) => assign(d, e.target.value)}>
                      <option value="">None</option>
                      {fleet.map((v) => <option key={v.id} value={v.registration}>{v.registration}</option>)}
                    </select>
                  ) : (d.vehicleReg ?? '—')}
                </td>
                <td>{orders.filter((o) => o.driverName === d.name).length}</td>
                <td>{litres(drawn(d.name))}</td>
                {canEdit && (
                  <td>
                    <button className="btn-ghost" title="Send a new PIN to the driver"
                      onClick={async () => { const r = await api.resetPin(d.id); setIssued({ name: r.driver.name, pin: r.pin }); }}>
                      Reset PIN
                    </button>
                    <button className="icon-del" title="Remove driver"
                      onClick={async () => { if (confirm(`Remove ${d.name}?`)) { await api.removeDriver(d.id); await reload(); } }}>
                      <Ic n="trash" s={15} /></button>
                  </td>
                )}
              </tr>
            ))}
            {shown.length === 0 && <tr><td colSpan={8} className="empty">No drivers registered yet.</td></tr>}
          </tbody>
        </table>
      </section>
    </>
  );
}

export default function FleetPages(props: Props) {
  return props.page === 'drivers' ? <Drivers {...props} /> : <Vehicles {...props} />;
}
