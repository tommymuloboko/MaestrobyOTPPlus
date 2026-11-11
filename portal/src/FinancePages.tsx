import { useCallback, useState } from 'react';
import { api } from './api';
import { currencyOf, moneyFor, moneyTotal, sharedCurrency } from './currency';
import ExportMenu from './ExportMenu';
import type { ExportSpec } from './exporter';
import {
  Field, Notice, PageHead, Rows, Select, StatStrip, StatusChip, Tabs, money, num, useAction, useLoad, when,
} from './ui';

const sumOf = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

type Tab = 'invoices' | 'ledger' | 'statements' | 'settlement' | 'fx' | 'erp';
export type FinanceTab = Tab;
const TABS: [Tab, string][] = [
  ['invoices', 'Invoices'], ['ledger', 'Ledger'], ['statements', 'Statements'],
  ['settlement', 'Supplier settlement'], ['fx', 'FX rates'], ['erp', 'ERP'],
];

function Invoices({ onChange }: { onChange: () => void }) {
  const invoices = useLoad(api.invoices);
  const act = useAction();
  const [pay, setPay] = useState({ invoiceId: '', amount: '', method: 'EFT', reference: '' });
  const set = (k: keyof typeof pay) => (v: string) => setPay((p) => ({ ...p, [k]: v }));
  const open = (invoices.data ?? []).filter((i) => i.balance > 0);
  const invoiceId = pay.invoiceId || open[0]?.invoice.id || '';
  const chosen = open.find((i) => i.invoice.id === invoiceId);
  const all = invoices.data ?? [];

  const invoicesExport = (): ExportSpec => {
    const currency = sharedCurrency(all.map((v) => v.invoice.currency));
    const amount = currency ? 'money' : 'number';
    return {
      title: 'Invoices',
      subtitle: `All customers · ${all.length} invoice${all.length === 1 ? '' : 's'} issued`,
      filename: 'invoices',
      currency: currency ?? undefined,
      columns: [
        { header: 'Invoice' }, { header: 'Customer' }, { header: 'Currency' }, { header: 'Fiscal ref' }, { header: 'Issued', type: 'date' }, { header: 'Due', type: 'date' },
        { header: 'Total', type: amount }, { header: 'Tax', type: amount }, { header: 'Paid', type: amount },
        { header: 'Balance', type: amount }, { header: 'Status' },
      ],
      rows: all.map((v) => [v.invoice.number, v.invoice.organization, v.invoice.currency, v.invoice.fiscalRef ?? '', v.invoice.issueDate, v.invoice.dueDate,
        Number(v.invoice.total), Number(v.invoice.tax), Number(v.invoice.paid), Number(v.balance), v.status.replaceAll('_', ' ').toLowerCase()]),
      // amounts in different currencies are never added together
      totals: currency
        ? ['Total', '', '', '', '', '', sumOf(all.map((v) => Number(v.invoice.total))), sumOf(all.map((v) => Number(v.invoice.tax))),
          sumOf(all.map((v) => Number(v.invoice.paid))), sumOf(all.map((v) => Number(v.balance))), '']
        : undefined,
    };
  };

  const record = () => act.run(async () => {
    const amount = Number(pay.amount || chosen?.balance || 0);
    await api.payInvoice(invoiceId, amount, pay.method, pay.reference || undefined);
    setPay((p) => ({ ...p, amount: '', reference: '' }));
    await invoices.reload();
    onChange();
    return `Recorded ${money(amount, chosen?.invoice.currency)} by ${pay.method}.`;
  });

  return (
    <>
      <section className="card tbl-scroll">
        <div className="card-head">
          <h2>Invoices</h2>
          <div className="head-tools">
            <small className="muted">{invoices.data?.length ?? 0} issued</small>
            <ExportMenu build={invoicesExport} disabled={all.length === 0} />
          </div>
        </div>
        <table>
          <thead><tr><th>Invoice</th><th>Customer</th><th>Issued · due</th><th>Total</th><th>Paid</th><th>Balance</th><th>Status</th></tr></thead>
          <tbody>
            <Rows state={invoices} cols={7} empty="No invoices yet — run billing to invoice dispensed fuel.">
              {(rows) => rows.map((v) => (
                <tr key={v.invoice.id}>
                  <td><b>{v.invoice.number}</b><br /><small>{v.lines.length} lines</small></td>
                  <td>{v.invoice.organization}</td>
                  <td>{v.invoice.issueDate}<br /><small>due {v.invoice.dueDate}</small></td>
                  <td>{money(v.invoice.total, v.invoice.currency)}<br /><small>incl. {v.invoice.taxName} {money(v.invoice.tax, v.invoice.currency)}</small></td>
                  <td>{money(v.invoice.paid, v.invoice.currency)}</td>
                  <td><b>{money(v.balance, v.invoice.currency)}</b></td>
                  <td><StatusChip status={v.status} /></td>
                </tr>
              ))}
            </Rows>
          </tbody>
        </table>
      </section>
      <section className="card" style={{ marginTop: '0.85rem' }}>
        <div className="card-head"><h2>Record a payment</h2><small className="muted">EFT and cash are recorded by Finance</small></div>
        <Notice error={act.error} ok={act.ok} />
        <form className="form-row" onSubmit={(e) => { e.preventDefault(); void record(); }}>
          <Select label="Invoice" value={invoiceId} onChange={set('invoiceId')}
            options={open.map((i): [string, string] => [i.invoice.id, `${i.invoice.number} · ${i.invoice.organization}`])} />
          <Field label={`Amount (balance ${chosen ? money(chosen.balance, chosen.invoice.currency) : '—'})`} type="number" step="0.01" min="0.01"
            value={pay.amount} onChange={set('amount')} placeholder={chosen ? String(chosen.balance) : ''} />
          <Select label="Method" value={pay.method} onChange={set('method')} options={['EFT', 'CASH', 'CARD']} />
          <Field label="Reference" value={pay.reference} onChange={set('reference')} />
          <button type="submit" className="cta green" disabled={act.busy || !chosen}>Record payment</button>
        </form>
      </section>
    </>
  );
}

