import { useState } from 'react';
import { api, type FuelOrder, type FuelTransaction, type Session, type Site } from './api';
import ExportMenu from './ExportMenu';
import { currencyOf, money, moneyFor, moneyTotal, sharedCurrency } from './currency';
import type { ExportSpec } from './exporter';
import { lower, matches, sumOf } from './OmcShared';
import StaffPages from './StaffPages';
import { Field, Notice, PageHead, Rows, Select, StatusChip, Tabs, num, useLoad, when } from './ui';

/* ── Customer balances (Financial Management) ─────────────────── */
export function CustomerBalances() {
  const standings = useLoad(api.standings);
  const rows = standings.data ?? [];
  const util = (s: { creditLimit: number; used: number; committed: number }) =>
    (Number(s.creditLimit) > 0 ? ((Number(s.used) + Number(s.committed)) / Number(s.creditLimit)) * 100 : null);

  const exportSpec = (): ExportSpec => {
    const currency = sharedCurrency(rows.map((s) => currencyOf(s.organization)));
    const amount = currency ? 'money' : 'number';
    return {
      title: 'Customer balances and credit',
      subtitle: `${rows.length} customers`,
      filename: 'customer-balances',
      currency: currency ?? undefined,
      columns: [
        { header: 'Customer' }, { header: 'Currency' }, { header: 'Terms' }, { header: 'Credit limit', type: amount }, { header: 'Used', type: amount },
        { header: 'Committed', type: amount }, { header: 'Available', type: amount }, { header: 'Utilisation', type: 'percent' },
        { header: 'Monthly budget', type: amount }, { header: 'Month spend', type: amount },
      ],
      rows: rows.map((s) => [s.organization, currencyOf(s.organization), lower(s.terms), Number(s.creditLimit), Number(s.used), Number(s.committed), Number(s.available),
        util(s), Number(s.monthlyBudget), Number(s.monthSpend)]),
      // amounts in different currencies are never added together
      totals: currency
        ? ['Total', '', '', sumOf(rows.map((s) => Number(s.creditLimit))), sumOf(rows.map((s) => Number(s.used))), sumOf(rows.map((s) => Number(s.committed))),
          sumOf(rows.map((s) => Number(s.available))), '', sumOf(rows.map((s) => Number(s.monthlyBudget))), sumOf(rows.map((s) => Number(s.monthSpend)))]
        : undefined,
    };
  };

  return (
    <section className="card tbl-scroll">
      <div className="card-head">
        <h2>Customer balances</h2>
        <div className="head-tools"><small className="muted">Edit limits on the Customer Management page</small><ExportMenu build={exportSpec} disabled={rows.length === 0} /></div>
      </div>
      <Notice error={standings.error && standings.data ? standings.error : ''} />
      <table>
        <thead><tr><th>Customer</th><th>Terms</th><th>Credit limit</th><th>Used</th><th>Committed</th><th>Available</th><th>Utilisation</th><th>Budget · month spend</th></tr></thead>
        <tbody>
          <Rows state={standings} cols={8} empty="No customer accounts yet.">
            {(list) => list.map((s) => {
              const u = util(s);
              return (
                <tr key={s.organization}>
                  <td><b>{s.organization}</b></td><td>{lower(s.terms)}</td><td>{moneyFor(s.creditLimit, s.organization)}</td><td>{moneyFor(s.used, s.organization)}</td>
                  <td>{moneyFor(s.committed, s.organization)}</td><td><b>{moneyFor(s.available, s.organization)}</b></td>
                  <td style={{ minWidth: 130 }}>
                    {u === null ? <small className="muted">no limit set</small> : (
                      <>
                        <small>{num(u, u < 10 ? 1 : 0)}%</small>
                        <div className="usage-bar"><i style={{ width: `${Math.min(u, 100)}%` }} className={u > 80 ? 'hot' : ''} /></div>
                      </>
                    )}
                  </td>
                  <td>{moneyFor(s.monthlyBudget, s.organization)}<br /><small>{moneyFor(s.monthSpend, s.organization)} this month</small></td>
                </tr>
              );
            })}
          </Rows>
        </tbody>
      </table>
    </section>
  );
}

