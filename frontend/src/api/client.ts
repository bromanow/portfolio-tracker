import axios from 'axios'

// In production (Render static site) VITE_API_BASE_URL points to the backend service.
// In local dev the Vite proxy handles /api → localhost:8000, so we keep '/api' as the fallback.
const API_BASE = import.meta.env.VITE_API_BASE_URL
  ? `${import.meta.env.VITE_API_BASE_URL}/api`
  : '/api'

const api = axios.create({
  baseURL: API_BASE,
  headers: { 'Content-Type': 'application/json' },
})

// ── Auth interceptors ────────────────────────────────────────────────────────
// Attach JWT to every request
api.interceptors.request.use(config => {
  const token = localStorage.getItem('pt_auth_token')
  if (token) config.headers.Authorization = `Bearer ${token}`
  return config
})

// On 401 → clear token and redirect to login
api.interceptors.response.use(
  r => r,
  error => {
    if (error.response?.status === 401) {
      localStorage.removeItem('pt_auth_token')
      window.location.href = '/login'
    }
    return Promise.reject(error)
  }
)

// ── Auth API ──────────────────────────────────────────────────────────────────
export const changePassword = (data: { current_password: string; new_password: string }) =>
  api.post('/auth/change-password', data).then(r => r.data)

export interface AppUser {
  id: number
  email: string
  name: string
  role: string
  is_active: boolean
  created_at: string | null
  last_login: string | null
  client_ids: number[]
}

export const getUsers = () => api.get<AppUser[]>('/auth/users').then(r => r.data)
export const createUser = (data: {
  email: string; name: string; password: string; role: string; client_ids: number[]
}) => api.post<AppUser>('/auth/users', data).then(r => r.data)
export const updateUser = (id: number, data: Partial<{
  email: string; name: string; role: string; is_active: boolean; client_ids: number[]
}>) => api.put<AppUser>(`/auth/users/${id}`, data).then(r => r.data)
export const resetUserPassword = (id: number, new_password: string) =>
  api.post(`/auth/users/${id}/reset-password`, { new_password }).then(r => r.data)

// ─── Accounts ──────────────────────────────────────────────────────────────
// ─── Clients ─────────────────────────────────────────────────────────────────
export interface Client {
  id: number
  name: string
  slug: string
  active: boolean
}

export const getClients = () => api.get<Client[]>('/clients').then(r => r.data)

// ─── Accounts ─────────────────────────────────────────────────────────────────
export interface Account {
  id: number
  brokerage_id: number
  brokerage_name: string
  brokerage_code: string
  advisor: string | null
  name: string
  account_number: string | null
  account_type: string
  base_currency: string
  owner: string
  client_id: number | null
  active: boolean
  ibkr_alias: string | null
}

export const getAccounts = () => api.get<Account[]>('/accounts').then(r => r.data)
export const createAccount = (data: Partial<Account>) => api.post<Account>('/accounts', data).then(r => r.data)
export const updateAccount = (id: number, data: Partial<Account>) => api.put<Account>(`/accounts/${id}`, data).then(r => r.data)
export const deleteAccount = (id: number) => api.delete(`/accounts/${id}`).then(r => r.data)
export const forceDeleteAccount = (id: number) => api.delete(`/accounts/${id}/force`).then(r => r.data)

// ─── Securities ─────────────────────────────────────────────────────────────
export interface Security {
  id: number
  ticker: string
  exchange: string | null
  name: string | null
  asset_class: string
  sector_gics: string | null
  industry_gics: string | null
  country: string | null
  currency: string | null
  is_option: boolean
  transaction_count: number
  fetch_ticker_override: string | null
  description: string | null
}

export const getSecurities = (params?: { search?: string; asset_class?: string }) =>
  api.get<Security[]>('/securities', { params }).then(r => r.data)
export const createSecurity = (data: Partial<Security>) => api.post<Security>('/securities', data).then(r => r.data)
export const updateSecurity = (id: number, data: Partial<Security>) => api.put<Security>(`/securities/${id}`, data).then(r => r.data)
export interface YahooSearchResult {
  symbol: string
  name: string
  exchange: string
  currency: string
  quote_type: string
}

export const searchYahooSecurities = (q: string) =>
  api.get<YahooSearchResult[]>('/securities/yahoo-search', { params: { q } }).then(r => r.data)

export const fetchSecurityYahooInfo = (id: number, yahooSymbol?: string) =>
  api.post<{ success: boolean; message?: string; fetch_ticker?: string; updated: Record<string, string>; security: Security }>(
    `/securities/${id}/fetch-yahoo-info`,
    yahooSymbol ? { yahoo_symbol: yahooSymbol } : undefined,
  ).then(r => r.data)