function Ledger() {
  const ledger = useLoad(api.ledger);
  const entries = ledger.data ?? [];
  const ledgerExport = (): ExportSpec => {
    const currency = sharedCurrency(entries.map((l) => currencyOf(l.organization)));
    const amount = currency ? 'money' : 'number';
    return {
      title: 'Ledger entries',
      subtitle: `Latest ${entries.length} double-entry postings`,
      filename: 'ledger',
      currency: currency ?? undefined,
      columns: [
        { header: 'When', type: 'datetime' }, { header: 'Customer' }, { header: 'Currency' }, { header: 'Account' },
        { header: 'Debit', type: amount }, { header: 'Credit', type: amount }, { header: 'Memo' },
      ],
      rows: entries.map((l) => [l.at, l.organization, currencyOf(l.organization), l.account, Number(l.debit), Number(l.credit), l.memo ?? '']),
      totals: currency
        ? ['Total', '', '', '', sumOf(entries.map((l) => Number(l.debit))), sumOf(entries.map((l) => Number(l.credit))), '']
        : undefined,
    };
  };
  return (
    <section className="card tbl-scroll">
      <div className="card-head">
        <h2>Ledger entries</h2>
        <div className="head-tools">
          <small className="muted">Latest 300, double-entry</small>
          <ExportMenu build={ledgerExport} disabled={entries.length === 0} />
        </div>
      </div>
      <table>
        <thead><tr><th>When</th><th>Customer</th><th>Account</th><th>Debit</th><th>Credit</th><th>Memo</th></tr></thead>
        <tbody>
          <Rows state={ledger} cols={6} empty="No ledger entries yet.">
            {(rows) => rows.map((l) => (
              <tr key={l.id}>
                <td>{when(l.at)}</td><td>{l.organization}</td><td><b>{l.account}</b></td>
                <td>{l.debit ? moneyFor(l.debit, l.organization) : ''}</td><td>{l.credit ? moneyFor(l.credit, l.organization) : ''}</td><td>{l.memo ?? ''}</td>
              </tr>
            ))}
          </Rows>
        </tbody>
      </table>
    </section>
  );
}

