const BASE = import.meta.env.VITE_API_BASE ?? 'http://localhost:8085/api/v1';

export interface FuelOrder {
  id: string;
  number: string;
  customerName: string;
  siteName: string;
  siteCode: string | null;
  fuelProduct: string;
  quantityLitres: number;
  vehicleReg: string;
  driverName: string;
  costCentre: string | null;
  destination: string | null;
  bulkRef: string | null;
  initiatedBy?: string;
  priceSource?: string | null;
  unitPriceSnapshot: number;
  status: string;
  rejectionReason: string | null;
  createdAt: string;
}

export interface Site { code: string; name: string; kind?: string; pts2Id?: string | null; latitude?: number; longitude?: number }
export interface SiteTank { product: string; capacityLitres: number; reorderLitres: number; openingLitres?: number }
export interface NewSite { name: string; kind: string; pts2Id: string; code?: string; latitude: number; longitude: number; tanks: SiteTank[] }
export interface AppUserView { id: string; email: string; name: string; role: string; organization: string; branchCode: string | null; active: boolean }
/** The temporary password is shown once and cannot be retrieved again. */
export interface UserCreated { user: AppUserView; loginEmail: string; temporaryPassword: string }
export interface UserInput { name: string; role: string; organization?: string; branchCode?: string }

export interface OrderHistory { id: string; fromStatus: string | null; toStatus: string; actor: string; reason: string | null; at: string }
export interface ApprovalPolicy { organization: string; autoApproveMaxLitres: number; enforceCreditLimit: boolean }
export interface Receipt {
  receiptNo: string; orderNumber: string; siteName: string; vehicleReg: string; driverName: string;
  attendantName: string; litres: number; unitPrice: number; amount: number; at: string;
}
export interface Organization {
  id: string; name: string; type: string; status: string; country: string | null; currency: string | null;
  contactEmail: string | null; contactPhone: string | null; registrationNo: string | null;
  brandName: string | null; primaryColor: string | null; createdAt: string;
}
export interface Standing {
  organization: string; creditLimit: number; terms: string; monthlyBudget: number;
  used: number; committed: number; available: number; monthSpend: number;
}
export interface Account { organization: Organization; credit: Standing }
export interface Registered { organization: Organization; loginEmail: string; temporaryPassword: string }
export interface Branding { brandName: string; primaryColor: string; organization: string }
export interface AppNotification {
  id: string; organization: string; recipientName: string | null; phone: string | null; channel: string;
  kind: string; message: string; status: string; reference: string | null; createdAt: string;
}
export interface AuditRow { id: string; at: string; actorEmail: string; actorRole: string | null; organization: string | null; method: string; path: string; status: number; ip: string }
export interface StockLevel {
  siteCode: string; product: string; capacityLitres: number; bookLitres: number; reorderLitres: number;
  percent: number; belowReorder: boolean;
}
/** One line of the book-stock ledger: negative litres leave the tank, positive litres enter it. */
export interface StockMovement { id: string; siteCode: string; product: string; kind: string; litres: number; at: string }
export interface PriceRule {
  id: string; organization: string; product: string; siteCode: string | null; mode: string; value: number;
  minLitres: number; validFrom: string; validTo: string | null; status: string; proposedBy: string;
  decidedBy: string | null; proposedAt: string;
}
export interface PriceHistory {
  id: string; organization: string; product: string; siteCode: string | null; previousPrice: number | null;
  newPrice: number; proposedBy: string; approvedBy: string; effectiveDate: string; at: string;
}
export interface ListPrice { product: string; unitPrice: number; currency: string; validFrom: string }
export interface InvoiceLineRow { id: string; transactionId: string; orderNumber: string; description: string; litres: number; unitPrice: number; amount: number }
export interface InvoiceView {
  invoice: {
    id: string; number: string; organization: string; currency: string; issueDate: string; dueDate: string;
    subtotal: number; taxName: string; taxRatePercent: number; tax: number; total: number; paid: number;
    fiscalRef: string | null;
  };
  status: string; balance: number; lines: InvoiceLineRow[];
}
export interface StatementLine { at: string; kind: string; reference: string; debit: number; credit: number; balance: number }
export interface LedgerRow { id: string; organization: string; account: string; debit: number; credit: number; memo: string | null; at: string }
export interface RiskEvent {
  id: string; rule: string; severity: string; score: number; status: string; organization: string | null;
  siteCode: string | null; vehicleReg: string | null; driverName: string | null; attendantName: string | null;
  details: string; autoAction: string; createdAt: string;
}
export interface SentinelRule { code: string; severity: string; trigger: string; response: string }
export interface CaseView {
  fraudCase: { id: string; status: string; assignedTo: string | null; outcome: string | null; notes: string; openedAt: string };
  event: RiskEvent | null;
}
export interface EvidenceRecord { id: string; riskEventId: string; content: string; prevHash: string; contentHash: string; createdAt: string }
export interface Payment { id: string; invoiceId: string; organization: string; amount: number; method: string; reference: string | null; receivedAt: string }
export interface TrialBalance { debits: number; credits: number; balanced: boolean; entries: number }
export interface FxRate { id: string; fromCurrency: string; toCurrency: string; rate: number; at: string }
export interface SettlementRun {
  id: string; supplier: string; gross: number; feePercent: number; fee: number; net: number;
  periodFrom: string; periodTo: string; status: string; at: string;
}
export interface OutboundEvent { id: string; target: string; kind: string; reference: string; status: string; detail: string | null; at: string }
export interface ResolvedPrice { unitPrice: number; listPrice: number; source: string; ruleId: string | null }