export const deleteSecurity = (id: number) => api.delete(`/admin/securities/${id}`).then(r => r.data)
export const deleteUnusedSecurities = () => api.delete('/admin/bulk/securities').then(r => r.data)

// ─── Transactions ────────────────────────────────────────────────────────────
export interface Transaction {
  id: number
  account_id: number
  account_name: string
  security_id: number | null
  security_ticker: string | null
  transaction_date: string
  settlement_date: string | null
  transaction_type: string
  quantity: string | null
  price: string | null
  commission: string | null
  transaction_currency: string | null
  transaction_amount: string | null
  account_currency_amount: string | null
  cad_amount: string | null
  fx_rate_to_account: string | null
  fx_rate_to_cad: string | null
  notes: string | null
  tags: string[] | null
  raw_description: string | null
  is_manual_override: boolean
  is_verified: boolean
  created_at: string
  updated_at: string
}

export interface TransactionListResponse {
  total: number
  page: number
  page_size: number
  items: Transaction[]
}

export const getTransactions = (params?: {
  account_id?: number
  account_ids?: string
  brokerage_name?: string
  security_id?: number
  transaction_type?: string  // single or comma-separated for multi-select
  date_from?: string
  date_to?: string
  ticker?: string
  page?: number
  page_size?: number
  sort_by?: string
  sort_dir?: 'asc' | 'desc'
}) => api.get<TransactionListResponse>('/transactions', { params }).then(r => r.data)

export const createTransaction = (data: Partial<Transaction>) =>
  api.post<Transaction>('/transactions', data).then(r => r.data)

export interface TransferPairCreate {
  from_account_id: number
  to_account_id: number
  transaction_date: string
  settlement_date?: string
  transfer_type?: string   // 'JOURNAL' (default) or 'TRANSFER'
  security_id?: number
  quantity?: string
  price?: string
  cad_amount?: string
  notes?: string
  raw_description?: string
}
export const createTransferPair = (data: TransferPairCreate) =>
  api.post<{ source: Transaction; dest: Transaction }>('/transactions/transfer-pair', data).then(r => r.data)
export const updateTransaction = (id: number, data: Partial<Transaction>) =>
  api.put<Transaction>(`/transactions/${id}`, data).then(r => r.data)
export const deleteTransaction = (id: number) =>
  api.delete(`/transactions/${id}`).then(r => r.data)
export const bulkUpdateTransactions = (ids: number[], transaction_type: string) =>
  api.post<{ updated: number }>('/transactions/bulk-update', { ids, transaction_type }).then(r => r.data)

// ─── Market Prices ────────────────────────────────────────────────────────────
export interface MarketPrice {
  security_id: number
  ticker: string
  price: string | null
  currency: string
  price_cad: string | null
  prev_close: string | null
  day_high: string | null
  day_low: string | null
  day_change: string | null
  day_change_pct: string | null
  price_date: string | null
  fetched_at: string | null
  fetch_ticker: string | null
  source: string
}

export interface PriceFields {
  current_price?: string | null
  current_price_cad?: string | null
  price_currency?: string | null
  market_value_cad?: string | null
  unrealized_pnl_cad?: string | null
  unrealized_pnl_pct?: string | null
  day_change_pct?: string | null
  day_change?: string | null
  day_change_cad?: string | null
  day_gain_cad?: string | null
  price_date?: string | null
  fetched_at?: string | null
  fetch_ticker?: string | null
}

export interface MarketIndicator {
  symbol: string
  label: string
  currency: string
  price: number | null
  day_change: number | null
  day_change_pct: number | null
}

export interface SummaryMetrics {
  current_value: number
  ytd_start_value: number
  ytd_gain_cad: number
  ytd_gain_pct: number | null
  one_year_start_value: number
  one_year_gain_cad: number
  one_year_gain_pct: number | null
}

export const getPrices = () => api.get<MarketPrice[]>('/prices').then(r => r.data)

export interface PriceJob {
  id: string
  name: string
  status: 'running' | 'done' | 'error'
  started_at: string
  finished_at: string | null
  result: Record<string, unknown> | null
  error: string | null
  progress: string | null
  already_running?: boolean
  job_id?: string  // alias returned by spawn endpoints
}
export const getPriceJob = (jobId: string) => api.get<PriceJob>(`/prices/jobs/${jobId}`).then(r => r.data)
export const listPriceJobs = () => api.get<PriceJob[]>('/prices/jobs').then(r => r.data)

export const refreshAllPrices = () => api.post<PriceJob>('/prices/refresh').then(r => r.data)
export const refreshOnePrice = (securityId: number) => api.post(`/prices/refresh/${securityId}`).then(r => r.data)
export const deletePrice = (securityId: number) => api.delete(`/prices/${securityId}`).then(r => r.data)