function Statements({ initialCustomer = '' }: { initialCustomer?: string }) {
  const orgs = useLoad(api.organizations);
  const [chosen, setChosen] = useState(initialCustomer);
  const customers = (orgs.data ?? []).filter((o) => o.type === 'CUSTOMER').map((o) => o.name);
  const customer = chosen || customers[0] || '';
  const currency = currencyOf(customer);
  const fetchStatement = useCallback(() => (customer ? api.statementFor(customer) : Promise.resolve([])), [customer]);
  const statement = useLoad(fetchStatement);
  const lines = statement.data ?? [];
  const statementExport = (): ExportSpec => ({
    title: 'Statement of account',
    subtitle: `Customer: ${customer} · ${currency}`,
    filename: `statement-${customer.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`,
    currency,
    columns: [
      { header: 'When', type: 'datetime' }, { header: 'Type' }, { header: 'Reference' },
      { header: 'Debit', type: 'money' }, { header: 'Credit', type: 'money' }, { header: 'Balance', type: 'money' },
    ],
    rows: lines.map((s) => [s.at, s.kind.toLowerCase(), s.reference, Number(s.debit), Number(s.credit), Number(s.balance)]),
    // the balance is a running total, so the closing balance is that of the last line
    totals: ['Closing balance', '', '', sumOf(lines.map((s) => Number(s.debit))), sumOf(lines.map((s) => Number(s.credit))),
      lines.length ? Number(lines[lines.length - 1].balance) : 0],
  });
  return (
    <section className="card tbl-scroll">
      <div className="card-head">
        <h2>Customer statement</h2>
        <ExportMenu build={statementExport} disabled={lines.length === 0 || !customer} />
      </div>
      <div className="form-row">
        <Select label="Customer" value={customer} onChange={setChosen} options={customers} />
      </div>
      <table>
        <thead><tr><th>When</th><th>Type</th><th>Reference</th><th>Debit</th><th>Credit</th><th>Balance</th></tr></thead>
        <tbody>
          <Rows state={statement} cols={6} empty="No activity for this customer.">
            {(rows) => rows.map((s, i) => (
              <tr key={`${s.reference}-${i}`}>
                <td>{when(s.at)}</td><td>{s.kind.toLowerCase()}</td><td>{s.reference}</td>
                <td>{s.debit ? money(s.debit, currency) : ''}</td><td>{s.credit ? money(s.credit, currency) : ''}</td><td><b>{money(s.balance, currency)}</b></td>
              </tr>
            ))}
          </Rows>
        </tbody>
      </table>
    </section>
  );
}

function Settlement() {
  const runs = useLoad(api.settlements);
  const act = useAction();
  return (
    <section className="card tbl-scroll">
      <div className="card-head">
        <h2>Supplier settlement</h2>
        <button className="cta green" disabled={act.busy}
          onClick={() => void act.run(async () => { await api.settle(); await runs.reload(); return 'Settlement run created.'; })}>
          Create settlement run
        </button>
      </div>
      <Notice error={act.error} ok={act.ok} />
      <table>
        <thead><tr><th>Supplier</th><th>Period</th><th>Gross</th><th>Fee</th><th>Net payable</th><th>Status</th><th /></tr></thead>
        <tbody>
          <Rows state={runs} cols={7} empty="No settlement runs yet.">
            {(rows) => rows.map((r) => (
              <tr key={r.id}>
                <td><b>{r.supplier}</b></td>
                <td><small>{when(r.periodFrom)} → {when(r.periodTo)}</small></td>
                <td>{moneyFor(r.gross, r.supplier)}</td>
                <td>{moneyFor(r.fee, r.supplier)}<br /><small>{num(r.feePercent, 2)}%</small></td>
                <td><b>{moneyFor(r.net, r.supplier)}</b></td>
                <td><StatusChip status={r.status} /></td>
                <td>{r.status !== 'PAID' && (
                  <button className="btn-ok" disabled={act.busy}
                    onClick={() => void act.run(async () => { await api.markSettlementPaid(r.id); await runs.reload(); return 'Marked as paid.'; })}>
                    Mark paid
                  </button>
                )}</td>
              </tr>
            ))}
          </Rows>
        </tbody>
      </table>
    </section>
  );
}

