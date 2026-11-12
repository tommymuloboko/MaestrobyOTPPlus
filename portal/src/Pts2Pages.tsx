import { useCallback, useEffect, useState } from 'react';
import { api, type Pts2Connection, type Pts2Prices, type Pts2SiteState, type Site } from './api';
import TankGauge from './TankGauge';
import { Field, Notice, Select, StatusChip, errorText, num, useAction, useLoad, when } from './ui';

const REFRESH_MS = 15000;
const LOW_ALARMS = ['LowProduct', 'CriticalLowProduct'];

function useRefresh(reload: () => Promise<void>) {
  useEffect(() => {
    const t = setInterval(() => void reload(), REFRESH_MS);
    return () => clearInterval(t);
  }, [reload]);
}

const alarmText = (a: string) => a.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();

/** Live tank gauges, read from each site's PTS-2 controller (Tanks page and Wetstock page). */
export function LiveTanks() {
  const live = useLoad(api.pts2Tanks);
  const sites = useLoad(api.listSites);
  useRefresh(live.reload);
  if (live.loading) return <section className="card"><div className="empty">Reading tanks from the PTS-2…</div></section>;
  if (live.error && !live.data) return <div className="error inline">{live.error}</div>;
  const siteName = (code: string) => (sites.data ?? []).find((s) => s.code === code)?.name ?? code;
  const states = live.data ?? [];
  if (states.length === 0) {
    return (
      <section className="card">
        <div className="empty">No PTS-2 controller is connected. Add one under <b>PTS-2 Connection</b> to see live tanks.</div>
      </section>
    );
  }
  return (
    <>
      {states.map((s) => <SiteTanks key={s.siteCode} state={s} siteName={siteName(s.siteCode)} />)}
    </>
  );
}

function SiteTanks({ state, siteName }: { state: Pts2SiteState; siteName: string }) {
  return (
    <>
      <div className="card-head" style={{ marginTop: '0.4rem' }}>
        <h2>{siteName} <small className="muted">PTS-2 {state.controllerId ?? ''}</small></h2>
        <small className="muted">
          <StatusChip status={state.ok ? 'online' : 'offline'} /> {state.ok ? `Read ${when(state.polledAt)}` : `Last good read ${when(state.lastSuccessAt)}`}
        </small>
      </div>
      {!state.ok && <div className="error inline">{state.error}</div>}
      <div className="tank-grid">
        {state.tanks.map((t) => {
          const notes = [t.status !== 'OK' ? `Probe ${t.status}` : '', ...t.alarms.map(alarmText),
            t.fuelGradeName ? `Grade: ${t.fuelGradeName}` : ''].filter(Boolean);
          return (
            <TankGauge key={t.tank} product={t.product} tankNo={t.tank} site={siteName}
              percent={Number(t.percent ?? 0)} bookLitres={Number(t.volumeLitres ?? 0)} capacityLitres={Number(t.capacityLitres ?? 0)}
              temperatureC={t.temperatureC} waterMm={t.waterHeightMm} belowReorder={t.alarms.some((a) => LOW_ALARMS.includes(a))}
              productHeightMm={t.productHeightMm} tankHeightMm={t.tankHeightMm}
              note={`${notes.join(' · ')}${notes.length ? ' · ' : ''}Measured ${when(t.measuredAt)}`} />
          );
        })}
        {state.tanks.length === 0 && state.ok && (
          <section className="card"><div className="empty">The controller reports no configured probes.</div></section>
        )}
      </div>
    </>
  );
}

const EMPTY = { url: '', username: 'admin', password: '', enabled: true };