export interface PriceStatus {
  live_last_updated: string | null   // ISO datetime (UTC)
  history_last_date: string | null   // ISO date
}
export const getPriceStatus = () => api.get<PriceStatus>('/prices/status').then(r => r.data)
export const refreshPricesRecent = () => api.post<PriceJob>('/prices/refresh-recent').then(r => r.data)

// ─── Portfolio ───────────────────────────────────────────────────────────────
export interface Position extends PriceFields {
  account_id: number
  account_name: string
  account_type: string
  security_id: number
  ticker: string
  security_name: string | null
  asset_class: string
  exchange: string | null
  quantity: string
  acb_per_share_cad: string
  total_acb_cad: string
  currency: string
}

export interface PortfolioSummary {
  total_cost_cad: string
  as_of: string
  position_count: number
  accounts: Array<{
    account_id: number
    account_name: string
    account_type: string
    total_cost_cad: string
    position_count: number
  }>
}

export interface ConsolidatedPosition extends PriceFields {
  security_id: number | null
  ticker: string
  security_name: string | null
  asset_class: string
  exchange: string | null
  currency: string
  total_quantity: string
  total_acb_cad: string
  acb_per_share_cad: string
  account_count: number
  accounts: Array<{
    account_id: number
    account_name: string
    account_type: string
    quantity: string
    total_acb_cad: string
  }>
}

export interface YahooDetail {
  available: boolean
  reason?: string
  symbol?: string
  market_cap?: number | null
  enterprise_value?: number | null
  shares_outstanding?: number | null
  float_shares?: number | null
  beta?: number | null
  fifty_two_week_high?: number | null
  fifty_two_week_low?: number | null
  fifty_day_avg?: number | null
  two_hundred_day_avg?: number | null
  volume?: number | null
  avg_volume?: number | null
  pe_ratio?: number | null
  forward_pe?: number | null
  peg_ratio?: number | null
  price_to_book?: number | null
  price_to_sales?: number | null
  ev_to_ebitda?: number | null
  eps?: number | null
  forward_eps?: number | null
  dividend_yield?: number | null
  dividend_rate?: number | null
  payout_ratio?: number | null
  total_revenue?: number | null
  ebitda?: number | null
  net_income?: number | null
  free_cashflow?: number | null
  operating_cashflow?: number | null
  total_debt?: number | null
  total_cash?: number | null
  profit_margins?: number | null
  gross_margins?: number | null
  operating_margins?: number | null
  revenue_growth?: number | null
  earnings_growth?: number | null
  return_on_equity?: number | null
  return_on_assets?: number | null
  debt_to_equity?: number | null
  current_ratio?: number | null
  sector?: string | null
  industry?: string | null
  country?: string | null
  website?: string | null
  employees?: number | null
  description?: string | null
  currency?: string | null
}

export interface PriceHistoryPoint {
  date: string
  close: number | null
  close_cad: number | null
  currency: string | null
}

export interface StoredFundamentals {
  available: boolean
  reason?: string
  // Valuation
  market_cap?: number | null
  enterprise_value?: number | null
  pe_ratio?: number | null
  forward_pe?: number | null
  peg_ratio?: number | null
  price_to_book?: number | null
  price_to_sales?: number | null
  ev_to_ebitda?: number | null
  // Per-share
  eps?: number | null
  forward_eps?: number | null
  // Income
  dividend_yield?: number | null
  dividend_rate?: number | null
  payout_ratio?: number | null
  // Financials
  total_revenue?: number | null
  ebitda?: number | null
  net_income?: number | null
  free_cashflow?: number | null
  operating_cashflow?: number | null
  total_debt?: number | null
  total_cash?: number | null
  // Margins
  profit_margin?: number | null
  gross_margin?: number | null
  operating_margin?: number | null
  // Growth
  revenue_growth?: number | null
  earnings_growth?: number | null
  // Quality
  return_on_equity?: number | null
  return_on_assets?: number | null
  debt_to_equity?: number | null
  current_ratio?: number | null
  // Risk
  beta?: number | null
  shares_outstanding?: number | null
  float_shares?: number | null
  short_ratio?: number | null
  // Market
  fifty_two_week_high?: number | null
  fifty_two_week_low?: number | null
  fifty_day_avg?: number | null
  two_hundred_day_avg?: number | null
  avg_volume?: number | null
  // Analyst
  analyst_target_price?: number | null
  analyst_recommendation?: string | null
  analyst_count?: number | null
  // Company
  website?: string | null
  employees?: number | null
  fetched_at?: string | null
  source?: string | null
}