function Fx() {
  const rates = useLoad(api.fxRates);
  const act = useAction();
  const [rate, setRate] = useState({ from: 'USD', to: 'ZAR', value: '' });
  const [conv, setConv] = useState({ amount: '100', from: 'ZAR', to: 'ZMW' });
  const [converted, setConverted] = useState('');
  return (
    <>
      <Notice error={act.error} ok={act.ok} />
      <div className="row-2" style={{ marginTop: 0 }}>
        <section className="card tbl-scroll">
          <div className="card-head"><h2>Exchange rates</h2></div>
          <table>
            <thead><tr><th>Pair</th><th>Rate</th><th>Updated</th></tr></thead>
            <tbody>
              <Rows state={rates} cols={3} empty="No rates set.">
                {(rows) => rows.map((r) => (
                  <tr key={r.id}><td><b>{r.fromCurrency} → {r.toCurrency}</b></td><td>{num(r.rate, 6)}</td><td>{when(r.at)}</td></tr>
                ))}
              </Rows>
            </tbody>
          </table>
          <form className="form-row" style={{ marginTop: '0.85rem' }} onSubmit={(e) => {
            e.preventDefault();
            void act.run(async () => {
              await api.setFxRate(rate.from.trim().toUpperCase(), rate.to.trim().toUpperCase(), Number(rate.value));
              await rates.reload();
              return `Rate ${rate.from.toUpperCase()} → ${rate.to.toUpperCase()} saved.`;
            });
          }}>
            <Field label="From" value={rate.from} onChange={(v) => setRate((r) => ({ ...r, from: v }))} required />
            <Field label="To" value={rate.to} onChange={(v) => setRate((r) => ({ ...r, to: v }))} required />
            <Field label="Rate" type="number" step="0.000001" min="0.000001" value={rate.value} onChange={(v) => setRate((r) => ({ ...r, value: v }))} required />
            <button type="submit" className="cta green" disabled={act.busy}>Set rate</button>
          </form>
        </section>
        <section className="card">
          <div className="card-head"><h2>Convert</h2></div>
          <form className="form-row" onSubmit={(e) => {
            e.preventDefault();
            void act.run(async () => {
              const out = await api.convert(Number(conv.amount), conv.from.trim().toUpperCase(), conv.to.trim().toUpperCase());
              setConverted(`${num(Number(conv.amount), 2)} ${conv.from.toUpperCase()} = ${num(out, 2)} ${conv.to.toUpperCase()}`);
            });
          }}>
            <Field label="Amount" type="number" step="0.01" min="0" value={conv.amount} onChange={(v) => setConv((c) => ({ ...c, amount: v }))} required />
            <Field label="From" value={conv.from} onChange={(v) => setConv((c) => ({ ...c, from: v }))} required />
            <Field label="To" value={conv.to} onChange={(v) => setConv((c) => ({ ...c, to: v }))} required />
            <button type="submit" className="cta" disabled={act.busy}>Convert</button>
          </form>
          {converted && <div className="big">{converted}</div>}
        </section>
      </div>
    </>
  );
}