/** PTS-2 connection settings: where the API reaches each site's controller on the network. */
export function Pts2ConnectionPage({ sites, canEdit }: { sites: Site[]; canEdit: boolean }) {
  const list = useLoad(api.pts2Connections);
  useRefresh(list.reload);
  const act = useAction();
  const [picked, setPicked] = useState('');
  const [form, setForm] = useState(EMPTY);
  const siteCode = picked || sites[0]?.code || '';
  const existing = (list.data ?? []).find((c) => c.siteCode === siteCode) ?? null;
  // the form shows saved settings only once a site has been picked (or saved); until then it is a new connection
  const editing = picked !== '' && existing != null;
  const formFor = (c: Pts2Connection | null) =>
    c ? { url: c.url, username: c.username, password: '', enabled: c.enabled } : EMPTY;
  /** Choosing a site loads its saved settings into the form; a background refresh never touches what is typed. */
  const pick = (code: string) => {
    setPicked(code);
    setForm(formFor((list.data ?? []).find((c) => c.siteCode === code) ?? null));
  };

  const siteName = (code: string) => sites.find((s) => s.code === code)?.name ?? code;
  const set = (patch: Partial<typeof EMPTY>) => setForm((f) => ({ ...f, ...patch }));

  const save = () => act.run(async () => {
    const saved = await api.savePts2Connection(siteCode, form);
    setPicked(siteCode);
    setForm((f) => ({ ...f, password: '' }));
    await list.reload();
    return saved.ok ? `Connected to the PTS-2 ${saved.controllerId ?? ''}: ${saved.tankCount} tank(s) read.`
      : saved.enabled ? `Saved, but the PTS-2 could not be read: ${saved.error}` : 'Saved. Polling is switched off.';
  });
  const test = (code: string) => act.run(async () => {
    const s = await api.testPts2Connection(code);
    await list.reload();
    if (!s.ok) throw new Error(s.error ?? 'The PTS-2 could not be read');
    return `${siteName(code)}: ${s.tanks.length} tank(s) read — ${s.tanks.map((t) => `T${t.tank} ${num(t.volumeLitres ?? 0, 0)} L`).join(', ')}`;
  });
  const remove = (code: string) => act.run(async () => {
    if (!window.confirm(`Remove the PTS-2 connection for ${siteName(code)}? Its live tanks will no longer be read.`)) return;
    await api.deletePts2Connection(code);
    await list.reload();
    return 'Connection removed.';
  });

  return (
    <>
      <Notice error={act.error} ok={act.ok} />
      {canEdit && (
        <section className="card" style={{ marginBottom: '0.85rem' }}>
          <div className="card-head"><h2>{editing ? 'Edit connection' : 'Connect a PTS-2'}</h2>
            <small className="muted">The API polls the controller every 15 seconds over jsonPTS</small></div>
          <form onSubmit={(e) => { e.preventDefault(); void save(); }}>
            <div className="row2">
              <Select label="Site" value={siteCode} onChange={pick} options={sites.map((s) => [s.code, `${s.name} (${s.code})`] as [string, string])} />
              <Field label="PTS-2 address" value={form.url} onChange={(v) => set({ url: v })} required placeholder="e.g. http://192.168.1.117" />
            </div>
            <div className="row2">
              <Field label="Username" value={form.username} onChange={(v) => set({ username: v })} required />
              <Field label={editing ? 'Password (leave blank to keep)' : 'Password'} type="password" value={form.password}
                onChange={(v) => set({ password: v })} required={!editing} />
            </div>
            <label style={{ flexDirection: 'row', alignItems: 'center', gap: '0.4rem', display: 'flex' }}>
              <input type="checkbox" checked={form.enabled} onChange={(e) => set({ enabled: e.target.checked })} style={{ width: 'auto' }} />
              Poll this controller
            </label>
            <small className="muted">
              Use the address of the controller's web server. HTTPS with its self-signed certificate and both Digest and Basic
              login (DIP switch 2) are supported. The API must be on a network that can reach the controller.
            </small>
            <button type="submit" className="cta green wide" disabled={act.busy || !siteCode || !form.url.trim()}>
              {act.busy ? 'Connecting…' : editing ? 'Save and read tanks' : 'Connect and read tanks'}
            </button>
          </form>
        </section>
      )}

      <section className="card">
        <div className="card-head"><h2>PTS-2 controllers</h2><small className="muted">{(list.data ?? []).length} connected</small></div>
        {list.error && !list.data && <div className="error inline">{errorText(list.error)}</div>}
        <table>
          <thead><tr><th>Site</th><th>Address</th><th>Controller ID</th><th>Status</th><th>Tanks</th><th>Last read</th>{canEdit && <th />}</tr></thead>
          <tbody>
            {(list.data ?? []).map((c: Pts2Connection) => (
              <tr key={c.siteCode}>
                <td><b>{siteName(c.siteCode)}</b><br /><small>{c.siteCode}</small></td>
                <td>{c.url}<br /><small>user {c.username}</small></td>
                <td><small>{c.controllerId ?? '—'}</small></td>
                <td>
                  <StatusChip status={!c.enabled ? 'planned' : c.ok == null ? 'pending' : c.ok ? 'online' : 'offline'} />
                  {!c.enabled && <small> polling off</small>}
                  {c.error && <><br /><small className="reason">{c.error}</small></>}
                </td>
                <td>{c.tankCount}</td>
                <td><small>{when(c.lastSuccessAt)}</small></td>
                {canEdit && (
                  <td style={{ whiteSpace: 'nowrap' }}>
                    <button className="mini-btn" disabled={act.busy} onClick={() => pick(c.siteCode)}>Edit</button>{' '}
                    <button className="mini-btn green" disabled={act.busy} onClick={() => void test(c.siteCode)}>Test</button>{' '}
                    <button className="btn-ghost" disabled={act.busy} onClick={() => void remove(c.siteCode)}>Remove</button>
                  </td>
                )}
              </tr>
            ))}
            {!list.loading && (list.data ?? []).length === 0 && (
              <tr><td colSpan={canEdit ? 7 : 6} className="empty">No PTS-2 controller is connected yet.</td></tr>
            )}
          </tbody>
        </table>
      </section>
    </>
  );
}