export interface DeviceStatus { id: string; deviceId: string; siteCode: string; kind: string; online: boolean; lastSeen: string }
export interface TankReading {
  id: string; siteCode: string; product: string; volumeLitres: number; temperatureC: number | null;
  waterMm: number | null; tcVolumeLitres: number | null; at: string;
}
export interface PumpEvent { id: string; siteCode: string; pumpId: string; kind: string; value: number | null; at: string }
/** How the API reaches a site's PTS-2 controller, plus its latest poll. The password is never returned. */
export interface Pts2Connection {
  siteCode: string; url: string; username: string; enabled: boolean; updatedAt: string;
  ok: boolean | null; error: string | null; polledAt: string | null; lastSuccessAt: string | null;
  controllerId: string | null; tankCount: number;
}
/** One tank as its PTS-2 reports it; values the probe does not measure are null. */
export interface Pts2Tank {
  tank: number; fuelGradeId: number | null; fuelGradeName: string | null; product: string; status: string;
  alarms: string[]; productHeightMm: number | null; waterHeightMm: number | null; temperatureC: number | null;
  volumeLitres: number | null; tcVolumeLitres: number | null; waterVolumeLitres: number | null;
  ullageLitres: number | null; capacityLitres: number | null; percent: number | null; tankHeightMm: number | null;
  measuredAt: string;
}
export interface Pts2SiteState {
  siteCode: string; ok: boolean; error: string | null; polledAt: string; lastSuccessAt: string | null;
  controllerId: string | null; tanks: Pts2Tank[];
}
export interface Pts2ConnectionInput { url: string; username: string; password: string; enabled: boolean }
/** Fuel grade prices and the prices scheduler, read live from a site's PTS-2. Times are the controller's local time. */
export interface Pts2Grade { id: number; name: string; price: number | null }
export interface Pts2PriceSchedule {
  id: number; enabled: boolean; fuelGradeId: number; fuelGradeName: string | null; price: number | null;
  dateTime: string | null; days: string[]; pending: boolean;
}
export interface Pts2Prices { siteCode: string; controllerTime: string; grades: Pts2Grade[]; schedules: Pts2PriceSchedule[]; freeSlots: number }
export interface Pts2PriceChange {
  id: string; siteCode: string; fuelGradeId: number; fuelGradeName: string | null; previousPrice: number | null;
  newPrice: number; mode: 'IMMEDIATE' | 'SCHEDULED' | 'CANCELLED'; effectiveAt: string; scheduleId: number | null;
  changedBy: string; at: string;
}
/** No effectiveAt changes the prices now. */
export interface Pts2PriceInput { changes: { fuelGradeId: number; price: number }[]; effectiveAt?: string }

export interface ReconRun {
  id: string; siteCode: string; businessDate: string; status: string; dispensedLitres: number;
  totalizerLitres: number; exceptions: number; summary: string; at: string;
}
export interface VarianceException {
  id: string; runId: string; siteCode: string; product: string | null; kind: string; expectedLitres: number;
  actualLitres: number; varianceLitres: number; status: string; note: string | null; resolvedBy: string | null;
  createdAt: string;
}

