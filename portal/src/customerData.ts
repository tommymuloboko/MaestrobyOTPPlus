import { api, type Account, type FuelOrder, type FuelTransaction, type ResolvedPrice } from './api';
import { useLoad } from './ui';

export const CUSTOMER_ROLE = 'Fleet Manager';
export const ADMIN_ROLE = 'Platform Admin';
export const OMC_ROLE = 'OMC Administrator';
export const isAdminRole = (role: string) => role === ADMIN_ROLE;
export const isOmcRole = (role: string) => role === OMC_ROLE;
export const isSupplierRole = (role: string) => role === 'Station Manager' || role === ADMIN_ROLE || role === OMC_ROLE;
export const isFinanceRole = (role: string) => role === 'Finance' || role === ADMIN_ROLE || role === OMC_ROLE;

export interface Terms { price: number; listPrice: number; terms: string; credit: number; monthlyBudget: number }

export const CONTRACT_PRODUCT = 'DIESEL_50';

export const VEHICLE_TYPES = ['Truck', 'Tipper', 'Tanker', 'Bus', 'Van', 'Pickup', 'SUV', 'Car', 'Tractor', 'Motorcycle', 'Generator', 'Other'];
export const MIN_VEHICLE_YEAR = 1950;
export const maxVehicleYear = () => new Date().getFullYear() + 1;
export const validYear = (v: string) => v === '' || (/^\d{4}$/.test(v) && Number(v) >= MIN_VEHICLE_YEAR && Number(v) <= maxVehicleYear());
const fetchContract = () => Promise.all([api.account(), api.resolvePrice(CONTRACT_PRODUCT, 1)]);

/** The customer's real credit terms (/account) and contract price for diesel (/pricing/resolve). */
export function useContract() {
  const state = useLoad(fetchContract);
  const [account, price]: [Account | null, ResolvedPrice | null] = state.data ?? [null, null];
  const terms: Terms = {
    price: price?.unitPrice ?? 0,
    listPrice: price?.listPrice ?? 0,
    terms: account?.credit.terms ?? '—',
    credit: account?.credit.creditLimit ?? 0,
    monthlyBudget: account?.credit.monthlyBudget ?? 0,
  };
  return { loading: state.loading, error: state.error, account, price, terms, reload: state.reload };
}

// No endpoint yet for supplier directory details (type, products, opening hours): shown as sample data.
export const SUPPLIERS = [
  { name: 'Maestro Fuel Depot — Johannesburg', code: 'SITE-JHB-001', kind: 'Commercial depot', products: 'Diesel · Petrol · bulk', hours: '24 hours' },
  { name: 'Maestro Fuel Depot — Cape Town', code: 'SITE-CPT-002', kind: 'Commercial depot', products: 'Diesel · Petrol · bulk', hours: '05:00 – 20:00' },
  { name: 'Maestro Fuel Depot — Durban', code: 'SITE-DBN-003', kind: 'Commercial depot', products: 'Diesel · Petrol · bulk', hours: '06:00 – 18:00' },
];

// No endpoint yet for per-vehicle daily limits: shown as sample data.
export const DAILY_VEHICLE_LIMIT = 120;

export type Severity = 'warn' | 'info';
export interface AlertItem { id: string; severity: Severity; title: string; detail: string }

export const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
export const dispensedFor = (orderId: string, tx: FuelTransaction[]) =>
  sum(tx.filter((t) => t.orderId === orderId).map((t) => Number(t.volumeLitres)));

/** Alerts a customer should care about, derived from their own orders and dispenses. */
export function buildAlerts(orders: FuelOrder[], tx: FuelTransaction[]): AlertItem[] {
  const alerts: AlertItem[] = [];
  for (const o of orders) {
    if (o.status === 'REJECTED') {
      alerts.push({ id: o.id, severity: 'warn', title: `${o.number} was rejected`, detail: o.rejectionReason ?? 'No reason given' });
    }
    if (o.status === 'PENDING_APPROVAL') {
      alerts.push({ id: o.id, severity: 'info', title: `${o.number} awaiting supplier approval`, detail: `${o.quantityLitres} L for ${o.vehicleReg}` });
    }
    if (o.status === 'PENDING_CUSTOMER_APPROVAL') {
      alerts.push({ id: o.id, severity: 'warn', title: `${o.number} proposed by your supplier`, detail: `${o.quantityLitres} L for ${o.vehicleReg} — accept or decline in My orders` });
    }
    if (o.status === 'FULFILLED') {
      const authorized = Number(o.quantityLitres);
      const used = dispensedFor(o.id, tx);
      if (used < authorized * 0.9) {
        alerts.push({ id: o.id, severity: 'info', title: `${o.number} under-dispensed`, detail: `${(authorized - used).toFixed(1)} L of the authorized ${authorized} L was not drawn` });
      }
    }
  }
  return alerts;
}
