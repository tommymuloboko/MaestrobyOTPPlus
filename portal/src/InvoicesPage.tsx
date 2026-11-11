import { useState } from 'react';
import { api } from './api';
import ExportMenu from './ExportMenu';
import type { ExportSpec } from './exporter';
import {
  Field, Ic, Notice, PageHead, Rows, StatStrip, StatusChip, money, useAction, useLoad, when,
} from './ui';

const sumOf = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

export default function InvoicesPage({ terms, org }: { terms: string; org: string }) {
  const invoices = useLoad(api.invoices);
  const statement = useLoad(api.statement);
  const payments = useLoad(api.payments);
  const account = useLoad(api.account);
  const act = useAction();
  const [selected, setSelected] = useState('');
  const [amount, setAmount] = useState('');
  const [open, setOpen] = useState('');

  const list = invoices.data ?? [];
  const unpaid = list.filter((i) => i.balance > 0);
  const chosen = unpaid.find((i) => i.invoice.id === selected) ?? unpaid[0];
  const outstanding = unpaid.reduce((s, i) => s + Number(i.balance), 0);
  const received = (payments.data ?? []).reduce((s, p) => s + Number(p.amount), 0);
  const refresh = () => Promise.all([invoices.reload(), statement.reload(), payments.reload(), account.reload()]);

  const invoicesExport = (): ExportSpec => ({
    title: 'Invoices',
    subtitle: `${org} · payment terms ${terms.replace('_', ' ')} · ${list.length} invoice${list.length === 1 ? '' : 's'}`,
    filename: 'invoices',
    columns: [
      { header: 'Invoice' }, { header: 'Fiscal ref' }, { header: 'Issued', type: 'date' }, { header: 'Due', type: 'date' },
      { header: 'Total', type: 'money' }, { header: 'Tax', type: 'money' }, { header: 'Paid', type: 'money' },
      { header: 'Balance', type: 'money' }, { header: 'Status' },
    ],
    rows: list.map((v) => [v.invoice.number, v.invoice.fiscalRef ?? '', v.invoice.issueDate, v.invoice.dueDate,
      Number(v.invoice.total), Number(v.invoice.tax), Number(v.invoice.paid), Number(v.balance), v.status.replaceAll('_', ' ').toLowerCase()]),
    totals: ['Total', '', '', '', sumOf(list.map((v) => Number(v.invoice.total))), sumOf(list.map((v) => Number(v.invoice.tax))),
      sumOf(list.map((v) => Number(v.invoice.paid))), sumOf(list.map((v) => Number(v.balance))), ''],
  });

  const statementRows = statement.data ?? [];
  const statementExport = (): ExportSpec => ({
    title: 'Statement of account',
    subtitle: `${org} · payment terms ${terms.replace('_', ' ')}`,
    filename: 'statement',
    columns: [
      { header: 'When', type: 'datetime' }, { header: 'Type' }, { header: 'Reference' },
      { header: 'Debit', type: 'money' }, { header: 'Credit', type: 'money' }, { header: 'Balance', type: 'money' },
    ],
    rows: statementRows.map((s) => [s.at, s.kind.toLowerCase(), s.reference, Number(s.debit), Number(s.credit), Number(s.balance)]),
    // the balance is a running total, so the closing balance is that of the last line
    totals: ['Closing balance', '', '', sumOf(statementRows.map((s) => Number(s.debit))), sumOf(statementRows.map((s) => Number(s.credit))),
      statementRows.length ? Number(statementRows[statementRows.length - 1].balance) : 0],
  });

  const paymentRows = payments.data ?? [];
  const paymentsExport = (): ExportSpec => ({
    title: 'Payments',
    subtitle: `${org} · ${paymentRows.length} payment${paymentRows.length === 1 ? '' : 's'} received`,
    filename: 'payments',
    columns: [{ header: 'When', type: 'datetime' }, { header: 'Method' }, { header: 'Reference' }, { header: 'Amount', type: 'money' }],
    rows: paymentRows.map((p) => [p.receivedAt, p.method, p.reference ?? '', Number(p.amount)]),
    totals: ['Total', '', '', sumOf(paymentRows.map((p) => Number(p.amount)))],
  });

  const pay = (method: 'CARD' | 'EFT') => act.run(async () => {
    if (!chosen) return;
    const value = Number(amount || chosen.balance);
    await api.payInvoice(chosen.invoice.id, value, method, method === 'CARD' ? 'portal card payment' : 'portal EFT');
    setAmount('');
    await refresh();
    return `${money(value)} paid by ${method.toLowerCase()} against ${chosen.invoice.number}.`;
  });

  return (
    <>
      <PageHead icon="receipt" title="Invoices & Payments" sub={`${org} · payment terms ${terms.replace('_', ' ')}`} />
      <StatStrip items={[
        { icon: 'receipt', label: 'Outstanding', value: money(outstanding), sub: `${unpaid.length} unpaid invoice(s)` },
        { icon: 'wallet', label: 'Credit available', value: account.data ? money(Number(account.data.credit.available)) : '…', sub: account.data ? `of ${money(Number(account.data.credit.creditLimit))} limit` : 'Loading' },
        { icon: 'check', label: 'Payments received', value: money(received), sub: `${payments.data?.length ?? 0} payment(s)` },
        { icon: 'clock', label: 'Exposure', value: account.data ? money(Number(account.data.credit.used) + Number(account.data.credit.committed)) : '…', sub: 'Owed plus committed orders' },
      ]} />
      <section className="card tbl-scroll" style={{ marginTop: '0.85rem' }}>
        <div className="card-head">
          <h2>Invoices</h2>
          <div className="head-tools">
            <small className="muted">Select an unpaid invoice to pay it</small>
            <ExportMenu build={invoicesExport} disabled={list.length === 0} />
          </div>
        </div>
        <table>
          <thead><tr><th>Invoice</th><th>Issued · due</th><th>Total</th><th>Paid</th><th>Balance</th><th>Status</th><th /></tr></thead>
          <tbody>
            <Rows state={invoices} cols={7} empty="No invoices yet — your supplier bills dispensed fuel in a billing run.">
              {(rows) => rows.flatMap((v) => [
                <tr key={v.invoice.id} className={`clickable${chosen?.invoice.id === v.invoice.id ? ' selected' : ''}`}
                  onClick={() => v.balance > 0 && setSelected(v.invoice.id)}>
                  <td><b>{v.invoice.number}</b><br /><small>{v.invoice.fiscalRef ?? ''}</small></td>
                  <td>{v.invoice.issueDate}<br /><small>due {v.invoice.dueDate}</small></td>
                  <td>{money(v.invoice.total)}<br /><small>incl. {v.invoice.taxName} {money(v.invoice.tax)}</small></td>
                  <td>{money(v.invoice.paid)}</td>
                  <td><b>{money(v.balance)}</b></td>
                  <td><StatusChip status={v.status} /></td>
                  <td><button className="mini-btn" onClick={(e) => { e.stopPropagation(); setOpen(open === v.invoice.id ? '' : v.invoice.id); }}>
                    {open === v.invoice.id ? 'Hide lines' : 'Lines'}
                  </button></td>
                </tr>,
                ...(open === v.invoice.id ? [
                  <tr key={`${v.invoice.id}-lines`}>
                    <td colSpan={7}>
                      <table>
                        <thead><tr><th>Order</th><th>Description</th><th>Litres</th><th>Unit price</th><th>Amount</th></tr></thead>
                        <tbody>
                          {v.lines.map((l) => (
                            <tr key={l.id}><td><b>{l.orderNumber}</b></td><td>{l.description}</td><td>{l.litres}</td><td>{money(l.unitPrice)}</td><td>{money(l.amount)}</td></tr>
                          ))}
                        </tbody>
                      </table>
                    </td>
                  </tr>,
                ] : []),
              ])}
            </Rows>
          </tbody>
        </table>
      </section>
      <section className="card" style={{ marginTop: '0.85rem' }}>
        <div className="card-head">
          <h2>{chosen ? `Pay ${chosen.invoice.number}` : 'Pay an invoice'}</h2>
          <small className="muted">Card payments settle immediately</small>
        </div>
        <Notice error={act.error} ok={act.ok} />
        {chosen ? (
          <div className="form-row">
            <Field label={`Amount (balance ${money(chosen.balance)})`} type="number" step="0.01" min="0.01"
              value={amount} onChange={setAmount} placeholder={String(chosen.balance)} />
            <button className="cta green" disabled={act.busy} onClick={() => void pay('CARD')}><Ic n="card" s={13} /> Pay by card</button>
            <button className="cta" disabled={act.busy} onClick={() => void pay('EFT')}>Pay by EFT</button>
          </div>
        ) : <div className="empty">Nothing to pay.</div>}
      </section>
      <div className="row-2">
        <section className="card tbl-scroll">
          <div className="card-head">
            <h2>Statement</h2>
            <ExportMenu build={statementExport} disabled={statementRows.length === 0} />
          </div>
          <table>
            <thead><tr><th>When</th><th>Type</th><th>Reference</th><th>Debit</th><th>Credit</th><th>Balance</th></tr></thead>
            <tbody>
              <Rows state={statement} cols={6} empty="No statement activity yet.">
                {(rows) => rows.map((s, i) => (
                  <tr key={`${s.reference}-${i}`}>
                    <td>{when(s.at)}</td><td>{s.kind.toLowerCase()}</td><td>{s.reference}</td>
                    <td>{s.debit ? money(s.debit) : ''}</td><td>{s.credit ? money(s.credit) : ''}</td><td><b>{money(s.balance)}</b></td>
                  </tr>
                ))}
              </Rows>
            </tbody>
          </table>
        </section>
        <section className="card tbl-scroll">
          <div className="card-head"><h2>Payments</h2><ExportMenu build={paymentsExport} disabled={paymentRows.length === 0} /></div>
          <table>
            <thead><tr><th>When</th><th>Method</th><th>Reference</th><th>Amount</th></tr></thead>
            <tbody>
              <Rows state={payments} cols={4} empty="No payments recorded yet.">
                {(rows) => rows.map((p) => (
                  <tr key={p.id}><td>{when(p.receivedAt)}</td><td>{p.method}</td><td>{p.reference ?? '—'}</td><td><b>{money(p.amount)}</b></td></tr>
                ))}
              </Rows>
            </tbody>
          </table>
        </section>
      </div>
    </>
  );
}