export interface SecuritySignals {
  available: boolean
  reason?: string
  as_of_date?: string | null
  // Trend
  ma_50d?: number | null
  ma_200d?: number | null
  price_vs_50d?: number | null
  price_vs_200d?: number | null
  golden_cross?: boolean | null
  // Momentum
  return_1m?: number | null
  return_3m?: number | null
  return_6m?: number | null
  return_12m?: number | null
  momentum_12_1?: number | null
  // Oscillators
  rsi_14?: number | null
  // Volatility
  volatility_20d?: number | null
  volatility_60d?: number | null
  computed_at?: string | null
}

export const getPositions = (params?: { account_id?: number; as_of?: string }) =>
  api.get<Position[]>('/portfolio/positions', { params }).then(r => r.data)
export const getConsolidatedPositions = (params?: { as_of?: string; account_ids?: string }) =>
  api.get<ConsolidatedPosition[]>('/portfolio/positions/consolidated', { params }).then(r => r.data)

export const getMarketIndicators = () =>
  api.get<MarketIndicator[]>('/prices/market-indicators').then(r => r.data)

export const getSummaryMetrics = (params?: { account_ids?: string; as_of?: string }) =>
  api.get<SummaryMetrics>('/portfolio/summary-metrics', { params }).then(r => r.data)
export const getSecurityYahooDetail = (id: number) =>
  api.get<YahooDetail>(`/securities/${id}/yahoo-detail`).then(r => r.data)
export const getSecurityPriceHistory = (id: number, period = '1y') =>
  api.get<PriceHistoryPoint[]>(`/securities/${id}/price-history`, { params: { period } }).then(r => r.data)
export const getSecurityFundamentals = (id: number) =>
  api.get<StoredFundamentals>(`/securities/${id}/fundamentals`).then(r => r.data)
export const refreshSecurityFundamentals = (id: number) =>
  api.post(`/securities/${id}/refresh-fundamentals`).then(r => r.data)
export const getSecuritySignals = (id: number) =>
  api.get<SecuritySignals>(`/securities/${id}/signals`).then(r => r.data)
export const computeSecuritySignals = (id: number) =>
  api.post(`/securities/${id}/compute-signals`).then(r => r.data)
export const getPortfolioSummary = (params?: { as_of?: string }) =>
  api.get<PortfolioSummary>('/portfolio/summary', { params }).then(r => r.data)
export const getRealizedPnl = (params?: { account_id?: number; account_ids?: string; year?: number; brokerage_name?: string }) =>
  api.get('/portfolio/pnl', { params }).then(r => r.data)

export interface CashBalance {
  account_id: number
  account_name: string
  account_type: string
  currency: string
  balance: string
  balance_cad: string | null
}
export const getCashBalances = (params?: { account_id?: number; as_of?: string }) =>
  api.get<CashBalance[]>('/portfolio/cash-balances', { params }).then(r => r.data)

export interface CashStatementRow {
  id: number
  account_id: number | null
  account_name: string | null
  currency: string | null
  date: string
  settlement_date: string | null
  transaction_type: string
  ticker: string | null
  description: string | null
  impact: string
  balance: string | null
}
export interface CashStatement {
  account_id: number | null
  account_name: string
  base_currency: string
  currency: string
  closing_balance: string
  rows: CashStatementRow[]
}
export const getCashStatement = (params: {
  account_id?: number
  account_ids?: string
  from_date?: string
  to_date?: string
}) => api.get<CashStatement>('/portfolio/cash-statement', { params }).then(r => r.data)

export interface IncomeItem {
  date: string
  year: number
  account_id: number
  account_name: string
  brokerage_name: string
  ticker: string
  transaction_type: string
  amount_cad: string
  currency: string
  amount_native: string
}
export const getInvestmentIncome = (params?: { account_id?: number; account_ids?: string; year?: number; brokerage_name?: string }) =>
  api.get<IncomeItem[]>('/portfolio/income', { params }).then(r => r.data)
export const getAcbReport = (params?: { account_id?: number; as_of?: string }) =>
  api.get('/portfolio/acb', { params }).then(r => r.data)
export const getAssetAllocation = (params?: { as_of?: string }) =>
  api.get<Array<{ asset_class: string; total_cad: number; pct: number }>>('/portfolio/allocation', { params }).then(r => r.data)

export interface AnalyticsSlice { label: string; total_cad: number; pct: number }
export interface AnalyticsHolding { ticker: string; name: string | null; asset_class: string; total_cad: number; pct: number }
export interface PortfolioAnalytics {
  sector: AnalyticsSlice[]
  country: AnalyticsSlice[]
  currency: AnalyticsSlice[]
  asset_class: AnalyticsSlice[]
  top_holdings: AnalyticsHolding[]
}
export const getPortfolioAnalytics = (params?: { as_of?: string; account_ids?: string }) =>
  api.get<PortfolioAnalytics>('/portfolio/analytics', { params }).then(r => r.data)