export function Erp() {
  const events = useLoad(api.erpEvents);
  const act = useAction();

  const download = () => act.run(async () => {
    const blob = await api.erpInvoicesCsv();
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'invoices.csv';
    a.click();
    URL.revokeObjectURL(url);
    return 'invoices.csv downloaded.';
  });

  const push = () => act.run(async () => {
    const sent = await api.erpPush();
    await events.reload();
    return sent.length === 0 ? 'Nothing new to push.' : `${sent.length} invoice event(s) processed — see the log below.`;
  });

  return (
    <section className="card tbl-scroll">
      <div className="card-head">
        <h2>ERP integration</h2>
        <div className="inline-actions">
          <button className="cta" disabled={act.busy} onClick={() => void download()}>Download invoices CSV</button>
          <button className="cta green" disabled={act.busy} onClick={() => void push()}>Push to webhook</button>
        </div>
      </div>
      <Notice error={act.error} ok={act.ok} />
      <table>
        <thead><tr><th>When</th><th>Target</th><th>Event</th><th>Reference</th><th>Status</th><th>Detail</th></tr></thead>
        <tbody>
          <Rows state={events} cols={6} empty="No outbound events yet.">
            {(rows) => rows.map((e) => (
              <tr key={e.id}>
                <td>{when(e.at)}</td><td>{e.target}</td><td>{e.kind}</td><td><b>{e.reference}</b></td>
                <td><StatusChip status={e.status} /></td><td>{e.detail ?? ''}</td>
              </tr>
            ))}
          </Rows>
        </tbody>
      </table>
    </section>
  );
}

export default function FinancePages({ initialTab = 'invoices', customer }: { initialTab?: Tab; customer?: string }) {
  const [tab, setTab] = useState<Tab>(initialTab);
  const trial = useLoad(api.trialBalance);
  const unbilled = useLoad(api.unbilled);
  const act = useAction();
  const unbilledTotal = moneyTotal(Object.entries(unbilled.data ?? {}).map(([name, amount]) => ({ amount: Number(amount), currency: currencyOf(name) })));
  const refresh = () => Promise.all([trial.reload(), unbilled.reload()]);

  const billing = () => act.run(async () => {
    const r = await api.billingRun();
    await refresh();
    return r.invoices === 0 ? 'Nothing to bill.' : `Billed ${money(r.billed)} on ${r.invoices} invoice(s): ${r.numbers.join(', ')}`;
  });

  return (
    <>
      <PageHead icon="finance" title="Finance" sub="Billing, ledger, settlement, currency and ERP hand-off">
        <button className="cta green" disabled={act.busy} onClick={() => void billing()}>Run billing</button>
      </PageHead>
      <Notice error={act.error || trial.error} ok={act.ok} />
      <StatStrip items={[
        { icon: 'scale', label: 'Trial balance', value: trial.data ? (trial.data.balanced ? 'Balanced' : 'OUT OF BALANCE') : '…', sub: trial.data ? `${trial.data.entries} ledger entries` : 'Loading' },
        { icon: 'wallet', label: 'Debits', value: trial.data ? money(trial.data.debits) : '…', sub: 'Total posted' },
        { icon: 'receipt', label: 'Credits', value: trial.data ? money(trial.data.credits) : '…', sub: 'Total posted' },
        { icon: 'clock', label: 'Unbilled', value: unbilledTotal, sub: `${Object.keys(unbilled.data ?? {}).length} customers with unbilled fuel` },
      ]} />
      <div style={{ marginTop: '0.85rem' }}>
        <Tabs tabs={TABS} value={tab} onChange={(t) => { act.clear(); setTab(t); }} />
        {tab === 'invoices' && <Invoices onChange={() => void refresh()} />}
        {tab === 'ledger' && <Ledger />}
        {tab === 'statements' && <Statements initialCustomer={customer} />}
        {tab === 'settlement' && <Settlement />}
        {tab === 'fx' && <Fx />}
        {tab === 'erp' && <Erp />}
      </div>
    </>
  );
}
