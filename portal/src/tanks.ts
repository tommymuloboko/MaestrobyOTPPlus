import type { StockLevel, StockMovement } from './api';

const PRODUCT_NAMES: Record<string, string> = {
  DIESEL_50: 'Diesel 50 ppm',
  DIESEL_500: 'Diesel 500 ppm',
  ULP_93: 'Unleaded Petrol 93',
  ULP_95: 'Unleaded Petrol 95',
};

export const productName = (code: string) =>
  PRODUCT_NAMES[code] ?? code.replaceAll('_', ' ').toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());

export const tankKey = (siteCode: string, product: string) => `${siteCode}|${product}`;

/** Diesel is amber and petrol green, matching the tank cards. */
export const productColor = (product: string) => (product.startsWith('DIESEL') ? '#d98b00' : '#1b9a3a');

/** Tanks are numbered within their site, in the order the stock levels arrive. */
export function numberTanks(levels: StockLevel[]): Map<string, number> {
  const perSite = new Map<string, number>();
  const numbers = new Map<string, number>();
  for (const l of levels) {
    const n = (perSite.get(l.siteCode) ?? 0) + 1;
    perSite.set(l.siteCode, n);
    numbers.set(tankKey(l.siteCode, l.product), n);
  }
  return numbers;
}

export interface TankEvent { id: string; at: number; kind: string; litres: number; after: number }

/**
 * Rebuilds a tank's level history from the stock ledger. The current book level is known exactly, so walking back
 * through the movements (newest first) undoes each one to give the level before it. `opening` is the level before
 * the oldest movement that was supplied.
 */
export function tankEvents(currentLitres: number, movements: StockMovement[]): { events: TankEvent[]; opening: number } {
  const newestFirst = [...movements].sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  let level = currentLitres;
  const events: TankEvent[] = [];
  for (const m of newestFirst) {
    const litres = Number(m.litres);
    events.push({ id: m.id, at: Date.parse(m.at), kind: m.kind, litres, after: level });
    level -= litres;
  }
  return { events: events.reverse(), opening: level };
}

/** The level at a moment in time: the result of the last movement up to then, or the opening level. */
export function levelAt(events: TankEvent[], opening: number, t: number): number {
  let level = opening;
  for (const e of events) {
    if (e.at > t) break;
    level = e.after;
  }
  return level;
}

export const MOVEMENT_LABELS: Record<string, { label: string; chip: string }> = {
  DISPENSE: { label: 'dispense', chip: 'chip-issued' },
  DELIVERY_IN: { label: 'delivery in', chip: 'chip-delivered' },
  DELIVERY_OUT: { label: 'delivery out', chip: 'chip-in_transit' },
  ADJUSTMENT: { label: 'adjustment', chip: 'chip-pending' },
};