export interface PortfolioRisk {
  available: boolean
  reason?: string
  total_value_cad?: number
  portfolio_beta?: number | null
  beta_coverage_pct?: number
  dividend_yield_pct?: number | null
  dividend_coverage_pct?: number
  volatility_30d_pct?: number | null
  volatility_90d_pct?: number | null
  hhi?: number
  largest_position_pct?: number
  largest_position_ticker?: string | null
  top5_concentration_pct?: number
  top_sector?: string | null
  top_sector_pct?: number
  currency_exposure?: Array<{ currency: string; pct: number; total_cad: number }>
  position_count?: number
}
export const getPortfolioRisk = (params?: { account_ids?: string }) =>
  api.get<PortfolioRisk>('/portfolio/risk', { params }).then(r => r.data)

export const refreshFundamentals = () =>
  api.post<PriceJob>('/prices/refresh-fundamentals').then(r => r.data)

export const getRecentTransactions = (limit = 20) =>
  api.get<Transaction[]>('/portfolio/recent-transactions', { params: { limit } }).then(r => r.data)

// ─── Imports ─────────────────────────────────────────────────────────────────
export interface ImportBatch {
  id: number
  brokerage_id: number
  account_id: number | null
  filename: string
  import_date: string
  row_count: number
  imported_count: number
  error_count: number
  status: string
}

export const getImports = () => api.get<ImportBatch[]>('/imports').then(r => r.data)
export const uploadFile = (file: File, accountId?: number) => {
  const formData = new FormData()
  formData.append('file', file)
  if (accountId) formData.append('account_id', String(accountId))
  return api.post('/imports/upload', formData, {
    headers: { 'Content-Type': 'multipart/form-data' },
  }).then(r => r.data)
}
export const getImportPreview = (batchId: number) =>
  api.get(`/imports/${batchId}/preview`).then(r => r.data)
export const commitImport = (batchId: number) =>
  api.post(`/imports/${batchId}/commit`).then(r => r.data)
export const rejectImport = (batchId: number) =>
  api.post(`/imports/${batchId}/reject`).then(r => r.data)
export const remapImportTypes = (batchId: number) =>
  api.post(`/imports/${batchId}/remap-types`).then(r => r.data)
export const deleteImport = (batchId: number) =>
  api.delete(`/imports/${batchId}`).then(r => r.data)
export const updateRawRow = (batchId: number, rowId: number, updates: Record<string, unknown>) =>
  api.put(`/imports/${batchId}/row/${rowId}`, updates).then(r => r.data)
export const checkImportDuplicates = (batchId: number) =>
  api.post<{ checked: number; duplicates_found: number }>(`/imports/${batchId}/check-duplicates`).then(r => r.data)

// ─── Admin ────────────────────────────────────────────────────────────────────
export interface Brokerage {
  id: number
  name: string
  code: string
  active: boolean
  advisor: string | null
}
export interface TypeMapping {
  id: number
  brokerage_id: number
  brokerage_name: string
  raw_type: string
  canonical_type: string
}
export interface FXRate {
  id: number
  rate_date: string
  from_currency: string
  to_currency: string
  rate: string
  source: string
}

export interface OpeningBalance {
  id: number
  account_id: number
  account_name: string | null
  balance_date: string | null
  ticker: string | null
  security_id: number | null
  quantity: string | null
  acb_per_share_cad: string | null
  total_acb_cad: string | null
  currency: string | null
  notes: string | null
}

export const getBrokerages = () => api.get<Brokerage[]>('/admin/brokerages').then(r => r.data)
export const createBrokerage = (data: Partial<Brokerage>) => api.post('/admin/brokerages', data).then(r => r.data)
export const updateBrokerage = (id: number, data: Partial<Brokerage>) => api.put(`/admin/brokerages/${id}`, data).then(r => r.data)
export const deleteBrokerage = (id: number) => api.delete(`/admin/brokerages/${id}`).then(r => r.data)
export const getTypeMappings = () => api.get<TypeMapping[]>('/admin/type-mappings').then(r => r.data)
export const createTypeMapping = (data: Partial<TypeMapping>) =>
  api.post('/admin/type-mappings', data).then(r => r.data)
export const updateTypeMapping = (id: number, data: Partial<TypeMapping>) =>
  api.put(`/admin/type-mappings/${id}`, data).then(r => r.data)
export const deleteTypeMapping = (id: number) =>
  api.delete(`/admin/type-mappings/${id}`).then(r => r.data)
export const getFxRates = (limit = 100) =>
  api.get<FXRate[]>('/admin/fx-rates', { params: { limit } }).then(r => r.data)