export interface Delivery {
  id: string; number: string; originSiteCode: string; destinationType: string; destinationSiteCode: string | null;
  destinationName: string | null; destLat: number | null; destLng: number | null; customer: string | null;
  product: string; plannedLitres: number; loadedLitres: number | null; deliveredLitres: number | null;
  sealNumbers: string | null; truckReg: string; driverName: string; surchargePerLitre: number;
  status: string; createdAt: string;
}
export interface GpsPosition { id: string; lat: number; lng: number; speedKph: number | null; at: string }
export interface ProofOfDelivery { id: string; signedBy: string; notes: string | null; deliveredLitres: number; at: string }
export interface DeliveryDetail { delivery: Delivery; track: GpsPosition[]; proof: ProofOfDelivery[] }

export interface CctvEvent {
  id: string; siteCode: string; cameraId: string; kind: string; plate: string | null; confidence: number;
  clipRef: string | null; riskEventId: string | null; at: string;
}

export interface DashboardKpis {
  litresToday: number; salesToday: number; dispensesToday: number; ordersPending: number; openRiskEvents: number;
  criticalRiskEvents: number; openVarianceExceptions: number; tanksBelowReorder: number; overdueInvoices: number;
  outstandingReceivables: number;
}
export interface ConsumptionRow { vehicle: string; fills: number; litres: number; averageFill: number; litresPerActiveDay: number; cost: number }
export interface AnomalyRow { vehicle: string; litres: number; usual: number; zScore: number; at: string }
export interface StockoutRow {
  siteCode: string; product: string; bookLitres: number; averageDailyLitres: number; daysOfCover: number | null;
  predictedStockout: string | null; reorderNow: boolean; suggestedOrderLitres: number;
}

export interface Vehicle {
  id: string;
  organization: string;
  registration: string;
  description: string | null;
  vehicleType: string | null;
  model: string | null;
  modelYear: number | null;
  fuelType: 'PETROL' | 'DIESEL';
  tankCapacityLitres: number;
  active: boolean;
}

export interface Driver {
  id: string;
  organization: string;
  name: string;
  phone: string | null;
  licenseNo: string | null;
  vehicleReg: string | null;
  active: boolean;
  verified: boolean;
  verifiedBy: string | null;
  verifiedAt: string | null;
  accessSuspended: boolean;
  suspendedReason: string | null;
}

export interface NewVehicle {
  registration: string;
  description: string;
  vehicleType?: string;
  model?: string;
  modelYear?: number;
  fuelType: 'PETROL' | 'DIESEL';
  tankCapacityLitres: number;
  customerName?: string;
}

export interface OtpResponse {
  orderId: string;
  orderNumber: string;
  /** Null when the code was only sent by SMS. */
  otp: string | null;
  expiresAt: string;
  note: string;
}

export type OtpStatus = 'ACTIVE' | 'REDEEMED' | 'EXPIRED' | 'REVOKED';
export interface OtpView {
  id: string;
  orderId: string;
  orderNumber: string;
  customer: string;
  vehicleReg: string;
  driverName: string;
  siteName: string;
  fuelProduct: string;
  maxVolumeLitres: number;
  status: OtpStatus;
  expiresAt: string;
  redeemedAt: string | null;
}

export interface ValidateResponse {
  authorizationId: string;
  orderNumber: string;
  driverName: string;
  vehicleReg: string;
  siteName: string;
  fuelProduct: string;
  maxVolumeLitres: number;
  expiresAt: string;
}

export interface FuelTransaction {
  id: string;
  orderId: string;
  siteName: string;
  vehicleReg: string;
  driverName: string;
  attendantName: string;
  volumeLitres: number;
  unitPrice: number;
  amount: number;
  dispensedAt: string;
}

export interface Session {
  token: string;
  email: string;
  name: string;
  role: string;
  organization: string;
  expiresAt: string;
}

// sessionStorage: cleared when the tab closes. Production uses HttpOnly cookies via the gateway.
const SESSION_KEY = 'maestro.session';

export const sessionStore = {
  get(): Session | null {
    try {
      const raw = sessionStorage.getItem(SESSION_KEY);
      if (!raw) return null;
      const s = JSON.parse(raw) as Session;
      return new Date(s.expiresAt) > new Date() ? s : null;
    } catch {
      return null;
    }
  },
  set(s: Session) {
    sessionStorage.setItem(SESSION_KEY, JSON.stringify(s));
  },
  clear() {
    sessionStorage.removeItem(SESSION_KEY);
  },
};

