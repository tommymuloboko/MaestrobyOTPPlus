import { useState } from 'react';
import { api, type NewSite } from './api';
import { KIND_LABELS } from './sites';
import { Field, Notice, Select, useAction, useLoad } from './ui';

const KINDS: [string, string][] = Object.entries(KIND_LABELS);
const FALLBACK_PRODUCTS = ['DIESEL_50', 'ULP_93', 'ULP_95'];

interface TankRow { product: string; capacity: string; reorder: string; opening: string }

const normalizePts2 = (v: string) => v.replace(/\s+/g, '').toUpperCase();
const isPts2 = (v: string) => /^[A-Z0-9:_-]{6,64}$/.test(normalizePts2(v));
const inRange = (v: string, min: number, max: number) => v.trim() !== '' && Number.isFinite(Number(v)) && Number(v) >= min && Number(v) <= max;

/** Registers a station, depot or fuel depot by the unique ID of its PTS-2 forecourt controller. */
export default function AddSiteForm({ onAdded }: { onAdded: () => Promise<void> }) {
  const act = useAction();
  const prices = useLoad(api.listPrices);
  const products = prices.data && prices.data.length > 0 ? prices.data.map((p) => p.product) : FALLBACK_PRODUCTS;

  const [pts2Id, setPts2Id] = useState('');
  const [name, setName] = useState('');
  const [kind, setKind] = useState('STATION');
  const [code, setCode] = useState('');
  const [lat, setLat] = useState('');
  const [lng, setLng] = useState('');
  const [tanks, setTanks] = useState<TankRow[]>([]);

  const setTank = (i: number, patch: Partial<TankRow>) => setTanks((t) => t.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const duplicateProduct = new Set(tanks.map((t) => t.product)).size !== tanks.length;
  const tankOk = (t: TankRow) => inRange(t.capacity, 1, 1e7) && inRange(t.reorder, 0, Number(t.capacity))
    && (t.opening.trim() === '' || inRange(t.opening, 0, Number(t.capacity)));
  const valid = isPts2(pts2Id) && name.trim() !== '' && inRange(lat, -90, 90) && inRange(lng, -180, 180)
    && tanks.every(tankOk) && !duplicateProduct;

  const reset = () => { setPts2Id(''); setName(''); setCode(''); setLat(''); setLng(''); setTanks([]); };

  const submit = () => act.run(async () => {
    const payload: NewSite = {
      name: name.trim(), kind, pts2Id: normalizePts2(pts2Id), code: code.trim() || undefined,
      latitude: Number(lat), longitude: Number(lng),
      tanks: tanks.map((t) => ({
        product: t.product, capacityLitres: Number(t.capacity), reorderLitres: Number(t.reorder),
        openingLitres: t.opening.trim() === '' ? 0 : Number(t.opening),
      })),
    };
    const site = await api.addSite(payload);
    reset();
    await onAdded();
    return `${site.name} registered as ${site.code}. Telemetry sent under PTS-2 ID ${site.pts2Id} is now recorded against it.`;
  });

  return (
    <section className="card" style={{ marginBottom: '0.85rem' }}>
      <div className="card-head"><h2>Add a site</h2><small className="muted">Identified by the unique ID of its PTS-2 controller</small></div>
      <Notice error={act.error} ok={act.ok} />
      <form onSubmit={(e) => { e.preventDefault(); void submit(); }}>
        <div className="row2">
          <Field label="PTS-2 controller ID" value={pts2Id} onChange={setPts2Id} required placeholder="e.g. 0031002E3232511531383639" />
          <Field label="Site name" value={name} onChange={setName} required placeholder="e.g. Maestro Fuel Depot — Pretoria" />
        </div>
        {pts2Id.trim() !== '' && !isPts2(pts2Id) && <small className="reason">The controller ID must be 6 to 64 letters, digits, colons or dashes.</small>}
        <div className="row2">
          <Select label="Type" value={kind} onChange={setKind} options={KINDS} />
          <Field label="Site code (optional)" value={code} onChange={setCode} placeholder="Generated if left blank, e.g. SITE-004" />
        </div>
        <div className="row2">
          <Field label="Latitude" type="number" step="any" value={lat} onChange={setLat} required placeholder="-25.7479" />
          <Field label="Longitude" type="number" step="any" value={lng} onChange={setLng} required placeholder="28.2293" />
        </div>
        <small className="muted">The coordinates let a delivery truck be marked as arrived when it reaches the site.</small>

        <h3 className="sub-h">Tanks (optional)</h3>
        {tanks.map((t, i) => (
          <div className="form-row" key={i}>
            <Select label="Product" value={t.product} onChange={(v) => setTank(i, { product: v })} options={products} />
            <Field label="Capacity (L)" type="number" min="1" value={t.capacity} onChange={(v) => setTank(i, { capacity: v })} required />
            <Field label="Reorder level (L)" type="number" min="0" value={t.reorder} onChange={(v) => setTank(i, { reorder: v })} required />
            <Field label="Opening stock (L)" type="number" min="0" value={t.opening} onChange={(v) => setTank(i, { opening: v })} placeholder="0" />
            <button type="button" className="btn-ghost" onClick={() => setTanks((all) => all.filter((_, j) => j !== i))}>Remove</button>
            {!tankOk(t) && t.capacity !== '' && <small className="reason" style={{ flexBasis: '100%' }}>Reorder level and opening stock must be between zero and the capacity.</small>}
          </div>
        ))}
        {duplicateProduct && <small className="reason">Each product can have only one tank at a site.</small>}
        <div className="inline-actions">
          <button type="button" className="mini-btn" onClick={() => setTanks((all) => [...all, { product: products.find((p) => !all.some((t) => t.product === p)) ?? products[0], capacity: '', reorder: '', opening: '' }])}>
            + Add tank
          </button>
        </div>
        <button type="submit" className="cta green wide" disabled={act.busy || !valid}>{act.busy ? 'Registering…' : 'Register site'}</button>
      </form>
    </section>
  );
}