export const getFxRateLookup = (date: string, fromCurrency: string, toCurrency = 'CAD') =>
  api.get<{ date: string; from_currency: string; to_currency: string; rate: string }>(
    '/admin/fx-rates/lookup',
    { params: { date, from_currency: fromCurrency, to_currency: toCurrency } }
  ).then(r => r.data)
export const refreshFxRates = () => api.post('/admin/fx-rates/refresh').then(r => r.data)
export const getCurrencies = () => api.get('/admin/currencies').then(r => r.data)
// Opening Balances
export const getOpeningBalances = () => api.get<OpeningBalance[]>('/admin/opening-balances').then(r => r.data)
export const createOpeningBalance = (data: {
  account_id: number; balance_date: string; ticker: string;
  quantity: number; acb_per_share_cad: number; currency: string; notes?: string
}) => api.post('/admin/opening-balances', data).then(r => r.data)
export const updateOpeningBalance = (id: number, data: {
  account_id: number; balance_date: string; ticker: string;
  quantity: number; acb_per_share_cad: number; currency: string; notes?: string
}) => api.put(`/admin/opening-balances/${id}`, data).then(r => r.data)
export const deleteOpeningBalance = (id: number) => api.delete(`/admin/opening-balances/${id}`).then(r => r.data)

export interface CashOpening {
  id: number
  account_id: number
  account_name: string | null
  balance_date: string
  amount: string
  currency: string
  notes: string | null
}
export const getCashOpenings = () => api.get<CashOpening[]>('/admin/cash-openings').then(r => r.data)
export const createCashOpening = (data: { account_id: number; balance_date: string; amount: number; currency: string; notes?: string }) =>
  api.post('/admin/cash-openings', data).then(r => r.data)
export const deleteCashOpening = (id: number) => api.delete(`/admin/cash-openings/${id}`).then(r => r.data)
// Bulk deletes
export const deleteAllTransactions = (accountId?: number) =>
  api.delete('/admin/bulk/transactions', { params: accountId ? { account_id: accountId } : {} }).then(r => r.data)
export const deleteAllImports = () => api.delete('/admin/bulk/imports').then(r => r.data)

// ─── Currency sub-account migration ──────────────────────────────────────────
export interface CurrencySummaryRow {
  currency: string
  count: number
  earliest: string | null
  latest: string | null
}
export interface CurrencySummary {
  account_id: number
  account_name: string
  base_currency: string
  by_currency: CurrencySummaryRow[]
}
export const getAccountCurrencySummary = (accountId: number) =>
  api.get<CurrencySummary>(`/admin/accounts/${accountId}/currency-summary`).then(r => r.data)

export const splitCurrencyTransactions = (
  accountId: number,
  toAccountId: number,
  currency: string,
  fromDate?: string,
  toDate?: string,
) =>
  api.post(`/admin/accounts/${accountId}/split-currency`, {
    to_account_id: toAccountId,
    currency,
    ...(fromDate ? { from_date: fromDate } : {}),
    ...(toDate   ? { to_date: toDate }     : {}),
  }).then(r => r.data)

// ─── System ──────────────────────────────────────────────────────────────────
export const getSystemHealth = () => api.get<{ status: string; timestamp: string }>('/system/health').then(r => r.data)
export const restartBackend = () => api.post('/system/restart').then(r => r.data)

export interface DbIndexStatus { name: string; present: boolean; sql: string }
export interface DbStats {
  row_counts: Record<string, number | null>
  index_status: DbIndexStatus[]
  db_size_mb: number
  page_count: number
  page_size: number
  freelist_count: number
}
export interface DbOptimizeResult { indexes_created: string[]; analyzed: boolean; message: string }

export const getDbStats   = () => api.get<DbStats>('/system/db-stats').then(r => r.data)
export const optimizeDb   = () => api.post<DbOptimizeResult>('/system/db-optimize').then(r => r.data)

// ─── Portfolio History ───────────────────────────────────────────────────────
export interface PortfolioHistoryPoint {
  date: string
  book_value_cad: string
  market_value_cad: string | null
  cash_cad: string
  total_value_cad: string | null
}

// ─── Portfolio Continuity ────────────────────────────────────────────────────
export interface ContinuityReport {
  period_start: string
  period_end: string
  opening_balance: string
  contributions: string
  withdrawals: string
  transfers: string
  dividends_interest: string
  realized_gains: string
  fees: string
  unrealized_gains_change: string
  closing_balance: string
  has_market_prices: boolean
}

export const getPortfolioContinuity = (params: {
  from_date: string
  to_date: string
  account_ids?: string
}) => api.get<ContinuityReport>('/portfolio/continuity', { params }).then(r => r.data)

