import { useCallback, useState } from 'react';
import { api, type Delivery, type Session, type Site } from './api';
import { CUSTOMER_ROLE, isSupplierRole } from './customerData';
import { Field, Notice, PageHead, Rows, Select, StatusChip, num, useAction, useLoad, when } from './ui';

const PRODUCTS = ['DIESEL_50', 'ULP_95', 'ULP_93'];

function destination(d: Delivery) {
  return d.destinationType === 'SITE' ? d.destinationSiteCode ?? 'Site' : d.destinationName ?? d.customer ?? 'Customer';
}

function Detail({ listed, canAct, onChange }: { listed: Delivery; canAct: boolean; onChange: () => Promise<unknown> }) {
  const id = listed.id;
  const fetchDetail = useCallback(() => api.delivery(id), [id]);
  const detail = useLoad(fetchDetail);
  const act = useAction();
  const [loaded, setLoaded] = useState('');
  const [seals, setSeals] = useState('');
  const [gps, setGps] = useState({ lat: '', lng: '', speed: '' });
  const [offloaded, setOffloaded] = useState('');
  const [pod, setPod] = useState({ signedBy: '', notes: '' });

  if (detail.loading) return <section className="card" style={{ marginTop: '0.85rem' }}><div className="empty">Loading delivery…</div></section>;
  // the track and proof endpoint can fail independently; the delivery itself is still known from the list
  const d = detail.data?.delivery ?? listed;
  const track = detail.data?.track ?? [];
  const proof = detail.data?.proof ?? [];

  const step = (fn: () => Promise<unknown>, message: string) => act.run(async () => {
    await fn();
    await Promise.all([detail.reload(), onChange()]);
    return message;
  });

  return (
    <section className="card" style={{ marginTop: '0.85rem' }}>
      <div className="card-head"><h2>{d.number} · {d.truckReg}</h2><StatusChip status={d.status} /></div>
      <Notice error={act.error || (detail.error ? `GPS track and proof of delivery could not be loaded: ${detail.error}` : '')} ok={act.ok} />
      <div className="row-2" style={{ marginTop: 0 }}>
        <div>
          <dl className="kv">
            <dt>Route</dt><dd>{d.originSiteCode} → {destination(d)}</dd>
            <dt>Customer</dt><dd>{d.customer ?? '—'}</dd>
            <dt>Product</dt><dd>{d.product}</dd>
            <dt>Planned</dt><dd>{num(d.plannedLitres, 0)} L</dd>
            <dt>Loaded</dt><dd>{d.loadedLitres === null ? '—' : `${num(d.loadedLitres, 0)} L`}{d.sealNumbers && ` · seals ${d.sealNumbers}`}</dd>
            <dt>Delivered</dt><dd>{d.deliveredLitres === null ? '—' : `${num(d.deliveredLitres, 0)} L`}</dd>
            <dt>Driver</dt><dd>{d.driverName}</dd>
          </dl>
          {canAct && d.status === 'PLANNED' && (
            <form className="form-row" onSubmit={(e) => { e.preventDefault(); void step(() => api.loadDelivery(d.id, Number(loaded), seals), 'Loaded.'); }}>
              <Field label="Loaded litres" type="number" min="1" value={loaded} onChange={setLoaded} required />
              <Field label="Seal numbers" value={seals} onChange={setSeals} placeholder="S1,S2" />
              <button type="submit" className="cta green" disabled={act.busy}>Record load</button>
            </form>
          )}
          {canAct && d.status === 'LOADING' && (
            <button className="cta green" disabled={act.busy} onClick={() => void step(() => api.departDelivery(d.id), 'Truck departed.')}>Depart</button>
          )}
          {canAct && d.status === 'IN_TRANSIT' && (
            <form className="form-row" onSubmit={(e) => {
              e.preventDefault();
              void step(() => api.gpsDelivery(d.id, Number(gps.lat), Number(gps.lng), gps.speed ? Number(gps.speed) : undefined), 'Position recorded.');
            }}>
              <Field label="Latitude" type="number" step="any" value={gps.lat} onChange={(v) => setGps((g) => ({ ...g, lat: v }))} required />
              <Field label="Longitude" type="number" step="any" value={gps.lng} onChange={(v) => setGps((g) => ({ ...g, lng: v }))} required />
              <Field label="Speed km/h" type="number" min="0" value={gps.speed} onChange={(v) => setGps((g) => ({ ...g, speed: v }))} />
              <button type="submit" className="cta" disabled={act.busy}>Send GPS</button>
            </form>
          )}
          {canAct && d.status === 'ARRIVED' && (
            <form className="form-row" onSubmit={(e) => { e.preventDefault(); void step(() => api.offloadDelivery(d.id, Number(offloaded)), 'Offload recorded.'); }}>
              <Field label="Delivered litres" type="number" min="0" value={offloaded} onChange={setOffloaded} required />
              <button type="submit" className="cta green" disabled={act.busy}>Record offload</button>
            </form>
          )}
          {canAct && d.status === 'OFFLOADED' && (
            <form className="form-row" onSubmit={(e) => { e.preventDefault(); void step(() => api.podDelivery(d.id, pod.signedBy, pod.notes), 'Proof of delivery saved.'); }}>
              <Field label="Signed by" value={pod.signedBy} onChange={(v) => setPod((p) => ({ ...p, signedBy: v }))} required />
              <Field label="Notes" value={pod.notes} onChange={(v) => setPod((p) => ({ ...p, notes: v }))} />
              <button type="submit" className="cta green" disabled={act.busy}>Capture proof of delivery</button>
            </form>
          )}
        </div>
        <div>
          <h3 style={{ margin: '0 0 0.5rem', fontSize: '0.85rem' }}>Proof of delivery</h3>
          {proof.length === 0 && <div className="empty">{detail.error ? 'Unavailable.' : 'Not signed yet.'}</div>}
          {proof.map((p) => (
            <div className="receipt" key={p.id}>
              <b>Signed by {p.signedBy}</b>
              <span>{num(p.deliveredLitres, 0)} L received · {when(p.at)}</span>
              {p.notes && <small>{p.notes}</small>}
            </div>
          ))}
          <h3 style={{ margin: '0.9rem 0 0.5rem', fontSize: '0.85rem' }}>GPS track</h3>
          {track.length === 0 && <div className="empty">{detail.error ? 'Unavailable.' : 'No positions reported.'}</div>}
          <ul className="timeline">
            {track.slice(-8).map((t) => (
              <li key={t.id}><b>{t.lat.toFixed(4)}, {t.lng.toFixed(4)}</b><small>{when(t.at)}{t.speedKph !== null && ` · ${t.speedKph} km/h`}</small></li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}

export default function Deliveries({ user, sites }: { user: Session; sites: Site[] }) {
  const isCustomer = user.role === CUSTOMER_ROLE;
  const canPlan = isSupplierRole(user.role);
  const deliveries = useLoad(api.deliveries);
  const act = useAction();
  const [selected, setSelected] = useState('');
  const [form, setForm] = useState({
    originSiteCode: '', destinationType: 'CUSTOMER', destinationSiteCode: '', destinationName: '', lat: '', lng: '',
    customer: '', product: 'DIESEL_50', plannedLitres: '', truckReg: '', driverName: '',
  });
  const set = (k: keyof typeof form) => (v: string) => setForm((f) => ({ ...f, [k]: v }));
  const origin = form.originSiteCode || sites[0]?.code || '';
  const selectedDelivery = (deliveries.data ?? []).find((d) => d.id === selected);
  const toSite = form.destinationType === 'SITE';

  const plan = () => act.run(async () => {
    const d = await api.planDelivery({
      originSiteCode: origin, destinationType: form.destinationType,
      destinationSiteCode: toSite ? form.destinationSiteCode || sites[0]?.code : null,
      destinationName: form.destinationName || null,
      lat: form.lat ? Number(form.lat) : null, lng: form.lng ? Number(form.lng) : null,
      customer: toSite ? null : form.customer || null, product: form.product,
      plannedLitres: Number(form.plannedLitres), truckReg: form.truckReg, driverName: form.driverName,
    });
    await deliveries.reload();
    setSelected(d.id);
    return `${d.number} planned.`;
  });

  return (
    <>
      <PageHead icon="truck" title="Deliveries"
        sub={isCustomer ? 'Fuel delivered to your yards: track the truck and see the signed proof' : 'Bulk deliveries from depot to site or customer'}>
        <button className="cta" onClick={() => void deliveries.reload()}>Refresh</button>
      </PageHead>
      <section className="card tbl-scroll">
        <table>
          <thead><tr><th>Delivery</th><th>Route</th>{!isCustomer && <th>Customer</th>}<th>Product</th><th>Planned</th><th>Loaded</th><th>Delivered</th><th>Truck · driver</th><th>Status</th></tr></thead>
          <tbody>
            <Rows state={deliveries} cols={isCustomer ? 8 : 9} empty="No deliveries yet.">
              {(rows) => rows.map((d) => (
                <tr key={d.id} className={`clickable${selected === d.id ? ' selected' : ''}`} onClick={() => setSelected(d.id)}>
                  <td><b>{d.number}</b><br /><small>{when(d.createdAt)}</small></td>
                  <td>{d.originSiteCode} → {destination(d)}</td>
                  {!isCustomer && <td>{d.customer ?? '—'}</td>}
                  <td>{d.product}</td>
                  <td>{num(d.plannedLitres, 0)} L</td>
                  <td>{d.loadedLitres === null ? '—' : `${num(d.loadedLitres, 0)} L`}</td>
                  <td>{d.deliveredLitres === null ? '—' : `${num(d.deliveredLitres, 0)} L`}</td>
                  <td>{d.truckReg}<br /><small>{d.driverName}</small></td>
                  <td><StatusChip status={d.status} /></td>
                </tr>
              ))}
            </Rows>
          </tbody>
        </table>
      </section>
      {selectedDelivery && <Detail key={selectedDelivery.id} listed={selectedDelivery} canAct={!isCustomer && isSupplierRole(user.role)} onChange={deliveries.reload} />}
      {canPlan && (
        <section className="card" style={{ marginTop: '0.85rem' }}>
          <div className="card-head"><h2>Plan a delivery</h2></div>
          <Notice error={act.error} ok={act.ok} />
          <form onSubmit={(e) => { e.preventDefault(); void plan(); }}>
            <div className="inline-grid three">
              <Select label="Origin depot" value={origin} onChange={set('originSiteCode')} options={sites.map((s): [string, string] => [s.code, s.name])} />
              <Select label="Destination type" value={form.destinationType} onChange={set('destinationType')} options={['CUSTOMER', 'SITE']} />
              {toSite
                ? <Select label="Destination site" value={form.destinationSiteCode || sites[0]?.code || ''} onChange={set('destinationSiteCode')}
                    options={sites.map((s): [string, string] => [s.code, s.name])} />
                : <Field label="Customer" value={form.customer} onChange={set('customer')} required placeholder="Acme Logistics" />}
            </div>
            <div className="inline-grid three">
              {!toSite && <Field label="Destination name" value={form.destinationName} onChange={set('destinationName')} placeholder="Acme yard" />}
              <Field label="Latitude (optional)" type="number" step="any" value={form.lat} onChange={set('lat')} />
              <Field label="Longitude (optional)" type="number" step="any" value={form.lng} onChange={set('lng')} />
            </div>
            <div className="inline-grid three">
              <Select label="Product" value={form.product} onChange={set('product')} options={PRODUCTS} />
              <Field label="Planned litres" type="number" min="1" value={form.plannedLitres} onChange={set('plannedLitres')} required />
              <Field label="Truck registration" value={form.truckReg} onChange={set('truckReg')} required />
            </div>
            <Field label="Driver" value={form.driverName} onChange={set('driverName')} required />
            <button type="submit" className="cta green wide" disabled={act.busy || !origin}>Plan delivery</button>
          </form>
        </section>
      )}
    </>
  );
}