/** Controller local time "2026-11-13T06:00:00" shown as "2026-11-13 06:00". */
const ptsTime = (t: string | null) => (t ? t.replace('T', ' ').slice(0, 16) : '—');
const price = (p: number | null | undefined) => (p == null ? '—' : Number(p).toFixed(2));
const MODE_TEXT = { IMMEDIATE: 'Changed now', SCHEDULED: 'Scheduled', CANCELLED: 'Schedule cancelled' } as const;

/** Pump prices on a site's PTS-2: change them now, or schedule the change on the controller's prices scheduler. */
export function Pts2PricesPage({ sites, canEdit }: { sites: Site[]; canEdit: boolean }) {
  const conns = useLoad(api.pts2Connections);
  const [picked, setPicked] = useState('');
  const connected = sites.filter((s) => (conns.data ?? []).some((c) => c.siteCode === s.code));
  const siteCode = picked || connected[0]?.code || '';
  if (conns.loading) return <section className="card"><div className="empty">Loading PTS-2 connections…</div></section>;
  if (conns.error && !conns.data) return <div className="error inline">{conns.error}</div>;
  if (connected.length === 0) {
    return (
      <section className="card">
        <div className="empty">No PTS-2 controller is connected. Add one under <b>PTS-2 Connection</b> to manage pump prices.</div>
      </section>
    );
  }
  return (
    <>
      <section className="card" style={{ marginBottom: '0.85rem' }}>
        <Select label="Site" value={siteCode} onChange={setPicked}
          options={connected.map((s) => [s.code, `${s.name} (${s.code})`] as [string, string])} />
      </section>
      <SitePrices key={siteCode} siteCode={siteCode} canEdit={canEdit} />
    </>
  );
}