let onUnauthorized: () => void = () => {};
export const setUnauthorizedHandler = (fn: () => void) => {
  onUnauthorized = fn;
};

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const token = sessionStore.get()?.token;
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
  if (res.status === 401 && path !== '/auth/login') {
    sessionStore.clear();
    onUnauthorized();
    throw new Error('Your session has expired. Please sign in again.');
  }
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.detail ?? `${res.status} ${res.statusText}`);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

async function download(path: string): Promise<Blob> {
  const token = sessionStore.get()?.token;
  const res = await fetch(`${BASE}${path}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  if (res.status === 401) {
    sessionStore.clear();
    onUnauthorized();
    throw new Error('Your session has expired. Please sign in again.');
  }
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.detail ?? `${res.status} ${res.statusText}`);
  }
  return res.blob();
}

const post = <T>(path: string, body?: object) =>
  request<T>(path, { method: 'POST', ...(body ? { body: JSON.stringify(body) } : {}) });

/** Multipart upload: the browser sets the content type and boundary itself, so none is passed here. */
async function upload<T>(path: string, file: File, fields: Record<string, string> = {}): Promise<T> {
  const token = sessionStore.get()?.token;
  const form = new FormData();
  Object.entries(fields).forEach(([k, v]) => form.append(k, v));
  form.append('file', file);
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    body: form,
  });
  if (res.status === 401) {
    sessionStore.clear();
    onUnauthorized();
    throw new Error('Your session has expired. Please sign in again.');
  }
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.detail ?? `${res.status} ${res.statusText}`);
  }
  return res.json() as Promise<T>;
}

export type BulkKind = 'vehicles' | 'drivers' | 'orders';
export interface BulkRow { row: number; status: 'OK' | 'ERROR' | 'SKIPPED'; message: string | null; values: Record<string, string> }
export interface BulkResult {
  kind: BulkKind;
  dryRun: boolean;
  imported: boolean;
  total: number;
  valid: number;
  invalid: number;
  skipped: number;
  error: string | null;
  rows: BulkRow[];
  pins: { row: number; name: string; phone: string | null; pin: string }[];
  allocations: { vehicleReg: string; driverName: string; quantityLitres: number }[];
}

export const api = {
  login: (email: string, password: string) =>
    request<Session>('/auth/login', { method: 'POST', body: JSON.stringify({ email, password }) }),
  logout: () => request<void>('/auth/logout', { method: 'POST' }),
  listOrders: () => request<FuelOrder[]>('/orders'),
  createOrder: (payload: object) =>
    request<FuelOrder>('/orders', { method: 'POST', body: JSON.stringify(payload) }),
  createBulkOrder: (payload: object) =>
    request<FuelOrder[]>('/orders/bulk', { method: 'POST', body: JSON.stringify(payload) }),
  listSites: () => request<Site[]>('/sites'),
  addSite: (payload: NewSite) => request<Site>('/sites', { method: 'POST', body: JSON.stringify(payload) }),

  // users (OMC administration)
  users: () => request<AppUserView[]>('/users'),
  addUser: (payload: UserInput & { email: string }) =>
    request<UserCreated>('/users', { method: 'POST', body: JSON.stringify(payload) }),
  updateUser: (id: string, payload: UserInput) =>
    request<AppUserView>(`/users/${id}`, { method: 'PUT', body: JSON.stringify(payload) }),
  setUserActive: (id: string, active: boolean) => post<AppUserView>(`/users/${id}/${active ? 'activate' : 'deactivate'}`),
  resetUserPassword: (id: string) => post<UserCreated>(`/users/${id}/reset-password`),
  deleteUser: (id: string) => request<void>(`/users/${id}`, { method: 'DELETE' }),
  listVehicles: () => request<Vehicle[]>('/vehicles'),
  addVehicle: (payload: object) =>
    request<Vehicle>('/vehicles', { method: 'POST', body: JSON.stringify(payload) }),
  registerVehicle: (payload: NewVehicle) => post<Vehicle>('/vehicles', payload),
  updateVehicle: (id: string, payload: { description?: string; tankCapacityLitres?: number; vehicleType?: string; model?: string; modelYear?: number }) =>
    request<Vehicle>(`/vehicles/${id}`, { method: 'PATCH', body: JSON.stringify(payload) }),
  assignDriver: (vehicleId: string, driverId: string | null) =>
    request<Driver | undefined>(`/vehicles/${vehicleId}/driver`, { method: 'PATCH', body: JSON.stringify({ driverId }) }),
  vehicleFuelling: (id: string) => request<FuelTransaction[]>(`/vehicles/${id}/fuelling`),
  removeVehicle: (id: string) => request<void>(`/vehicles/${id}`, { method: 'DELETE' }),
  listDrivers: () => request<Driver[]>('/drivers'),
  addDriver: (payload: object) =>
    request<{ driver: Driver; pin: string }>('/drivers', { method: 'POST', body: JSON.stringify(payload) }),
  resetPin: (id: string) => request<{ driver: Driver; pin: string }>(`/drivers/${id}/reset-pin`, { method: 'POST' }),
  bulkTemplate: (kind: BulkKind, fuelType?: string) =>
    download(`/bulk/templates/${kind}${fuelType ? `?fuelType=${encodeURIComponent(fuelType)}` : ''}`),
  bulkImport: (kind: 'vehicles' | 'drivers', file: File, dryRun: boolean) =>
    upload<BulkResult>(`/bulk/${kind}?dryRun=${dryRun}`, file),
  bulkOrderParse: (file: File, fuelProduct: string) =>
    upload<BulkResult>('/bulk/orders/parse', file, { fuelProduct }),
  removeDriver: (id: string) => request<void>(`/drivers/${id}`, { method: 'DELETE' }),
  verifyDriver: (id: string) => post<Driver>(`/drivers/${id}/verify`),
  unverifyDriver: (id: string) => post<Driver>(`/drivers/${id}/unverify`),
  suspendDriver: (id: string, reason: string) => post<Driver>(`/drivers/${id}/suspend`, { reason }),
  restoreDriver: (id: string) => post<Driver>(`/drivers/${id}/restore`),
  assignVehicle: (id: string, vehicleReg: string) =>
    request<Driver>(`/drivers/${id}/vehicle`, { method: 'PATCH', body: JSON.stringify({ vehicleReg }) }),
  approve: (id: string) => request<OtpResponse>(`/orders/${id}/approve`, { method: 'POST' }),
  reject: (id: string, reason: string) =>
    request<FuelOrder>(`/orders/${id}/reject`, {
      method: 'POST',
      body: JSON.stringify({ reason }),
    }),
  cancelOrder: (id: string, reason: string) => post<FuelOrder>(`/orders/${id}/cancel`, { reason }),
  amendOrder: (id: string, payload: { quantityLitres?: number; destination?: string; costCentre?: string }) =>
    request<FuelOrder>(`/orders/${id}`, { method: 'PATCH', body: JSON.stringify(payload) }),
  listOtps: () => request<OtpView[]>('/otp'),
  revokeOtp: (id: string, reason: string) => post<unknown>(`/otp/${id}/revoke`, { reason }),
  regenerateOtp: (id: string, reason: string) => post<OtpResponse>(`/otp/${id}/regenerate`, { reason }),
  acceptOrder: (id: string) => request<FuelOrder>(`/orders/${id}/accept`, { method: 'POST' }),
  declineOrder: (id: string, reason: string) =>
    request<FuelOrder>(`/orders/${id}/decline`, { method: 'POST', body: JSON.stringify({ reason }) }),
  orderHistory: (id: string) => request<OrderHistory[]>(`/orders/${id}/history`),
  proposeOrder: (payload: object) =>
    request<FuelOrder>('/orders/supplier', { method: 'POST', body: JSON.stringify(payload) }),
  getPolicy: () => request<ApprovalPolicy>('/orders/policy'),
  setPolicy: (autoApproveMaxLitres: number, enforceCreditLimit: boolean) =>
    request<ApprovalPolicy>('/orders/policy', {
      method: 'PUT',
      body: JSON.stringify({ autoApproveMaxLitres, enforceCreditLimit }),
    }),
  validateOtp: (otp: string, driverPin: string) =>
    request<ValidateResponse>('/dispense/validate', {
      method: 'POST',
      body: JSON.stringify({ otp, driverPin }),
    }),
  completeDispense: (otp: string, driverPin: string, volumeLitres: number) =>
    request<FuelTransaction>('/dispense/complete', {
      method: 'POST',
      body: JSON.stringify({ otp, driverPin, volumeLitres }),
    }),
  listTransactions: () => request<FuelTransaction[]>('/dispense/transactions'),
  receipt: (id: string) => request<Receipt>(`/dispense/transactions/${id}/receipt`),

  // organizations, account, branding
  account: () => request<Account>('/account'),
  organizations: () => request<Organization[]>('/organizations'),
  registerOrganization: (payload: object) =>
    request<Registered>('/organizations', { method: 'POST', body: JSON.stringify(payload) }),
  setCredit: (name: string, payload: object) =>
    request<unknown>(`/organizations/${encodeURIComponent(name)}/credit`, { method: 'PUT', body: JSON.stringify(payload) }),
  standings: () => request<Standing[]>('/credit-accounts'),
  branding: () => request<Branding>('/branding'),
  setBranding: (brandName: string, primaryColor: string) =>
    request<Branding>('/branding', { method: 'PUT', body: JSON.stringify({ brandName, primaryColor }) }),
  notifications: () => request<AppNotification[]>('/notifications'),
  audit: () => request<AuditRow[]>('/audit'),
  stock: () => request<StockLevel[]>('/stock'),
  stockMovements: () => request<StockMovement[]>('/stock/movements'),

  // pricing
  priceRules: () => request<PriceRule[]>('/pricing/rules'),
  priceHistory: () => request<PriceHistory[]>('/pricing/history'),
  listPrices: () => request<ListPrice[]>('/pricing/list'),
  proposeRule: (payload: object) => request<PriceRule>('/pricing/rules', { method: 'POST', body: JSON.stringify(payload) }),
  approveRule: (id: string) => request<PriceRule>(`/pricing/rules/${id}/approve`, { method: 'POST' }),
  rejectRule: (id: string) => request<PriceRule>(`/pricing/rules/${id}/reject`, { method: 'POST' }),

  // finance
  invoices: () => request<InvoiceView[]>('/finance/invoices'),
  billingRun: () => request<{ invoices: number; billed: number; numbers: string[] }>('/finance/billing-run', { method: 'POST' }),
  payInvoice: (id: string, amount: number, method: string, reference?: string) =>
    request<Payment>(`/finance/invoices/${id}/pay`, { method: 'POST', body: JSON.stringify({ amount, method, reference }) }),
  statement: () => request<StatementLine[]>('/finance/statement'),
  ledger: () => request<LedgerRow[]>('/finance/ledger'),
  trialBalance: () => request<{ debits: number; credits: number; balanced: boolean; entries: number }>('/finance/trial-balance'),

  // sentinel
  riskEvents: () => request<RiskEvent[]>('/sentinel/events'),
  sentinelRules: () => request<SentinelRule[]>('/sentinel/rules'),
  fraudCases: () => request<CaseView[]>('/sentinel/cases'),
  assignCase: (id: string) => request<unknown>(`/sentinel/cases/${id}/assign`, { method: 'POST' }),
  noteCase: (id: string, note: string) =>
    request<unknown>(`/sentinel/cases/${id}/notes`, { method: 'POST', body: JSON.stringify({ note }) }),
  closeCase: (id: string, outcome: string) =>
    request<unknown>(`/sentinel/cases/${id}/close`, { method: 'POST', body: JSON.stringify({ outcome }) }),
  verifyEvidence: () => request<{ valid: boolean; records: number }>('/sentinel/evidence/verify'),
  evidenceFor: (riskEventId: string) => request<EvidenceRecord[]>(`/sentinel/events/${riskEventId}/evidence`),
  setEventStatus: (id: string, status: string) => post<RiskEvent>(`/sentinel/events/${id}/status`, { status }),

  // finance extras, FX, settlement, ERP
  payments: () => request<Payment[]>('/finance/payments'),
  unbilled: () => request<Record<string, number>>('/finance/unbilled'),
  statementFor: (customer: string) => request<StatementLine[]>(`/finance/statement?customer=${encodeURIComponent(customer)}`),
  fxRates: () => request<FxRate[]>('/fx'),
  setFxRate: (from: string, to: string, rate: number) =>
    request<FxRate>('/fx', { method: 'PUT', body: JSON.stringify({ from, to, rate }) }),
  convert: (amount: number, from: string, to: string) =>
    request<number>(`/fx/convert?amount=${amount}&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`),
  settlements: () => request<SettlementRun[]>('/finance/settlements'),
  settle: () => post<SettlementRun>('/finance/settlements'),
  markSettlementPaid: (id: string) => post<SettlementRun>(`/finance/settlements/${id}/paid`),
  erpInvoicesCsv: () => download('/integrations/erp/invoices.csv'),
  erpPush: () => post<OutboundEvent[]>('/integrations/erp/push'),
  erpEvents: () => request<OutboundEvent[]>('/integrations/erp/events'),
  resolvePrice: (product: string, litres: number, siteCode?: string) =>
    request<ResolvedPrice>(`/pricing/resolve?product=${encodeURIComponent(product)}&litres=${litres}${siteCode ? `&siteCode=${encodeURIComponent(siteCode)}` : ''}`),

  // telemetry
  devices: () => request<DeviceStatus[]>('/telemetry/devices'),
  tankReadings: () => request<TankReading[]>('/telemetry/tanks'),
  pumpEvents: () => request<PumpEvent[]>('/telemetry/pumps'),

  // PTS-2 controllers (live tanks)
  pts2Connections: () => request<Pts2Connection[]>('/pts2/connections'),
  savePts2Connection: (siteCode: string, payload: Pts2ConnectionInput) =>
    request<Pts2Connection>(`/pts2/connections/${encodeURIComponent(siteCode)}`, { method: 'PUT', body: JSON.stringify(payload) }),
  deletePts2Connection: (siteCode: string) =>
    request<void>(`/pts2/connections/${encodeURIComponent(siteCode)}`, { method: 'DELETE' }),
  testPts2Connection: (siteCode: string) => post<Pts2SiteState>(`/pts2/connections/${encodeURIComponent(siteCode)}/test`),
  pts2Tanks: () => request<Pts2SiteState[]>('/pts2/tanks'),
  pts2Prices: (siteCode: string) => request<Pts2Prices>(`/pts2/prices/${encodeURIComponent(siteCode)}`),
  changePts2Prices: (siteCode: string, payload: Pts2PriceInput) =>
    request<Pts2Prices>(`/pts2/prices/${encodeURIComponent(siteCode)}`, { method: 'POST', body: JSON.stringify(payload) }),
  cancelPts2PriceSchedule: (siteCode: string, scheduleId: number) =>
    request<Pts2Prices>(`/pts2/prices/${encodeURIComponent(siteCode)}/schedules/${scheduleId}`, { method: 'DELETE' }),
  pts2PriceHistory: (siteCode: string) => request<Pts2PriceChange[]>(`/pts2/prices/${encodeURIComponent(siteCode)}/history`),

  // reconciliation
  reconRuns: () => request<ReconRun[]>('/reconciliation/runs'),
  reconExceptions: () => request<VarianceException[]>('/reconciliation/exceptions'),
  closeDay: (siteCode: string, date?: string) =>
    post<ReconRun>(`/reconciliation/close?siteCode=${encodeURIComponent(siteCode)}${date ? `&date=${date}` : ''}`),
  resolveException: (id: string, note: string) => post<VarianceException>(`/reconciliation/exceptions/${id}/resolve`, { note }),

  // deliveries
  deliveries: () => request<Delivery[]>('/deliveries'),
  delivery: (id: string) => request<DeliveryDetail>(`/deliveries/${id}`),
  planDelivery: (payload: object) => post<Delivery>('/deliveries', payload),
  loadDelivery: (id: string, loadedLitres: number, sealNumbers: string) =>
    post<Delivery>(`/deliveries/${id}/load`, { loadedLitres, sealNumbers }),
  departDelivery: (id: string) => post<Delivery>(`/deliveries/${id}/depart`),
  gpsDelivery: (id: string, lat: number, lng: number, speedKph?: number) =>
    post<Delivery>(`/deliveries/${id}/gps`, { lat, lng, speedKph }),
  offloadDelivery: (id: string, deliveredLitres: number) => post<Delivery>(`/deliveries/${id}/offload`, { deliveredLitres }),
  podDelivery: (id: string, signedBy: string, notes: string) =>
    post<ProofOfDelivery>(`/deliveries/${id}/pod`, { signedBy, notes }),

  // CCTV
  cctvEvents: () => request<CctvEvent[]>('/cctv/events'),
  postCctvEvent: (payload: object) => post<CctvEvent>('/cctv/events', payload),

  // insights
  dashboard: () => request<DashboardKpis>('/insights/dashboard'),
  consumption: () => request<ConsumptionRow[]>('/insights/consumption'),
  anomalies: () => request<AnomalyRow[]>('/insights/anomalies'),
  stockout: () => request<StockoutRow[]>('/insights/stockout'),
};
