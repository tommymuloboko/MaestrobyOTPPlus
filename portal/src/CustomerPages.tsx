import type { ReactNode } from 'react';
import type { FuelOrder, FuelTransaction, Session } from './api';
import {
  CONTRACT_PRODUCT, DAILY_VEHICLE_LIMIT, SUPPLIERS, buildAlerts, dispensedFor, sum, useContract,
} from './customerData';
import ExportMenu from './ExportMenu';
import { currencyPrefix, ownCurrencyCode } from './currency';
import type { ExportSpec } from './exporter';
import InvoicesPage from './InvoicesPage';
import { Ic, PageHead, StatStrip, StatusChip, money } from './ui';

const litres = (n: number) => `${n.toLocaleString(undefined, { maximumFractionDigits: 1 })} L`;

function Bar({ pct }: { pct: number }) {
  return (
    <div className="usage-bar">
      <i style={{ width: `${Math.min(pct, 100)}%` }} className={pct > 80 ? 'hot' : ''} />
    </div>
  );
}

interface Props {
  page: string;
  user: Session;
  orders: FuelOrder[];
  transactions: FuelTransaction[];
  mapCard: ReactNode;
  chartCard: ReactNode;
  onLogout: () => void;
}

export default function CustomerPages({ page, user, orders, transactions, mapCard, chartCard, onLogout }: Props) {
  const org = user.organization;
  const rate = currencyPrefix(ownCurrencyCode());
  const contract = useContract();
  const terms = contract.terms;
  const listPrice = terms.listPrice;
  const live = orders.filter((o) => o.status !== 'REJECTED');
  const authorizedOrders = orders.filter((o) => o.status === 'AUTHORIZED' || o.status === 'FULFILLED');
  const authorizedL = sum(authorizedOrders.map((o) => Number(o.quantityLitres)));
  const dispensedL = sum(transactions.map((t) => Number(t.volumeLitres)));
  const invoiced = sum(transactions.map((t) => Number(t.amount)));
  const orderNo = (id: string) => orders.find((o) => o.id === id)?.number ?? '—';

  if (['settings', 'balance', 'suppliers', 'insights'].includes(page)) {
    if (contract.loading) return <section className="card"><div className="empty">Loading your account…</div></section>;
    if (contract.error && !contract.account) return <div className="error inline">{contract.error}</div>;
  }

  switch (page) {
    case 'settings':
      return (
        <>
          <PageHead icon="settings" title="Settings" sub="Your account and contract" />
          <div className="row-2">
            <section className="card">
              <div className="card-head"><h2>Account</h2><Ic n="user" s={16} /></div>
              <dl className="kv">
                <dt>Name</dt><dd>{user.name}</dd>
                <dt>Email</dt><dd>{user.email}</dd>
                <dt>Role</dt><dd>{user.role}</dd>
                <dt>Organization</dt><dd>{org}</dd>
                <dt>Session expires</dt><dd>{new Date(user.expiresAt).toLocaleString()}</dd>
              </dl>
              <button className="btn-ghost" onClick={onLogout}>Sign out</button>
            </section>
            <section className="card">
              <div className="card-head"><h2>Contract</h2><Ic n="receipt" s={16} /></div>
              <dl className="kv">
                <dt>{CONTRACT_PRODUCT} price per litre</dt><dd>{money(terms.price)}</dd>
                <dt>List price</dt><dd>{money(listPrice)}</dd>
                <dt>Payment terms</dt><dd>{terms.terms.replace('_', ' ')}</dd>
                <dt>Credit limit</dt><dd>{terms.credit ? money(terms.credit) : 'Prepaid'}</dd>
                <dt>Monthly budget</dt><dd>{terms.monthlyBudget ? money(terms.monthlyBudget) : '—'}</dd>
              </dl>
              <small className="muted">Prices are agreed with the supplier and can’t be changed from here.</small>
            </section>
          </div>
        </>
      );

    case 'trips':
      return (
        <>
          <PageHead icon="route" title="Trips & Routes" sub="Every fuel trip from your yard to the supplier site" />
          <div className="row-2">
            {mapCard}
            <section className="card">
              <div className="card-head"><h2>Trips</h2><small className="muted">{live.length} planned or complete</small></div>
              <div className="fleet-list">
                {live.map((o) => (
                  <div className="fleet-row" key={o.id}>
                    <div className="fleet-top">
                      <span className="fleet-id">{o.number} <small>· {o.quantityLitres} L {o.fuelProduct}</small></span>
                      <StatusChip status={o.status} />
                    </div>
                    <div className="fleet-mid">
                      <span className="truck-ic"><Ic n="truck" s={20} /></span>
                      <div className="route">
                        <span className="route-end"><b>{o.vehicleReg}</b><small>{o.driverName}</small></span>
                        <div className="route-bar">
                          <i style={{ width: o.status === 'FULFILLED' ? '100%' : o.status === 'AUTHORIZED' ? '55%' : '15%' }} /><em />
                        </div>
                        <span className="route-end right"><b>{o.siteName.split(' ')[0]}</b><small>{o.siteName}</small></span>
                      </div>
                    </div>
                  </div>
                ))}
                {live.length === 0 && <div className="empty">No trips yet — place a fuel order to create one.</div>}
              </div>
            </section>
          </div>
        </>
      );

    case 'allocations': {
      const outstanding = Math.max(authorizedL - dispensedL, 0);
      const buildExport = (): ExportSpec => {
        const lines = live.map((o) => {
          const auth = Number(o.quantityLitres);
          const used = dispensedFor(o.id, transactions);
          return { o, auth, used };
        });
        const authTotal = sum(lines.map((l) => l.auth));
        const usedTotal = sum(lines.map((l) => l.used));
        return {
          title: 'Fuel Allocations',
          subtitle: `${org} · ${lines.length} allocation${lines.length === 1 ? '' : 's'} · authorized, dispensed and balance per order`,
          filename: 'fuel-allocations',
          columns: [
            { header: 'Order' }, { header: 'Vehicle' }, { header: 'Driver' }, { header: 'Supplier site' },
            { header: 'Authorized (L)', type: 'litres' }, { header: 'Dispensed (L)', type: 'litres' },
            { header: 'Balance (L)', type: 'litres' }, { header: 'Used (%)', type: 'percent' }, { header: 'Status' },
          ],
          rows: lines.map(({ o, auth, used }) => [
            o.number, o.vehicleReg, o.driverName, o.siteName, auth, used, Math.max(auth - used, 0),
            auth > 0 ? (used / auth) * 100 : 0, o.status.replaceAll('_', ' ').toLowerCase(),
          ]),
          totals: ['Total', '', '', '', authTotal, usedTotal, Math.max(authTotal - usedTotal, 0),
            authTotal > 0 ? (usedTotal / authTotal) * 100 : 0, ''],
        };
      };
      return (
        <>
          <PageHead icon="fuel" title="Fuel Allocations" sub="Authorized, dispensed and invoiced fuel, reconciled per order">
            <ExportMenu build={buildExport} disabled={live.length === 0} />
          </PageHead>
          <StatStrip items={[
            { icon: 'check', label: 'Authorized', value: litres(authorizedL), sub: `${authorizedOrders.length} approved orders` },
            { icon: 'drop', label: 'Dispensed', value: litres(dispensedL), sub: 'Metered at the pump' },
            { icon: 'gauge', label: 'Not drawn', value: litres(outstanding), sub: 'Authorized minus dispensed' },
            { icon: 'receipt', label: 'Invoiced value', value: money(invoiced), sub: 'At your contract price' },
          ]} />
          <section className="card" style={{ marginTop: '0.85rem' }}>
            <div className="card-head"><h2>Allocations by order</h2><small className="muted">One allocation per vehicle</small></div>
            <table>
              <thead><tr><th>Order</th><th>Vehicle · driver</th><th>Supplier site</th><th>Authorized</th><th>Dispensed</th><th>Balance</th><th>Used</th><th>Status</th></tr></thead>
              <tbody>
                {live.map((o) => {
                  const auth = Number(o.quantityLitres);
                  const used = dispensedFor(o.id, transactions);
                  return (
                    <tr key={o.id}>
                      <td><b>{o.number}</b></td>
                      <td>{o.vehicleReg}<br /><small>{o.driverName}</small></td>
                      <td>{o.siteName}</td>
                      <td>{litres(auth)}</td>
                      <td>{litres(used)}</td>
                      <td>{litres(Math.max(auth - used, 0))}</td>
                      <td style={{ minWidth: 120 }}><Bar pct={(used / auth) * 100} /></td>
                      <td><StatusChip status={o.status} /></td>
                    </tr>
                  );
                })}
                {live.length === 0 && <tr><td colSpan={8} className="empty">No allocations yet.</td></tr>}
              </tbody>
            </table>
          </section>
        </>
      );
    }

    case 'balance': {
      const st = contract.account?.credit;
      if (!st) return null;
      const exposure = Number(st.used) + Number(st.committed);
      const today = new Date().toDateString();
      const vehicles = [...new Set(orders.map((o) => o.vehicleReg))];
      return (
        <>
          <PageHead icon="wallet" title="My balance" sub={`${org} · payment terms ${st.terms.replace('_', ' ')}`} />
          <div className="row-3 even">
            <section className="card">
              <div className="card-head"><h2>Credit account</h2><Ic n="wallet" s={16} /></div>
              <div className="big">{money(Number(st.available))}</div>
              <small className="muted">available of {money(Number(st.creditLimit))} limit</small>
              <Bar pct={Number(st.creditLimit) ? (exposure / Number(st.creditLimit)) * 100 : 0} />
              <small className="muted">{money(Number(st.used))} owed · {money(Number(st.committed))} committed on open orders</small>
            </section>
            <section className="card">
              <div className="card-head"><h2>Monthly budget</h2><Ic n="gauge" s={16} /></div>
              <div className="big">{money(Math.max(Number(st.monthlyBudget) - Number(st.monthSpend), 0))}</div>
              <small className="muted">remaining of {money(Number(st.monthlyBudget))}</small>
              <Bar pct={Number(st.monthlyBudget) ? (Number(st.monthSpend) / Number(st.monthlyBudget)) * 100 : 0} />
              <small className="muted">{money(Number(st.monthSpend))} spent this month</small>
            </section>
            <section className="card">
              <div className="card-head"><h2>Contract price</h2><Ic n="receipt" s={16} /></div>
              <div className="big">{money(terms.price)} <small>/ L {CONTRACT_PRODUCT}</small></div>
              <small className="muted">list price {money(listPrice)} / L</small>
              <span className="chip chip-authorized">saving {money(listPrice - terms.price)} / L</span>
            </section>
          </div>
          <section className="card" style={{ marginTop: '0.85rem' }}>
            <div className="card-head">
              <h2>Fuel limits by vehicle</h2>
              <small className="muted"><span className="sample-tag">Sample data</span> {DAILY_VEHICLE_LIMIT} L per day — limits are not yet configurable in the API</small>
            </div>
            <table>
              <thead><tr><th>Vehicle</th><th>Drawn today</th><th>Daily limit</th><th>Usage</th></tr></thead>
              <tbody>
                {vehicles.map((v) => {
                  const used = sum(transactions
                    .filter((t) => t.vehicleReg === v && new Date(t.dispensedAt).toDateString() === today)
                    .map((t) => Number(t.volumeLitres)));
                  return (
                    <tr key={v}>
                      <td><b>{v}</b></td><td>{litres(used)}</td><td>{DAILY_VEHICLE_LIMIT} L</td>
                      <td style={{ minWidth: 140 }}><Bar pct={(used / DAILY_VEHICLE_LIMIT) * 100} /></td>
                    </tr>
                  );
                })}
                {vehicles.length === 0 && <tr><td colSpan={4} className="empty">Vehicles appear once you place an order.</td></tr>}
              </tbody>
            </table>
          </section>
        </>
      );
    }

    case 'suppliers': {
      const buildExport = (): ExportSpec => ({
        title: 'Fuel Suppliers',
        subtitle: `${org} · stations and depots you can order from`,
        note: 'Supplier type, products and opening hours are sample data; prices, terms and order counts are live.',
        filename: 'fuel-suppliers',
        columns: [
          { header: 'Supplier' }, { header: 'Type' }, { header: 'Products' }, { header: 'Hours' },
          { header: `Your ${CONTRACT_PRODUCT} price (${rate}/L)`, type: 'money' }, { header: 'Terms' },
          { header: 'Orders', type: 'number' }, { header: 'Litres drawn (L)', type: 'litres' },
        ],
        rows: SUPPLIERS.map((s) => {
          const theirs = orders.filter((o) => o.siteCode === s.code);
          return [s.name, s.kind, s.products, s.hours, terms.price, terms.terms.replace('_', ' '), theirs.length,
            sum(theirs.map((o) => dispensedFor(o.id, transactions)))];
        }),
      });
      return (
        <>
          <PageHead icon="supplier" title="Fuel Suppliers" sub="Stations and depots you can order from">
            <ExportMenu build={buildExport} disabled={SUPPLIERS.length === 0} />
          </PageHead>
          <section className="card">
            <div className="card-head"><small className="muted"><span className="sample-tag">Sample data</span> Supplier type, products and opening hours; prices, terms and order counts are live.</small></div>
            <table>
              <thead><tr><th>Supplier</th><th>Type</th><th>Products</th><th>Hours</th><th>Your {CONTRACT_PRODUCT} price</th><th>Terms</th><th>Orders</th><th>Litres drawn</th></tr></thead>
              <tbody>
                {SUPPLIERS.map((s) => {
                  const theirs = orders.filter((o) => o.siteCode === s.code);
                  const drawn = sum(theirs.map((o) => dispensedFor(o.id, transactions)));
                  return (
                    <tr key={s.name}>
                      <td><b>{s.name}</b></td>
                      <td>{s.kind}</td>
                      <td><small>{s.products}</small></td>
                      <td>{s.hours}</td>
                      <td>{money(terms.price)} / L</td>
                      <td><span className="chip chip-fulfilled">{terms.terms.replace('_', ' ')}</span></td>
                      <td>{theirs.length}</td>
                      <td>{litres(drawn)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </section>
        </>
      );
    }

    case 'fraud': {
      const alerts = buildAlerts(orders, transactions);
      const protections = [
        ['Single-use OTP', 'A redeemed OTP can never be used again'],
        ['Over-dispense stop', 'Pumps stop at the authorized litres'],
        ['Driver and vehicle binding', 'Each OTP is tied to your named driver and vehicle'],
        ['Price lock', 'Attendants cannot change your agreed price'],
        ['No OTP on rejection', 'Rejected orders never produce a fuel code'],
      ];
      return (
        <>
          <PageHead icon="alert" title="Fraud & Alerts" sub="Maestro Sentinel™ watching your fuel" />
          <div className="row-2">
            <section className="card">
              <div className="card-head"><h2>Alerts</h2><small className="muted">{alerts.length} open</small></div>
              <div className="alert-list">
                {alerts.map((a) => (
                  <div className={`alert-row ${a.severity}`} key={`${a.id}-${a.title}`}>
                    <span className="alert-ic"><Ic n={a.severity} s={16} /></span>
                    <div><b>{a.title}</b><small>{a.detail}</small></div>
                  </div>
                ))}
                {alerts.length === 0 && <div className="empty">All clear — nothing needs your attention.</div>}
              </div>
            </section>
            <section className="card">
              <div className="card-head"><h2>Protections active</h2><Ic n="shield" s={16} /></div>
              <div className="alert-list">
                {protections.map(([t, d]) => (
                  <div className="alert-row ok" key={t}>
                    <span className="alert-ic"><Ic n="check" s={16} /></span>
                    <div><b>{t}</b><small>{d}</small></div>
                  </div>
                ))}
              </div>
            </section>
          </div>
        </>
      );
    }

    case 'insights': {
      const savings = dispensedL * (listPrice - terms.price);
      const fills = transactions.length;
      const byVehicle = new Map<string, number>();
      const byDriver = new Map<string, number>();
      for (const t of transactions) {
        byVehicle.set(t.vehicleReg, (byVehicle.get(t.vehicleReg) ?? 0) + Number(t.volumeLitres));
        byDriver.set(t.driverName, (byDriver.get(t.driverName) ?? 0) + Number(t.volumeLitres));
      }
      const top = (m: Map<string, number>) => [...m.entries()].sort((a, b) => b[1] - a[1])[0];
      const insights: string[] = [];
      if (fills > 0) {
        insights.push(`Your contract price saved you ${money(savings)} against the list price of ${money(listPrice)} / L.`);
        const v = top(byVehicle); const d = top(byDriver);
        if (v) insights.push(`${v[0]} drew the most fuel: ${litres(v[1])}.`);
        if (d) insights.push(`${d[0]} is your highest-consuming driver at ${litres(d[1])}.`);
        const unused = authorizedL - dispensedL;
        if (unused > 0) insights.push(`${litres(unused)} of authorized fuel has not been drawn yet.`);
      }
      return (
        <>
          <PageHead icon="insights" title="Smart Insights" sub="What your fuel data is telling you" />
          <StatStrip items={[
            { icon: 'receipt', label: 'Contract savings', value: money(savings), sub: 'Versus list price' },
            { icon: 'drop', label: 'Average fill', value: fills ? litres(dispensedL / fills) : '—', sub: `${fills} fills` },
            { icon: 'wallet', label: 'Cost per litre', value: dispensedL ? money(invoiced / dispensedL) : '—', sub: 'Effective price paid' },
            { icon: 'check', label: 'Fulfilment', value: orders.length ? `${Math.round((orders.filter((o) => o.status === 'FULFILLED').length / orders.length) * 100)}%` : '—', sub: 'Orders completed' },
          ]} />
          <div className="row-2">
            {chartCard}
            <section className="card">
              <div className="card-head"><h2>Highlights</h2><Ic n="insights" s={16} /></div>
              <div className="alert-list">
                {insights.map((t) => (
                  <div className="alert-row ok" key={t}><span className="alert-ic"><Ic n="info" s={16} /></span><div><b>{t}</b></div></div>
                ))}
                {insights.length === 0 && <div className="empty">Insights appear once fuel has been dispensed.</div>}
              </div>
            </section>
          </div>
        </>
      );
    }

    case 'reports': {
      const reports: { desc: string; spec: ExportSpec }[] = [
        {
          desc: 'Every dispense with litres, price, driver and attendant',
          spec: {
            title: 'Fuel transactions', subtitle: org, filename: 'fuel-transactions',
            columns: [
              { header: 'Date', type: 'datetime' }, { header: 'Order' }, { header: 'Vehicle' }, { header: 'Driver' }, { header: 'Site' },
              { header: 'Litres (L)', type: 'litres' }, { header: `Unit price (${rate}/L)`, type: 'money' }, { header: 'Amount', type: 'money' },
              { header: 'Attendant' },
            ],
            rows: transactions.map((t) => [t.dispensedAt, orderNo(t.orderId), t.vehicleReg, t.driverName, t.siteName,
              Number(t.volumeLitres), Number(t.unitPrice), Number(t.amount), t.attendantName]),
            totals: ['Total', '', '', '', '', dispensedL, '', invoiced, ''],
          },
        },
        {
          desc: 'All orders with status, price and cost centre',
          spec: {
            title: 'Fuel orders', subtitle: org, filename: 'fuel-orders',
            columns: [
              { header: 'Order' }, { header: 'Status' }, { header: 'Vehicle' }, { header: 'Driver' }, { header: 'Product' },
              { header: 'Litres (L)', type: 'litres' }, { header: `Unit price (${rate}/L)`, type: 'money' }, { header: 'Site' },
              { header: 'Cost centre' }, { header: 'Created', type: 'datetime' },
            ],
            rows: orders.map((o) => [o.number, o.status.replaceAll('_', ' ').toLowerCase(), o.vehicleReg, o.driverName, o.fuelProduct,
              Number(o.quantityLitres), Number(o.unitPriceSnapshot), o.siteName, o.costCentre ?? '', o.createdAt]),
          },
        },
        {
          desc: 'Authorized versus dispensed versus invoiced, per order',
          spec: {
            title: 'Allocation reconciliation', subtitle: org, filename: 'allocation-reconciliation',
            columns: [
              { header: 'Order' }, { header: 'Authorized (L)', type: 'litres' }, { header: 'Dispensed (L)', type: 'litres' },
              { header: 'Variance (L)', type: 'litres' }, { header: 'Invoiced', type: 'money' },
            ],
            rows: authorizedOrders.map((o) => {
              const used = dispensedFor(o.id, transactions);
              return [o.number, Number(o.quantityLitres), used, Number(o.quantityLitres) - used, used * Number(o.unitPriceSnapshot)];
            }),
          },
        },
        {
          desc: 'Fills, litres and spend per driver',
          spec: {
            title: 'Driver consumption', subtitle: org, filename: 'driver-consumption',
            columns: [{ header: 'Driver' }, { header: 'Fills', type: 'number' }, { header: 'Litres (L)', type: 'litres' }, { header: 'Amount', type: 'money' }],
            rows: [...new Set(transactions.map((t) => t.driverName))].map((d) => {
              const mine = transactions.filter((t) => t.driverName === d);
              return [d, mine.length, sum(mine.map((t) => Number(t.volumeLitres))), sum(mine.map((t) => Number(t.amount)))];
            }),
          },
        },
      ];
      return (
        <>
          <PageHead icon="report" title="Reports" sub="Print, or download your fuel data as PDF, Excel or CSV" />
          <div className="report-grid">
            {reports.map((r) => (
              <section className="card report" key={r.spec.title}>
                <span className="page-ic"><Ic n="report" s={18} /></span>
                <div className="report-body"><b>{r.spec.title}</b><small>{r.desc}</small><small className="muted">{r.spec.rows.length} rows</small></div>
                <ExportMenu build={() => r.spec} disabled={r.spec.rows.length === 0} />
              </section>
            ))}
          </div>
        </>
      );
    }

    case 'invoices':
      return <InvoicesPage terms={terms.terms} org={org} />;

    default:
      return null;
  }
}