export const getPortfolioHistory = (params: {
  from_date?: string
  to_date?: string
  interval?: 'daily' | 'weekly' | 'monthly'
  account_id?: number
  account_ids?: string   // comma-separated list of account IDs
}) => api.get<PortfolioHistoryPoint[]>('/portfolio/history', { params }).then(r => r.data)

export const fetchHistoricalPrices = (body: {
  security_ids?: number[]
  from_date?: string
  to_date?: string
} = {}) => api.post('/prices/fetch-history', body).then(r => r.data)

// ─── Options ────────────────────────────────────────────────────────────────
export interface OptionPosition {
  account_id: number
  account_name: string
  account_type: string
  security_id: number
  ticker: string
  asset_class: string
  quantity: string
  acb_per_share_cad: string
  total_acb_cad: string
  currency: string           // display/account currency (may be account base ccy for old records)
  price_currency: string | null  // actual trading currency from MarketPrice (authoritative)
  current_price: string | null
  current_price_cad: string | null
  price_source: string | null
  market_value_cad: string | null
  unrealized_pnl_cad: string | null
  unrealized_pnl_pct: string | null
  underlying_ticker: string | null
  option_type: string | null
  strike: number | null
  expiry_date: string | null
  days_to_expiry: number | null
  is_canadian: boolean
  // Underlying price & moneyness
  underlying_price: string | null
  underlying_price_cad: string | null
  underlying_price_currency: string | null
  itm: boolean | null
  moneyness: number | null
  // Same-account underlying equity position (for covered call detection)
  underlying_position_qty: string | null
  underlying_position_acb_cad: string | null
}

export interface OptionIncomeRow {
  date: string
  ticker: string
  underlying_ticker: string
  option_type: string
  strike: number
  expiry_date: string
  account_id: number
  quantity: string
  proceeds_cad: string
  acb_cad: string
  gain_cad: string
  close_type: string | null
  currency: string | null
  direction: 'LONG' | 'SHORT'
}

export interface OptionsReport {
  open_positions: OptionPosition[]
  income: OptionIncomeRow[]
  summary: {
    open_contracts: number
    total_exposure_cad: string
    unrealized_pnl_cad: string
    total_income_cad: string
  }
}

export const getOptionsReport = (params: { account_id?: number; account_ids?: string } = {}) =>
  api.get<OptionsReport>('/portfolio/options', { params }).then(r => r.data)

export const expireOption = (accountId: number, securityId: number, expiryDate?: string) =>
  api.post<Transaction>('/transactions/expire-option', {
    account_id: accountId,
    security_id: securityId,
    expiry_date: expiryDate ?? null,
  }).then(r => r.data)

// ─── Prices ─────────────────────────────────────────────────────────────────
export interface PriceReportRow {
  security_id: number
  ticker: string
  name: string | null
  asset_class: string
  currency: string | null
  exchange: string | null
  is_option: boolean
  price: string | null
  price_cad: string | null
  price_currency: string | null
  day_change_pct: string | null
  price_date: string | null
  fetched_at: string | null
  fetch_ticker: string | null
  source: string | null
  has_price: boolean
}

export interface PriceRecord {
  price_date: string
  close_price: string | null
  currency: string
  close_price_cad: string | null
  source: string
}

export const getPriceReport = (params?: {
  asset_class?: string
  currency?: string
  source?: string
  search?: string
}) => api.get<PriceReportRow[]>('/prices/report', { params }).then(r => r.data)

export const getPriceHistory = (securityId: number) =>
  api.get<PriceRecord[]>(`/prices/${securityId}/history`).then(r => r.data)

export const addHistoricalPrice = (securityId: number, data: { price_date: string; price: number; currency: string }) =>
  api.post(`/prices/${securityId}/history`, data).then(r => r.data)

export const updateHistoricalPrice = (securityId: number, priceDate: string, data: { price_date: string; price: number; currency: string }) =>
  api.put(`/prices/${securityId}/history/${priceDate}`, data).then(r => r.data)

export const deleteHistoricalPrice = (securityId: number, priceDate: string) =>
  api.delete(`/prices/${securityId}/history/${priceDate}`).then(r => r.data)

export const deleteAllHistory = (securityId: number) =>
  api.delete(`/prices/${securityId}/history`).then(r => r.data)

export const importHistoryCSV = (securityId: number, formData: FormData) =>
  api.post(`/prices/${securityId}/history/import`, formData, {
    headers: { 'Content-Type': 'multipart/form-data' },
  }).then(r => r.data)

export const copyHistoryFrom = (targetSecurityId: number, sourceSecurityId: number) =>
  api.post(`/prices/${targetSecurityId}/history/copy-from/${sourceSecurityId}`).then(r => r.data)

export const fetchPriceHistory = (body: { security_ids?: number[]; from_date?: string; to_date?: string; incremental?: boolean } = {}) =>
  api.post<PriceJob>('/prices/fetch-history', body).then(r => r.data)