function SitePrices({ siteCode, canEdit }: { siteCode: string; canEdit: boolean }) {
  const fetchPrices = useCallback(() => api.pts2Prices(siteCode), [siteCode]);
  const fetchHistory = useCallback(() => api.pts2PriceHistory(siteCode), [siteCode]);
  const live = useLoad(fetchPrices);
  const history = useLoad(fetchHistory);
  const act = useAction();
  const [draft, setDraft] = useState<Record<number, string>>({});
  const [timing, setTiming] = useState<'now' | 'later'>('now');
  const [at, setAt] = useState('');

  const data: Pts2Prices | null = live.data;
  const grades = data?.grades ?? [];
  const schedules = data?.schedules ?? [];
  const changes = grades
    .filter((g) => (draft[g.id] ?? '').trim() !== '' && Number(draft[g.id]) !== Number(g.price))
    .map((g) => ({ fuelGradeId: g.id, price: Number(draft[g.id]) }));
  const invalid = changes.some((c) => !Number.isFinite(c.price) || c.price <= 0);
  const gradeName = (id: number) => grades.find((g) => g.id === id)?.name ?? `Grade ${id}`;

  const apply = () => act.run(async () => {
    const summary = changes.map((c) => `${gradeName(c.fuelGradeId)} ${c.price.toFixed(2)}`).join(', ');
    if (timing === 'now') {
      if (!window.confirm(`Change pump prices now? ${summary}. The pumps use the new price from the next sale.`)) return;
      await api.changePts2Prices(siteCode, { changes });
    } else {
      await api.changePts2Prices(siteCode, { changes, effectiveAt: at });
    }
    setDraft({});
    await Promise.all([live.reload(), history.reload()]);
    return timing === 'now' ? `Prices changed on the PTS-2: ${summary}.`
      : `Scheduled on the PTS-2 for ${ptsTime(at)}: ${summary}. The controller applies it on time even if the portal is offline.`;
  });
  const cancel = (id: number) => act.run(async () => {
    if (!window.confirm('Cancel this scheduled price change?')) return;
    await api.cancelPts2PriceSchedule(siteCode, id);
    await Promise.all([live.reload(), history.reload()]);
    return 'Scheduled price change cancelled.';
  });

  if (live.loading) return <section className="card"><div className="empty">Reading prices from the PTS-2…</div></section>;
  if (live.error && !data) return <div className="error inline">{live.error}</div>;
  const pending = schedules.filter((s) => s.pending);

  return (
    <>
      <Notice error={act.error} ok={act.ok} />
      <section className="card" style={{ marginBottom: '0.85rem' }}>
        <div className="card-head"><h2>Pump prices</h2>
          <small className="muted">Station time {ptsTime(data?.controllerTime ?? null)} · Read live from the PTS-2 <button className="btn-ghost" onClick={() => void live.reload()}>Refresh</button></small></div>
        <form onSubmit={(e) => { e.preventDefault(); void apply(); }}>
          <table>
            <thead><tr><th>Fuel grade</th><th>Current price</th>{canEdit && <th>New price</th>}<th>Next scheduled</th></tr></thead>
            <tbody>
              {grades.map((g) => {
                const next = pending.find((s) => s.fuelGradeId === g.id && s.days.length === 0);
                return (
                  <tr key={g.id}>
                    <td><b>{g.name || `Grade ${g.id}`}</b><br /><small>grade {g.id}</small></td>
                    <td className="mono">{price(g.price)}</td>
                    {canEdit && (
                      <td>
                        <input type="number" step="0.001" min="0.001" placeholder={price(g.price)} value={draft[g.id] ?? ''}
                          onChange={(e) => setDraft((d) => ({ ...d, [g.id]: e.target.value }))} style={{ maxWidth: '9rem' }} />
                      </td>
                    )}
                    <td><small>{next ? `${price(next.price)} at ${ptsTime(next.dateTime)}` : '—'}</small></td>
                  </tr>
                );
              })}
              {grades.length === 0 && (
                <tr><td colSpan={canEdit ? 4 : 3} className="empty">The controller reports no fuel grades.</td></tr>
              )}
            </tbody>
          </table>
          {canEdit && grades.length > 0 && (
            <>
              <div className="row2">
                <Select label="When" value={timing} onChange={(v) => setTiming(v as 'now' | 'later')}
                  options={[['now', 'Change immediately'], ['later', 'Schedule for a date and time']]} />
                {timing === 'later' && (
                  <Field label="Takes effect at (station time)" type="datetime-local" value={at} onChange={setAt} required />
                )}
              </div>
              <small className="muted">
                {timing === 'now' ? 'The new prices are sent to the controller now and the pumps use them from the next sale.'
                  : `The change is stored on the controller's prices scheduler, which applies it at that time on its own clock. ${data?.freeSlots ?? 0} of 10 scheduler slots free.`}
              </small>
              <button type="submit" className="cta green wide"
                disabled={act.busy || changes.length === 0 || invalid || (timing === 'later' && !at)}>
                {act.busy ? 'Sending to the PTS-2…' : changes.length === 0 ? 'Enter a new price'
                  : timing === 'now' ? `Change ${changes.length} price(s) now` : `Schedule ${changes.length} price change(s)`}
              </button>
            </>
          )}
        </form>
      </section>

      <section className="card" style={{ marginBottom: '0.85rem' }}>
        <div className="card-head"><h2>Scheduled changes</h2><small className="muted">On the controller's prices scheduler</small></div>
        <table>
          <thead><tr><th>Fuel grade</th><th>New price</th><th>Takes effect</th><th>Status</th>{canEdit && <th />}</tr></thead>
          <tbody>
            {schedules.map((s) => (
              <tr key={s.id}>
                <td><b>{s.fuelGradeName ?? `Grade ${s.fuelGradeId}`}</b></td>
                <td className="mono">{price(s.price)}</td>
                <td>{s.days.length ? `Every ${s.days.join(', ')} at ${s.dateTime?.slice(11, 16) ?? ''}` : ptsTime(s.dateTime)}</td>
                <td>
                  <StatusChip status={s.pending ? 'pending' : s.enabled ? 'completed' : 'planned'} />
                  {!s.enabled && <small> disabled</small>}
                </td>
                {canEdit && (
                  <td>{s.pending && <button className="btn-ghost" disabled={act.busy} onClick={() => void cancel(s.id)}>Cancel</button>}</td>
                )}
              </tr>
            ))}
            {schedules.length === 0 && (
              <tr><td colSpan={canEdit ? 5 : 4} className="empty">No price change is scheduled.</td></tr>
            )}
          </tbody>
        </table>
      </section>

      <section className="card">
        <div className="card-head"><h2>Price change history</h2><small className="muted">Changes sent from the portal</small></div>
        <table>
          <thead><tr><th>When</th><th>Fuel grade</th><th>Change</th><th>Price</th><th>Effective</th><th>By</th></tr></thead>
          <tbody>
            {(history.data ?? []).map((h) => (
              <tr key={h.id}>
                <td><small>{when(h.at)}</small></td>
                <td>{h.fuelGradeName ?? `Grade ${h.fuelGradeId}`}</td>
                <td>{MODE_TEXT[h.mode]}</td>
                <td className="mono">{price(h.previousPrice)} → {price(h.newPrice)}</td>
                <td><small>{ptsTime(h.effectiveAt)}</small></td>
                <td><small>{h.changedBy}</small></td>
              </tr>
            ))}
            {!history.loading && (history.data ?? []).length === 0 && (
              <tr><td colSpan={6} className="empty">No price has been changed from the portal yet.</td></tr>
            )}
          </tbody>
        </table>
      </section>
    </>
  );
}