/* ── Reports & Analytics ──────────────────────────────────────── */
type ReportTab = 'insights' | 'transactions' | 'orders' | 'inventory' | 'customers';
const REPORT_TABS: [ReportTab, string][] = [
  ['insights', 'Insights'], ['transactions', 'Transactions report'], ['orders', 'Orders report'],
  ['inventory', 'Inventory report'], ['customers', 'Customer report'],
];

const localDate = (iso: string) => {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const inRange = (iso: string, from: string, to: string) => {
  const d = localDate(iso);
  return (!from || d >= from) && (!to || d <= to);
};

function DateRange({ from, to, onFrom, onTo }: { from: string; to: string; onFrom: (v: string) => void; onTo: (v: string) => void }) {
  return (
    <div className="form-row">
      <Field label="From" type="date" value={from} onChange={onFrom} />
      <Field label="To" type="date" value={to} onChange={onTo} />
      {(from || to) && <button type="button" className="mini-btn" onClick={() => { onFrom(''); onTo(''); }}>Clear dates</button>}
    </div>
  );
}

const rangeText = (from: string, to: string) => (from || to ? `${from || 'start'} to ${to || 'today'}` : 'All dates');

function TransactionsReport({ orders, transactions }: { orders: FuelOrder[]; transactions: FuelTransaction[] }) {
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [query, setQuery] = useState('');
  const byOrder = new Map(orders.map((o) => [o.id, o]));
  const currencyFor = (t: FuelTransaction) => currencyOf(byOrder.get(t.orderId)?.customerName);
  const rows = transactions.filter((t) => inRange(t.dispensedAt, from, to)
    && matches(query, t.vehicleReg, t.driverName, t.siteName, t.attendantName, byOrder.get(t.orderId)?.customerName, byOrder.get(t.orderId)?.number));
  const litres = sumOf(rows.map((t) => Number(t.volumeLitres)));
  const amount = sumOf(rows.map((t) => Number(t.amount)));
  const amountText = moneyTotal(rows.map((t) => ({ amount: Number(t.amount), currency: currencyFor(t) })));

  const exportSpec = (): ExportSpec => {
    const currency = sharedCurrency(rows.map(currencyFor));
    const amountType = currency ? 'money' : 'number';
    return {
      title: 'Transactions report',
      subtitle: `${rangeText(from, to)} · ${rows.length} dispenses`,
      filename: 'transactions',
      currency: currency ?? undefined,
      columns: [
        { header: 'Date', type: 'datetime' }, { header: 'Order' }, { header: 'Customer' }, { header: 'Currency' }, { header: 'Vehicle' }, { header: 'Driver' }, { header: 'Site' },
        { header: 'Attendant' }, { header: 'Litres', type: 'litres' }, { header: 'Unit price', type: amountType }, { header: 'Amount', type: amountType },
      ],
      rows: rows.map((t) => [t.dispensedAt, byOrder.get(t.orderId)?.number, byOrder.get(t.orderId)?.customerName, currencyFor(t), t.vehicleReg, t.driverName,
        t.siteName, t.attendantName, Number(t.volumeLitres), Number(t.unitPrice), Number(t.amount)]),
      totals: ['Total', '', '', '', '', '', '', '', litres, '', currency ? amount : ''],
    };
  };

  return (
    <section className="card">
      <div className="card-head">
        <h2>All dispenses</h2>
        <div className="head-tools"><small className="muted">{rows.length} dispenses · {num(litres)} L · {amountText}</small><ExportMenu build={exportSpec} disabled={rows.length === 0} /></div>
      </div>
      <DateRange from={from} to={to} onFrom={setFrom} onTo={setTo} />
      <label className="search-box" style={{ marginBottom: '0.7rem' }}>
        <input type="search" value={query} placeholder="Customer, vehicle, driver, site…" onChange={(e) => setQuery(e.target.value)} />
      </label>
      <div className="tbl-scroll">
        <table>
          <thead><tr><th>Date</th><th>Order · customer</th><th>Vehicle · driver</th><th>Site · attendant</th><th>Litres</th><th>Price</th><th>Amount</th></tr></thead>
          <tbody>
            {rows.length === 0 && <tr><td colSpan={7} className="empty">No dispenses in this range.</td></tr>}
            {rows.map((t) => (
              <tr key={t.id}>
                <td>{when(t.dispensedAt)}</td>
                <td><b>{byOrder.get(t.orderId)?.number ?? '—'}</b><br /><small>{byOrder.get(t.orderId)?.customerName ?? ''}</small></td>
                <td>{t.vehicleReg}<br /><small>{t.driverName}</small></td>
                <td>{t.siteName}<br /><small>{t.attendantName}</small></td>
                <td>{num(t.volumeLitres)} L</td><td>{money(Number(t.unitPrice), currencyFor(t))} / L</td><td><b>{money(Number(t.amount), currencyFor(t))}</b></td>
              </tr>
            ))}
          </tbody>
          {rows.length > 0 && <tfoot><tr><td colSpan={4}><b>Total</b></td><td><b>{num(litres)} L</b></td><td /><td><b>{amountText}</b></td></tr></tfoot>}
        </table>
      </div>
    </section>
  );
}

const ORDER_STATUSES = ['ALL', 'PENDING_CUSTOMER_APPROVAL', 'PENDING_APPROVAL', 'AUTHORIZED', 'FULFILLED', 'REJECTED', 'CANCELLED'];

function OrdersReport({ orders }: { orders: FuelOrder[] }) {
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [status, setStatus] = useState('ALL');
  const rows = orders.filter((o) => inRange(o.createdAt, from, to) && (status === 'ALL' || o.status === status));
  const litres = sumOf(rows.map((o) => Number(o.quantityLitres)));
  const valueOf = (o: FuelOrder) => Number(o.quantityLitres) * Number(o.unitPriceSnapshot);
  const valueText = moneyTotal(rows.map((o) => ({ amount: valueOf(o), currency: currencyOf(o.customerName) })));

  const exportSpec = (): ExportSpec => {
    const currency = sharedCurrency(rows.map((o) => currencyOf(o.customerName)));
    const amountType = currency ? 'money' : 'number';
    return {
      title: 'Orders report',
      subtitle: `${rangeText(from, to)} · ${status === 'ALL' ? 'all statuses' : lower(status)} · ${rows.length} orders`,
      filename: 'orders-report',
      currency: currency ?? undefined,
      columns: [
        { header: 'Order' }, { header: 'Created', type: 'datetime' }, { header: 'Customer' }, { header: 'Currency' }, { header: 'Vehicle' }, { header: 'Driver' }, { header: 'Site' },
        { header: 'Product' }, { header: 'Litres', type: 'litres' }, { header: 'Unit price', type: amountType }, { header: 'Value', type: amountType }, { header: 'Status' },
      ],
      rows: rows.map((o) => [o.number, o.createdAt, o.customerName, currencyOf(o.customerName), o.vehicleReg, o.driverName, o.siteName, o.fuelProduct, Number(o.quantityLitres),
        Number(o.unitPriceSnapshot), valueOf(o), lower(o.status)]),
      totals: ['Total', '', '', '', '', '', '', '', litres, '', currency ? sumOf(rows.map(valueOf)) : '', ''],
    };
  };

  return (
    <section className="card">
      <div className="card-head">
        <h2>Orders</h2>
        <div className="head-tools"><small className="muted">{rows.length} orders · {num(litres)} L · {valueText}</small><ExportMenu build={exportSpec} disabled={rows.length === 0} /></div>
      </div>
      <div className="form-row">
        <Field label="From" type="date" value={from} onChange={setFrom} />
        <Field label="To" type="date" value={to} onChange={setTo} />
        <Select label="Status" value={status} onChange={setStatus} options={ORDER_STATUSES.map((s): [string, string] => [s, s === 'ALL' ? 'All statuses' : lower(s)])} />
      </div>
      <div className="tbl-scroll">
        <table>
          <thead><tr><th>Order</th><th>Created</th><th>Customer</th><th>Vehicle · driver</th><th>Site</th><th>Litres</th><th>Value</th><th>Status</th></tr></thead>
          <tbody>
            {rows.length === 0 && <tr><td colSpan={8} className="empty">No orders in this range.</td></tr>}
            {rows.map((o) => (
              <tr key={o.id}>
                <td><b>{o.number}</b></td><td>{when(o.createdAt)}</td><td>{o.customerName}</td>
                <td>{o.vehicleReg}<br /><small>{o.driverName}</small></td><td>{o.siteName}</td><td>{num(o.quantityLitres)} L</td>
                <td>{moneyFor(valueOf(o), o.customerName)}</td><td><StatusChip status={o.status} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function InventoryReport() {
  const stock = useLoad(api.stock);
  const exceptions = useLoad(api.reconExceptions);
  const levels = stock.data ?? [];
  const variances = exceptions.data ?? [];

  const stockExport = (): ExportSpec => ({
    title: 'Inventory report — stock levels',
    subtitle: `${levels.length} tanks`,
    filename: 'inventory-stock',
    columns: [
      { header: 'Site' }, { header: 'Product' }, { header: 'Capacity (L)', type: 'litres' }, { header: 'Book stock (L)', type: 'litres' },
      { header: 'Reorder level (L)', type: 'litres' }, { header: 'Fill', type: 'percent' }, { header: 'State' },
    ],
    rows: levels.map((t) => [t.siteCode, t.product, Number(t.capacityLitres), Number(t.bookLitres), Number(t.reorderLitres), Number(t.percent),
      t.belowReorder ? 'below reorder' : 'ok']),
    totals: ['Total', '', sumOf(levels.map((t) => Number(t.capacityLitres))), sumOf(levels.map((t) => Number(t.bookLitres))), '', '', ''],
  });
  const varianceExport = (): ExportSpec => ({
    title: 'Inventory report — variance exceptions',
    subtitle: `${variances.length} exceptions`,
    filename: 'inventory-variances',
    columns: [
      { header: 'Created', type: 'datetime' }, { header: 'Site' }, { header: 'Product' }, { header: 'Kind' }, { header: 'Expected (L)', type: 'litres' },
      { header: 'Actual (L)', type: 'litres' }, { header: 'Variance (L)', type: 'litres' }, { header: 'Status' }, { header: 'Resolution' },
    ],
    rows: variances.map((x) => [x.createdAt, x.siteCode, x.product, lower(x.kind), Number(x.expectedLitres), Number(x.actualLitres),
      Number(x.varianceLitres), lower(x.status), x.note]),
  });

  return (
    <>
      <section className="card tbl-scroll">
        <div className="card-head"><h2>Stock levels</h2><ExportMenu build={stockExport} disabled={levels.length === 0} /></div>
        <table>
          <thead><tr><th>Site · product</th><th>Capacity</th><th>Book stock</th><th>Reorder level</th><th>Fill</th><th>State</th></tr></thead>
          <tbody>
            <Rows state={stock} cols={6} empty="No tanks configured.">
              {(list) => list.map((t) => (
                <tr key={`${t.siteCode}-${t.product}`}>
                  <td><b>{t.siteCode}</b><br /><small>{t.product}</small></td><td>{num(t.capacityLitres, 0)} L</td><td>{num(t.bookLitres, 0)} L</td>
                  <td>{num(t.reorderLitres, 0)} L</td><td>{num(t.percent, 0)}%</td>
                  <td>{t.belowReorder ? <span className="chip chip-pending_approval">below reorder</span> : <span className="chip chip-ok">ok</span>}</td>
                </tr>
              ))}
            </Rows>
          </tbody>
        </table>
      </section>
      <section className="card tbl-scroll" style={{ marginTop: '0.85rem' }}>
        <div className="card-head"><h2>Variance exceptions</h2><ExportMenu build={varianceExport} disabled={variances.length === 0} /></div>
        <table>
          <thead><tr><th>Site · product</th><th>Kind</th><th>Expected</th><th>Actual</th><th>Variance</th><th>Status</th><th>Created</th></tr></thead>
          <tbody>
            <Rows state={exceptions} cols={7} empty="No variance exceptions recorded.">
              {(list) => list.map((x) => (
                <tr key={x.id}>
                  <td><b>{x.siteCode}</b><br /><small>{x.product ?? 'all products'}</small></td><td>{lower(x.kind)}</td>
                  <td>{num(x.expectedLitres)} L</td><td>{num(x.actualLitres)} L</td>
                  <td><b>{x.varianceLitres > 0 ? '+' : ''}{num(x.varianceLitres)} L</b></td><td><StatusChip status={x.status} /></td><td>{when(x.createdAt)}</td>
                </tr>
              ))}
            </Rows>
          </tbody>
        </table>
      </section>
    </>
  );
}

function CustomerReport({ orders, transactions }: { orders: FuelOrder[]; transactions: FuelTransaction[] }) {
  const standings = useLoad(api.standings);
  const customerOf = new Map(orders.map((o) => [o.id, o.customerName]));
  const rows = (standings.data ?? []).map((s) => {
    const mine = orders.filter((o) => o.customerName === s.organization);
    const tx = transactions.filter((t) => customerOf.get(t.orderId) === s.organization);
    return {
      customer: s.organization, orders: mine.length, fulfilled: mine.filter((o) => o.status === 'FULFILLED').length,
      litres: sumOf(tx.map((t) => Number(t.volumeLitres))), spend: sumOf(tx.map((t) => Number(t.amount))),
      balance: Number(s.used), available: Number(s.available), limit: Number(s.creditLimit),
    };
  });

  const exportSpec = (): ExportSpec => {
    const currency = sharedCurrency(rows.map((r) => currencyOf(r.customer)));
    const amountType = currency ? 'money' : 'number';
    return {
      title: 'Customer report',
      subtitle: `${rows.length} customers · orders, fuel drawn, spend and credit balance`,
      filename: 'customer-report',
      currency: currency ?? undefined,
      columns: [
        { header: 'Customer' }, { header: 'Currency' }, { header: 'Orders', type: 'number' }, { header: 'Fulfilled', type: 'number' }, { header: 'Litres drawn', type: 'litres' },
        { header: 'Spend', type: amountType }, { header: 'Credit limit', type: amountType }, { header: 'Balance used', type: amountType }, { header: 'Available', type: amountType },
      ],
      rows: rows.map((r) => [r.customer, currencyOf(r.customer), r.orders, r.fulfilled, r.litres, r.spend, r.limit, r.balance, r.available]),
      totals: ['Total', '', sumOf(rows.map((r) => r.orders)), sumOf(rows.map((r) => r.fulfilled)), sumOf(rows.map((r) => r.litres)),
        ...(currency
          ? [sumOf(rows.map((r) => r.spend)), sumOf(rows.map((r) => r.limit)), sumOf(rows.map((r) => r.balance)), sumOf(rows.map((r) => r.available))]
          : ['', '', '', ''])],
    };
  };

  return (
    <section className="card tbl-scroll">
      <div className="card-head"><h2>Customers</h2><ExportMenu build={exportSpec} disabled={rows.length === 0} /></div>
      <table>
        <thead><tr><th>Customer</th><th>Orders</th><th>Litres drawn</th><th>Spend</th><th>Credit limit</th><th>Balance used</th><th>Available</th></tr></thead>
        <tbody>
          <Rows state={{ ...standings, data: standings.data ? rows : null }} cols={7} empty="No customers yet.">
            {(list) => list.map((r) => (
              <tr key={r.customer}>
                <td><b>{r.customer}</b></td><td>{r.orders}<br /><small>{r.fulfilled} fulfilled</small></td><td>{num(r.litres)} L</td>
                <td>{moneyFor(r.spend, r.customer)}</td><td>{moneyFor(r.limit, r.customer)}</td><td>{moneyFor(r.balance, r.customer)}</td><td><b>{moneyFor(r.available, r.customer)}</b></td>
              </tr>
            ))}
          </Rows>
        </tbody>
      </table>
    </section>
  );
}

export function ReportsAnalytics({ user, sites, orders, transactions }: {
  user: Session; sites: Site[]; orders: FuelOrder[]; transactions: FuelTransaction[];
}) {
  const [tab, setTab] = useState<ReportTab>('insights');
  return (
    <>
      <PageHead icon="report" title="Reports & Analytics" sub="Operational, financial, inventory and customer reporting" />
      <Tabs tabs={REPORT_TABS} value={tab} onChange={setTab} />
      {tab === 'insights' && <StaffPages page="insights" user={user} sites={sites} />}
      {tab === 'transactions' && <TransactionsReport orders={orders} transactions={transactions} />}
      {tab === 'orders' && <OrdersReport orders={orders} />}
      {tab === 'inventory' && <InventoryReport />}
      {tab === 'customers' && <CustomerReport orders={orders} transactions={transactions} />}
    </>
  );
}