// ─── Performance returns ────────────────────────────────────────────────────
export interface MonthlyReturnRow {
  account_ids: number[]
  account_name: string
  account_type: string
  brokerage: string
  monthly: Record<string, number | null>   // "2025-01" → pct | null
  annual:  Record<string, number | null>   // "2025"    → pct | null
}
export interface MonthlyReturnsResponse {
  months: string[]
  years:  string[]
  rows:   MonthlyReturnRow[]
}
export const getMonthlyReturns = (params?: {
  year_from?: number
  year_to?:   number
  account_ids?: string
}) => api.get<MonthlyReturnsResponse>('/portfolio/performance/monthly-returns', { params }).then(r => r.data)

export interface ReturnDetailRow {
  account_ids:         number[]
  account_name:        string
  account_type:        string
  brokerage:           string
  from_date:           string
  to_date:             string
  start_market_value:  number
  end_market_value:    number
  net_flows:           number        // net capital change during period (+ = contributions, − = withdrawals)
  period_income:       number        // cumulative income received
  total_gain:          number        // Modified Dietz numerator: (V1−V0) − net_flows + income
  return_pct:          number        // Modified Dietz return %
  md_denominator:      number        // V0 + weighted flows; sum across rows for correct aggregate return
}
export const getReturnsDetail = (params?: {
  from_date?:   string
  to_date?:     string
  account_ids?: string
}) => api.get<ReturnDetailRow[]>('/portfolio/performance/returns-detail', { params }).then(r => r.data)

export const setManualPrice = (securityId: number, price: number, currency: string) =>
  api.put(`/prices/${securityId}/manual`, { price, currency }).then(r => r.data)

export const clearManualPrice = (securityId: number) =>
  api.delete(`/prices/${securityId}`).then(r => r.data)

export const recordOptionHistory = () =>
  api.post('/prices/record-option-history').then(r => r.data)

// ─── IBKR ────────────────────────────────────────────────────────────────────
export interface IBKRStatus {
  available: boolean
  host: string
  port: number
  client_id: number
  last_connected_at: string | null
  last_refresh_at: string | null
  last_refresh_result: {
    ok: number; failed: number; skipped: number; errors: string[]
  } | null
  gateway_running: boolean
  gateway_app_path: string | null
}

export interface IBKRConnectRequest {
  host: string
  port: number
  client_id: number
}

export const getIBKRStatus = () =>
  api.get<IBKRStatus>('/ibkr/status').then(r => r.data)

export const connectIBKR = (req: IBKRConnectRequest) =>
  api.post<{ connected: boolean; tws_version: string; message: string }>('/ibkr/connect', req).then(r => r.data)

export const refreshPricesIBKR = () =>
  api.post<{ job_id: string; status: string; already_running: boolean }>('/ibkr/refresh-prices').then(r => r.data)

// ─── IBKR Flex Query ──────────────────────────────────────────────────────────
export interface IBKRFlexConfig {
  id: number
  user_id: number
  user_name?: string
  user_email?: string
  query_id: string
  token_hint: string
  enabled: boolean
  last_sync_at: string | null
  last_sync_status: 'ok' | 'error' | 'running' | null
  last_sync_message: string | null
  last_sync_imported: number | null
}

export interface FlexConfigIn {
  query_id: string
  token: string
  enabled?: boolean
}

export const getMyFlexConfig = () =>
  api.get<IBKRFlexConfig | null>('/ibkr/flex/my-config').then(r => r.data)

export const saveMyFlexConfig = (data: FlexConfigIn) =>
  api.post<IBKRFlexConfig>('/ibkr/flex/my-config', data).then(r => r.data)

export const deleteMyFlexConfig = () =>
  api.delete('/ibkr/flex/my-config')

export const syncMyFlexAccounts = () =>
  api.post<{ job_id: string; status: string }>('/ibkr/flex/sync').then(r => r.data)

export const getAllFlexConfigs = () =>
  api.get<IBKRFlexConfig[]>('/ibkr/flex/configs').then(r => r.data)

export const syncAllFlexAccounts = () =>
  api.post<{ job_id: string; status: string }>('/ibkr/flex/sync-all').then(r => r.data)

export const launchIBKRGateway = () =>
  api.post<{ ok: boolean; app_path: string }>('/ibkr/launch').then(r => r.data)

export const getIBKRManagedAccounts = () =>
  api.get<{ ok: boolean; accounts: string[]; error?: string }>('/ibkr/managed-accounts').then(r => r.data)

export const syncIBKRTransactions = () =>
  api.post<{ job_id: string; status: string; already_running: boolean }>('/ibkr/sync-transactions').then(r => r.data)

export default api
