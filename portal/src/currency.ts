import { api } from './api';

const DEFAULT_CURRENCY = 'ZAR';

let ownCurrency = DEFAULT_CURRENCY;
let ownOrganizationName = '';
const byOrganization = new Map<string, string>();

/**
 * Loads each organization's billing currency once after sign-in (and again after registering one). Customers
 * only see their own organization; staff roles that see every customer get a full lookup.
 * Anything not in the lookup falls back to the signed-in user's own currency.
 * Call with no argument to refresh for the organization given on the last sign-in.
 */
export async function loadCurrencies(ownOrganization?: string): Promise<void> {
  if (ownOrganization !== undefined) ownOrganizationName = ownOrganization;
  try {
    const orgs = await api.organizations();
    byOrganization.clear();
    for (const o of orgs) if (o.currency) byOrganization.set(o.name.toLowerCase(), o.currency);
  } catch {
    // keep whatever was loaded before; amounts then fall back to the user's own currency
  }
  ownCurrency = byOrganization.get(ownOrganizationName.toLowerCase()) ?? DEFAULT_CURRENCY;
}

export const ownCurrencyCode = () => ownCurrency;

/** The billing currency of an organization, or the signed-in user's own currency when it is unknown. */
export const currencyOf = (organization?: string | null) =>
  (organization && byOrganization.get(organization.toLowerCase())) || ownCurrency;

const AMOUNT = { minimumFractionDigits: 2, maximumFractionDigits: 2 } as const;

/** ZAR keeps the "R" prefix; every other currency is shown with its ISO code. */
export const currencyPrefix = (currency: string) => (currency === 'ZAR' ? 'R' : currency);

export const money = (n: number, currency?: string | null) =>
  `${currencyPrefix(currency || ownCurrency)} ${Number(n).toLocaleString(undefined, AMOUNT)}`;

/** Amount in the billing currency of the named organization. */
export const moneyFor = (n: number, organization?: string | null) => money(n, currencyOf(organization));

/** The one currency all of these share, or null when they are mixed (or there are none). */
export function sharedCurrency(codes: string[]): string | null {
  const unique = new Set(codes);
  return unique.size === 1 ? [...unique][0] : null;
}

/** Sums amounts per currency, so customers billed in different currencies are never added together. */
export function moneyTotal(items: { amount: number; currency: string }[]): string {
  const totals = new Map<string, number>();
  for (const i of items) totals.set(i.currency, (totals.get(i.currency) ?? 0) + Number(i.amount));
  if (totals.size === 0) return money(0);
  return [...totals].map(([currency, amount]) => money(amount, currency)).join(' + ');
}
