import { useCallback, useState } from 'react';
import { api, type CaseView, type Site, type VarianceException } from './api';
import {
  Field, Notice, PageHead, Rows, Select, StatStrip, StatusChip, Tabs, num, useAction, useLoad, when,
} from './ui';

/* ── Sentinel room ───────────────────────────────────────────── */
type SentinelTab = 'events' | 'cases' | 'rules';
const SENTINEL_TABS: [SentinelTab, string][] = [['events', 'Risk events'], ['cases', 'Fraud cases'], ['rules', 'Rule catalogue']];

function CaseDetail({ view, onChange }: { view: CaseView; onChange: () => Promise<unknown> }) {
  const c = view.fraudCase;
  const e = view.event;
  const fetchEvidence = useCallback(() => (e ? api.evidenceFor(e.id) : Promise.resolve([])), [e]);
  const evidence = useLoad(fetchEvidence);
  const act = useAction();
  const [note, setNote] = useState('');
  const [outcome, setOutcome] = useState('FALSE_POSITIVE');
  const closed = c.status === 'CLOSED' || c.outcome !== null;

  return (
    <section className="card" style={{ marginTop: '0.85rem' }}>
      <div className="card-head">
        <h2>Case detail</h2>
        <StatusChip status={c.status} />
      </div>
      <Notice error={act.error} ok={act.ok} />
      <div className="row-2" style={{ marginTop: 0 }}>
        <div>
          <dl className="kv">
            <dt>Opened</dt><dd>{when(c.openedAt)}</dd>
            <dt>Assigned to</dt><dd>{c.assignedTo ?? 'Unassigned'}</dd>
            <dt>Outcome</dt><dd>{c.outcome ? c.outcome.replaceAll('_', ' ').toLowerCase() : 'Open'}</dd>
            {e && <><dt>Rule</dt><dd>{e.rule}</dd><dt>Severity</dt><dd><StatusChip status={e.severity} /></dd>
              <dt>Where</dt><dd>{e.siteCode ?? '—'} · {e.vehicleReg ?? '—'}</dd>
              <dt>People</dt><dd>{e.driverName ?? '—'} / {e.attendantName ?? '—'}</dd>
              <dt>Details</dt><dd>{e.details}</dd></>}
          </dl>
          {c.notes && <pre className="mono" style={{ whiteSpace: 'pre-wrap', margin: '0 0 0.7rem' }}>{c.notes}</pre>}
          {!closed && (
            <>
              <div className="inline-actions" style={{ marginBottom: '0.7rem' }}>
                <button className="cta" disabled={act.busy}
                  onClick={() => void act.run(async () => { await api.assignCase(c.id); await onChange(); return 'Assigned to you.'; })}>
                  Assign to me
                </button>
              </div>
              <form className="form-row" onSubmit={(ev) => {
                ev.preventDefault();
                void act.run(async () => { await api.noteCase(c.id, note); setNote(''); await onChange(); return 'Note added.'; });
              }}>
                <Field label="Investigator note" value={note} onChange={setNote} required />
                <button type="submit" className="cta" disabled={act.busy}>Add note</button>
              </form>
              <form className="form-row" onSubmit={(ev) => {
                ev.preventDefault();
                void act.run(async () => { await api.closeCase(c.id, outcome); await onChange(); return 'Case closed.'; });
              }}>
                <Select label="Close with outcome" value={outcome} onChange={setOutcome}
                  options={['CONFIRMED_FRAUD', 'FALSE_POSITIVE', 'NO_ACTION']} />
                <button type="submit" className="btn-ghost" disabled={act.busy}>Close case</button>
              </form>
            </>
          )}
        </div>
        <div>
          <h3 style={{ margin: '0 0 0.5rem', fontSize: '0.85rem' }}>Evidence chain</h3>
          <div className="alert-list">
            {evidence.loading && <div className="empty">Loading evidence…</div>}
            {evidence.error && <div className="empty err">{evidence.error}</div>}
            {!evidence.loading && !evidence.error && (evidence.data ?? []).length === 0 && <div className="empty">No evidence records.</div>}
            {(evidence.data ?? []).map((r, i) => (
              <div className="alert-row" key={r.id}>
                <span className="alert-ic" style={{ background: 'var(--green-soft)', color: 'var(--green-dark)' }}>{i + 1}</span>
                <div style={{ minWidth: 0 }}>
                  <b>{when(r.createdAt)}</b>
                  <small className="mono">prev {r.prevHash.slice(0, 16)}…</small>
                  <small className="mono">hash {r.contentHash.slice(0, 16)}…</small>
                  <details>
                    <summary><small>Show captured content</small></summary>
                    <pre className="mono" style={{ whiteSpace: 'pre-wrap', margin: '0.3rem 0 0' }}>{r.content}</pre>
                  </details>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

export function Sentinel() {
  const [tab, setTab] = useState<SentinelTab>('events');
  const events = useLoad(api.riskEvents);
  const cases = useLoad(api.fraudCases);
  const rules = useLoad(api.sentinelRules);
  const verify = useAction();
  const [chain, setChain] = useState<{ valid: boolean; records: number } | null>(null);
  const [selected, setSelected] = useState('');
  const open = (events.data ?? []).filter((e) => e.status === 'OPEN');
  const critical = open.filter((e) => e.severity === 'CRITICAL').length;
  const selectedCase = (cases.data ?? []).find((c) => c.fraudCase.id === selected);

  return (
    <>
      <PageHead icon="sentinel" title="Sentinel room" sub="Maestro Sentinel™: risk events, fraud cases and tamper-evident evidence">
        <button className="cta green" disabled={verify.busy}
          onClick={() => void verify.run(async () => { setChain(await api.verifyEvidence()); })}>
          Verify evidence chain
        </button>
      </PageHead>
      <Notice error={verify.error || events.error} />
      {chain && (
        <div className={chain.valid ? 'notice-ok' : 'error inline'}>
          {chain.valid
            ? `Evidence chain VALID — ${chain.records} records, every hash links to the one before it.`
            : `Evidence chain INVALID — tampering detected among ${chain.records} records.`}
        </div>
      )}
      <StatStrip items={[
        { icon: 'alert', label: 'Open risk events', value: String(open.length), sub: `${(events.data ?? []).length} in the latest 200` },
        { icon: 'warn', label: 'Critical', value: String(critical), sub: 'Open and critical' },
        { icon: 'shield', label: 'Fraud cases', value: String((cases.data ?? []).length), sub: `${(cases.data ?? []).filter((c) => c.fraudCase.outcome === null).length} unresolved` },
        { icon: 'sentinel', label: 'Detection rules', value: String((rules.data ?? []).length), sub: 'In the catalogue' },
      ]} />
      <div style={{ marginTop: '0.85rem' }}>
        <Tabs tabs={SENTINEL_TABS} value={tab} onChange={setTab} />
        {tab === 'events' && (
          <section className="card tbl-scroll">
            <table>
              <thead><tr><th>When</th><th>Rule</th><th>Severity</th><th>Score</th><th>Where</th><th>People</th><th>Details</th><th>Action taken</th><th>Status</th></tr></thead>
              <tbody>
                <Rows state={events} cols={9} empty="No risk events.">
                  {(rows) => rows.map((e) => (
                    <tr key={e.id}>
                      <td>{when(e.createdAt)}</td>
                      <td><b>{e.rule.replaceAll('_', ' ')}</b></td>
                      <td><StatusChip status={e.severity} /></td>
                      <td>{e.score}</td>
                      <td>{e.siteCode ?? '—'}<br /><small>{e.vehicleReg ?? ''}</small></td>
                      <td><small>{e.driverName ?? '—'}<br />{e.attendantName ?? ''}</small></td>
                      <td style={{ maxWidth: 260 }}>{e.details}</td>
                      <td><small>{e.autoAction.replaceAll('_', ' ').toLowerCase()}</small></td>
                      <td><StatusChip status={e.status} /></td>
                    </tr>
                  ))}
                </Rows>
              </tbody>
            </table>
          </section>
        )}
        {tab === 'cases' && (
          <>
            <section className="card tbl-scroll">
              <div className="card-head"><h2>Fraud cases</h2><small className="muted">Select a case to investigate</small></div>
              <table>
                <thead><tr><th>Opened</th><th>Rule</th><th>Severity</th><th>Assigned</th><th>Outcome</th><th>Status</th></tr></thead>
                <tbody>
                  <Rows state={cases} cols={6} empty="No fraud cases.">
                    {(rows) => rows.map((v) => (
                      <tr key={v.fraudCase.id} className={`clickable${selected === v.fraudCase.id ? ' selected' : ''}`}
                        onClick={() => setSelected(v.fraudCase.id)}>
                        <td>{when(v.fraudCase.openedAt)}</td>
                        <td><b>{v.event?.rule.replaceAll('_', ' ') ?? '—'}</b></td>
                        <td>{v.event ? <StatusChip status={v.event.severity} /> : '—'}</td>
                        <td>{v.fraudCase.assignedTo ?? '—'}</td>
                        <td>{v.fraudCase.outcome?.replaceAll('_', ' ').toLowerCase() ?? '—'}</td>
                        <td><StatusChip status={v.fraudCase.status} /></td>
                      </tr>
                    ))}
                  </Rows>
                </tbody>
              </table>
            </section>
            {selectedCase && <CaseDetail key={selectedCase.fraudCase.id} view={selectedCase} onChange={() => Promise.all([cases.reload(), events.reload()])} />}
          </>
        )}
        {tab === 'rules' && (
          <section className="card tbl-scroll">
            <table>
              <thead><tr><th>Rule</th><th>Severity</th><th>Trigger</th><th>Response</th></tr></thead>
              <tbody>
                <Rows state={rules} cols={4} empty="No rules.">
                  {(rows) => rows.map((r) => (
                    <tr key={r.code}><td><b>{r.code.replaceAll('_', ' ')}</b></td><td><StatusChip status={r.severity} /></td><td>{r.trigger}</td><td>{r.response}</td></tr>
                  ))}
                </Rows>
              </tbody>
            </table>
          </section>
        )}
      </div>
    </>
  );
}

/* ── Reconciliation ──────────────────────────────────────────── */
type ExFilter = 'OPEN' | 'RESOLVED' | 'ALL';

export function Reconciliation({ sites }: { sites: Site[] }) {
  const runs = useLoad(api.reconRuns);
  const exceptions = useLoad(api.reconExceptions);
  const act = useAction();
  const [siteChoice, setSiteChoice] = useState('');
  const [date, setDate] = useState('');
  const [filter, setFilter] = useState<ExFilter>('OPEN');
  const [resolving, setResolving] = useState<VarianceException | null>(null);
  const [note, setNote] = useState('');
  const siteCode = siteChoice || sites[0]?.code || '';
  const all = exceptions.data ?? [];
  const shown = filter === 'ALL' ? all : all.filter((x) => x.status === filter);
  const refresh = () => Promise.all([runs.reload(), exceptions.reload()]);

  return (
    <>
      <PageHead icon="scale" title="Daily reconciliation" sub="Book stock, tank gauges and pump totalizers compared per site and day" />
      <Notice error={act.error} ok={act.ok} />
      <StatStrip items={[
        { icon: 'scale', label: 'Runs', value: String((runs.data ?? []).length), sub: 'Latest 100' },
        { icon: 'warn', label: 'Open exceptions', value: String(all.filter((x) => x.status === 'OPEN').length), sub: 'Need a decision' },
        { icon: 'check', label: 'Resolved', value: String(all.filter((x) => x.status === 'RESOLVED').length), sub: 'With a recorded note' },
        { icon: 'calendar', label: 'Last run', value: runs.data?.[0] ? runs.data[0].businessDate : '—', sub: runs.data?.[0]?.siteCode ?? 'No runs yet' },
      ]} />
      <section className="card" style={{ marginTop: '0.85rem' }}>
        <div className="card-head"><h2>Close the day</h2><small className="muted">Compares stock, gauge and totalizer for the site</small></div>
        <form className="form-row" onSubmit={(e) => {
          e.preventDefault();
          void act.run(async () => {
            const r = await api.closeDay(siteCode, date || undefined);
            await refresh();
            return `${r.siteCode} ${r.businessDate}: ${r.status === 'OK' ? 'balanced' : `${r.exceptions} exception(s)`}. ${r.summary}`;
          });
        }}>
          <Select label="Site" value={siteCode} onChange={setSiteChoice} options={sites.map((s): [string, string] => [s.code, s.name])} />
          <Field label="Business date (default today)" type="date" value={date} onChange={setDate} />
          <button type="submit" className="cta green" disabled={act.busy || !siteCode}>Close day</button>
        </form>
      </section>
      <section className="card tbl-scroll" style={{ marginTop: '0.85rem' }}>
        <div className="card-head"><h2>Reconciliation runs</h2></div>
        <table>
          <thead><tr><th>Site · date</th><th>Dispensed</th><th>Totalizer</th><th>Exceptions</th><th>Summary</th><th>Status</th></tr></thead>
          <tbody>
            <Rows state={runs} cols={6} empty="No runs yet — close a day to create one.">
              {(rows) => rows.map((r) => (
                <tr key={r.id}>
                  <td><b>{r.siteCode}</b><br /><small>{r.businessDate}</small></td>
                  <td>{num(r.dispensedLitres)} L</td>
                  <td>{num(r.totalizerLitres)} L</td>
                  <td>{r.exceptions}</td>
                  <td style={{ maxWidth: 320 }}><small>{r.summary}</small></td>
                  <td><StatusChip status={r.status} /></td>
                </tr>
              ))}
            </Rows>
          </tbody>
        </table>
      </section>
      <section className="card tbl-scroll" style={{ marginTop: '0.85rem' }}>
        <div className="card-head"><h2>Variance exceptions</h2></div>
        <Tabs tabs={[['OPEN', 'Open'], ['RESOLVED', 'Resolved'], ['ALL', 'All']] as [ExFilter, string][]} value={filter} onChange={setFilter} />
        <table>
          <thead><tr><th>Site · product</th><th>Kind</th><th>Expected</th><th>Actual</th><th>Variance</th><th>Status</th><th>Resolution</th></tr></thead>
          <tbody>
            {exceptions.loading || (exceptions.error && !exceptions.data)
              ? <tr><td colSpan={7} className="empty">{exceptions.loading ? 'Loading…' : exceptions.error}</td></tr>
              : shown.map((x) => (
                <tr key={x.id}>
                  <td><b>{x.siteCode}</b><br /><small>{x.product ?? 'all products'}</small></td>
                  <td>{x.kind.replaceAll('_', ' ').toLowerCase()}</td>
                  <td>{num(x.expectedLitres)} L</td>
                  <td>{num(x.actualLitres)} L</td>
                  <td><b>{x.varianceLitres > 0 ? '+' : ''}{num(x.varianceLitres)} L</b></td>
                  <td><StatusChip status={x.status} /></td>
                  <td>
                    {x.status === 'OPEN'
                      ? <button className="mini-btn green" onClick={() => { setResolving(x); setNote(''); }}>Resolve</button>
                      : <small>{x.note}<br />— {x.resolvedBy}</small>}
                  </td>
                </tr>
              ))}
            {!exceptions.loading && !exceptions.error && shown.length === 0 && <tr><td colSpan={7} className="empty">No {filter.toLowerCase()} exceptions.</td></tr>}
          </tbody>
        </table>
        {resolving && (
          <form className="form-row" style={{ marginTop: '0.85rem' }} onSubmit={(e) => {
            e.preventDefault();
            void act.run(async () => {
              await api.resolveException(resolving.id, note);
              setResolving(null);
              await refresh();
              return 'Exception resolved.';
            });
          }}>
            <Field label={`Resolution note for ${resolving.siteCode} · ${resolving.kind.replaceAll('_', ' ').toLowerCase()}`} value={note} onChange={setNote} required />
            <button type="submit" className="cta green" disabled={act.busy}>Save resolution</button>
            <button type="button" className="btn-ghost" onClick={() => setResolving(null)}>Cancel</button>
          </form>
        )}
      </section>
    </>
  );
}
