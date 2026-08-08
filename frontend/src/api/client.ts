import axios from 'axios'

// In production (Render static site) VITE_API_BASE_URL points to the backend service.
// In local dev the Vite proxy handles /api → localhost:8000, so we keep '/api' as the fallback.
const API_BASE = import.meta.env.VITE_API_BASE_URL
  ? `${import.meta.env.VITE_API_BASE_URL}/api`
  : '/api'

const api = axios.create({
  baseURL: API_BASE,
  headers: { 'Content-Type': 'application/json' },
  withCredentials: true,   // send the httpOnly session cookie on every request
})

// On 401 (session cookie missing/expired/invalid) → redirect to login
api.interceptors.response.use(
  r => r,
  error => {
    if (error.response?.status === 401) {
      window.location.href = '/login'
    }
    return Promise.reject(error)
  }
)

// ── Auth API ──────────────────────────────────────────────────────────────────
export const changePassword = (data: { current_password: string; new_password: string }) =>
  api.post('/auth/change-password', data).then(r => r.data)

export const updateMyPreferences = (data: { refresh_prices_on_login?: boolean; notify_covered_call_alerts?: boolean }) =>
  api.patch('/auth/me/preferences', data).then(r => r.data)

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
  is_demo: boolean
}

export const getClients = (includeDemo = false) =>
  api.get<Client[]>('/clients', { params: includeDemo ? { include_demo: true } : {} }).then(r => r.data)

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

export const getAccounts = (includeDemo = false) =>
  api.get<Account[]>('/accounts', { params: includeDemo ? { include_demo: true } : {} }).then(r => r.data)
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
  interest_rate: string | null
}

export const getSecurities = (params?: { search?: string; asset_class?: string }) =>
  api.get<Security[]>('/securities', { params }).then(r => r.data)
export const getSecurity = (id: number) => api.get<Security>(`/securities/${id}`).then(r => r.data)
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
export const mergeSecurities = (sourceId: number, targetId: number) =>
  api.post<{ merged: string; into: string; transactions_moved: number }>(
    '/admin/securities/merge', { source_security_id: sourceId, target_security_id: targetId }).then(r => r.data)
export const deleteUnusedSecurities = () => api.delete('/admin/bulk/securities').then(r => r.data)

// ─── Note Details (structured notes, mortgages, etc.) ────────────────────────
export interface NoteDetails {
  reference_asset: string | null
  payment_amount: string | null
  payment_frequency: string | null
  payment_barrier_pct: string | null
  autocall_level_pct: string | null
  barrier_level_pct: string | null
  status: string | null
  product_category: string | null
  cusip_code: string | null
  adp_code: string | null
  issue_date: string | null
  maturity_date: string | null
  term_years: string | null
  original_filename: string | null
  content_type: string | null
  byte_size: number | null
  uploaded_at: string | null
}

export type NoteDetailsExtracted = Pick<NoteDetails,
  'reference_asset' | 'payment_amount' | 'payment_frequency' | 'payment_barrier_pct' |
  'autocall_level_pct' | 'barrier_level_pct' | 'status' | 'product_category' |
  'cusip_code' | 'adp_code' | 'issue_date' | 'maturity_date' | 'term_years'>

export const getNoteDetails = (securityId: number) =>
  api.get<NoteDetails>(`/securities/${securityId}/note-details`).then(r => r.data)

export const updateNoteDetails = (securityId: number, data: Partial<NoteDetails>) =>
  api.put<NoteDetails>(`/securities/${securityId}/note-details`, data).then(r => r.data)

/** Uploads the info-sheet PDF and, best-effort, extracts its term-sheet fields (Gemini) —
 *  returned as `extracted` for the caller to merge into its edit form, not auto-saved. */
export const uploadNoteDetailsFile = (securityId: number, file: File) => {
  const fd = new FormData()
  fd.append('file', file)
  return api.post<NoteDetails & { extracted: NoteDetailsExtracted | null }>(
    `/securities/${securityId}/note-details/file`, fd,
    { headers: { 'Content-Type': 'multipart/form-data' } },
  ).then(r => r.data)
}

export const openNoteDetailsFile = async (securityId: number) => {
  const r = await api.get(`/securities/${securityId}/note-details/file`, { responseType: 'blob' })
  const url = URL.createObjectURL(new Blob([r.data], { type: 'application/pdf' }))
  window.open(url, '_blank')
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}

export const deleteNoteDetailsFile = (securityId: number) =>
  api.delete<{ deleted: boolean }>(`/securities/${securityId}/note-details/file`).then(r => r.data)

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
export const bulkDeleteTransactions = (ids: number[]) =>
  api.post<{ deleted: number }>('/transactions/bulk-delete', { ids }).then(r => r.data)

// ─── Security ↔ Account transaction-type overrides ───────────────────────────
// Forward-looking reclassify rules (e.g. "DIVIDEND -> DRIP for PGF550 in SW Brian Income"),
// applied at import time. See backend/app/models/master.py SecurityAccountTypeOverride.
export interface TypeOverride {
  id: number
  security_id: number
  account_id: number
  account_name: string
  from_type: string
  to_type: string
}
export const getTypeOverrides = (securityId: number) =>
  api.get<TypeOverride[]>(`/securities/${securityId}/type-overrides`).then(r => r.data)
export const createTypeOverride = (securityId: number, data: { account_id: number; from_type: string; to_type: string }) =>
  api.post<{ id: number; updated: boolean }>(`/securities/${securityId}/type-overrides`, data).then(r => r.data)
export const deleteTypeOverride = (id: number) =>
  api.delete(`/securities/type-overrides/${id}`).then(r => r.data)

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
  day_high?: string | null
  day_low?: string | null
  week52_high?: string | null
  week52_low?: string | null
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

export interface PriceJobProgress {
  stage: string
  source: string | null
  done: number
  total: number
}
export interface PriceJob {
  id: string
  name: string
  status: 'running' | 'done' | 'error'
  started_at: string
  finished_at: string | null
  result: Record<string, unknown> | null
  error: string | null
  progress: PriceJobProgress | null
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
    brokerage?: string
    quantity: string
    total_acb_cad: string
  }>
}

export interface YahooDetail {
  available: boolean
  reason?: string
  symbol?: string
  current_price?: number | null
  price_currency?: string | null
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

export interface SplitEvent {
  date: string   // 'YYYY-MM-DD'
  ratio: number  // e.g. 10 = 10-for-1
}
export interface LivePriceHistory {
  available: boolean
  reason?: string
  symbol?: string
  currency?: string
  points: { date: string; close: number; close_cad: number | null }[]
  splits: SplitEvent[]
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

export const getMarketIndicators = (country: 'CA' | 'US' = 'CA') =>
  api.get<MarketIndicator[]>('/prices/market-indicators', { params: { country } }).then(r => r.data)

export const getSummaryMetrics = (params?: { account_ids?: string; as_of?: string }) =>
  api.get<SummaryMetrics>('/portfolio/summary-metrics', { params }).then(r => r.data)
export const getSecurityYahooDetail = (id: number) =>
  api.get<YahooDetail>(`/securities/${id}/yahoo-detail`).then(r => r.data)
export const getSecurityPriceHistory = (id: number, period = '1y') =>
  api.get<PriceHistoryPoint[]>(`/securities/${id}/price-history`, { params: { period } }).then(r => r.data)
export const getSecurityPriceHistoryLive = (id: number, period = '1y') =>
  api.get<LivePriceHistory>(`/securities/${id}/price-history-live`, { params: { period } }).then(r => r.data)
export const getSecurityFundamentals = (id: number) =>
  api.get<StoredFundamentals>(`/securities/${id}/fundamentals`).then(r => r.data)
export const refreshSecurityFundamentals = (id: number) =>
  api.post(`/securities/${id}/refresh-fundamentals`).then(r => r.data)
export const getSecuritySignals = (id: number) =>
  api.get<SecuritySignals>(`/securities/${id}/signals`).then(r => r.data)
export const computeSecuritySignals = (id: number) =>
  api.post(`/securities/${id}/compute-signals`).then(r => r.data)

export interface SecurityNewsItem {
  id: string
  title: string
  summary: string | null
  published_at: string | null
  publisher: string | null
  url: string
  thumbnail_url: string | null
}
export const getSecurityNews = (id: number) =>
  api.get<{ symbol: string | null; items: SecurityNewsItem[] }>(`/securities/${id}/news`).then(r => r.data)

export const getMarketNews = (country: 'CA' | 'US' = 'CA') =>
  api.get<{ items: SecurityNewsItem[] }>('/market/news', { params: { country } }).then(r => r.data)
export const getTopStories = () =>
  api.get<{ items: SecurityNewsItem[] }>('/market/top-stories').then(r => r.data)
export const getPortfolioNews = () =>
  api.get<{ items: SecurityNewsItem[] }>('/market/portfolio-news').then(r => r.data)

export interface BulkFundamentalsSignals {
  [securityId: string]: {
    fundamentals: StoredFundamentals | null
    signals: SecuritySignals | null
  }
}
export const getBulkFundamentalsSignals = (securityIds: number[]) =>
  api.get<BulkFundamentalsSignals>('/securities/bulk/fundamentals-signals', {
    params: { security_ids: securityIds.join(',') },
  }).then(r => r.data)
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
  account_type: string | null
  brokerage_name: string
  security_id: number | null
  ticker: string
  transaction_type: string
  amount_cad: string
  currency: string
  amount_native: string
}
export const getInvestmentIncome = (params?: { account_id?: number; account_ids?: string; year?: number; brokerage_name?: string }) =>
  api.get<IncomeItem[]>('/portfolio/income', { params }).then(r => r.data)

export interface ProjectedIncomeRow {
  security_id: number
  ticker: string
  security_name: string | null
  asset_class: string
  brokerage_name: string
  account_type: string
  quantity: string
  market_value_cad: string | null
  rate_type: 'DIVIDEND' | 'INTEREST' | 'DIVIDEND_EST' | 'INTEREST_EST' | null
  rate_pct: string | null
  projected_annual_income_cad: string | null
}
export const getProjectedIncome = (params?: { account_ids?: string }) =>
  api.get<ProjectedIncomeRow[]>('/portfolio/income/projected', { params }).then(r => r.data)
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
  positions?: Array<{ ticker: string; security_id: number | null; value_cad: number; weight_pct: number }>
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

export interface SecurityNeedsFix {
  security_id: number
  ticker: string
  name: string | null
  currency: string | null
}
export const checkImportSecurities = (batchId: number) =>
  api.post<{ needs_fix: SecurityNeedsFix[] }>(`/imports/${batchId}/check-securities`).then(r => r.data)

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
export const getFxRates = (limit = 100, params?: { year?: string; from_date?: string; to_date?: string }) =>
  api.get<FXRate[]>('/admin/fx-rates', { params: { limit, ...params } }).then(r => r.data)
export const getFxRateLookup = (date: string, fromCurrency: string, toCurrency = 'CAD') =>
  api.get<{ date: string; from_currency: string; to_currency: string; rate: string }>(
    '/admin/fx-rates/lookup',
    { params: { date, from_currency: fromCurrency, to_currency: toCurrency } }
  ).then(r => r.data)
export const refreshFxRates = () => api.post('/admin/fx-rates/refresh').then(r => r.data)

export interface SchedulerStatus {
  jobs: { id: string; name: string; next_run: string | null }[]
  log: { name: string; status: string; detail: string; at: string }[]
}
export const getSchedulerStatus = () => api.get<SchedulerStatus>('/system/scheduler').then(r => r.data)
export const runSchedulerNow = () => api.post('/system/scheduler/run').then(r => r.data)
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

export interface TimelinePoint {
  date:     string
  values:   Record<string, number>
  invested: Record<string, number>
}
export interface TimelineResponse {
  series_labels: string[]
  points:        TimelinePoint[]
}
export const getPortfolioTimeline = (params: {
  group_by:     'total' | 'brokerage' | 'account_type' | 'account'
  from_date?:   string
  to_date?:     string
  account_ids?: string
}) => api.get<TimelineResponse>('/portfolio/performance/timeline', { params }).then(r => r.data)

export const computeSnapshots = (params?: {
  account_ids?: string
  from_date?:   string
}) => api.post<{ job_id: string; status: string }>('/portfolio/compute-snapshots', null, { params }).then(r => r.data)

export interface SnapshotFreshness {
  stale: boolean
  latest_snapshot_date: string | null
  latest_price_date: string | null
  latest_transaction_date: string | null
  computing: boolean
}
export const getSnapshotFreshness = () =>
  api.get<SnapshotFreshness>('/portfolio/snapshots/freshness').then(r => r.data)

export const getPortfolioJob = (jobId: string) =>
  api.get<{ id: string; name: string; status: string; result?: unknown; error?: string }>(`/portfolio/jobs/${jobId}`).then(r => r.data)

export interface DataHealthCheck {
  key: string
  title: string
  severity: 'warning' | 'danger'
  status: 'pass' | 'warning' | 'danger'
  count: number
  items: Record<string, unknown>[]
  hint: string
  action: { label: string; route: string }
}
export interface DataHealthReport {
  generated_at: string
  issue_count: number
  checks_passing: number
  checks_total: number
  checks: DataHealthCheck[]
}
export const getDataHealth = () =>
  api.get<DataHealthReport>('/portfolio/data-health').then(r => r.data)

export const logoutApi = () => api.post('/auth/logout').then(r => r.data)

export interface IBeamStatus {
  configured: boolean
  container: { name: string; status: string; started_at: string | null; error?: string } | null
  authenticated: boolean
}
export const getIBeamStatus = () => api.get<IBeamStatus>('/ibeam/status').then(r => r.data)
export const startIBeam = () => api.post('/ibeam/start').then(r => r.data)
export const restartIBeam = () => api.post('/ibeam/restart').then(r => r.data)
export const stopIBeam = () => api.post('/ibeam/stop').then(r => r.data)

export interface ExpiredOption {
  security_id: number
  account_id: number
  ticker: string
  account: string | null
  expiry: string
  days_past: number
  quantity: string
  is_short: boolean
  est_realized_cad: string
  already_recorded: boolean
}
export const getExpiredOptions = () =>
  api.get<{ count: number; items: ExpiredOption[] }>('/portfolio/expired-options').then(r => r.data)
export const closeExpiredOptions = (body: { keys?: number[][]; all?: boolean }) =>
  api.post<{ closed: number; skipped: number; accounts: number }>('/portfolio/expired-options/close', body).then(r => r.data)

export interface OptionRetypePreview {
  sell: number
  buy: number
  total: number
  other: number
  by_brokerage: { brokerage: string; count: number }[]
  sample: { date: string; type: string; ticker: string; quantity: string; cad_amount: string | null; account: string }[]
}
export const getOptionRetypePreview = () =>
  api.get<OptionRetypePreview>('/portfolio/option-retype/preview').then(r => r.data)
export const applyOptionRetype = () =>
  api.post<{ applied: boolean; sell_retyped: number; buy_retyped: number }>('/portfolio/option-retype/apply', { confirm: true }).then(r => r.data)
export const revertOptionRetype = () =>
  api.post<{ reverted: boolean; sell: number; buy: number }>('/portfolio/option-retype/revert', { confirm: true }).then(r => r.data)

export interface OptionLiveQuote {
  bid: number | null
  ask: number | null
  delta: number | null
  gamma: number | null
  theta: number | null
  vega: number | null
  iv_pct: number | null
}
export const getOptionsLive = () =>
  api.get<{ available: boolean; quotes: Record<string, OptionLiveQuote> }>('/portfolio/options-live').then(r => r.data)

export const purgeSnapshots = (params?: {
  account_ids?: string
  from_date?:   string
}) => api.delete<{ deleted: number; account_ids: number[] | null; from_date: string | null }>('/portfolio/purge-snapshots', { params }).then(r => r.data)

export const refreshSnapshotViews = () =>
  api.post<{ status: string; rows?: number; reason?: string; detail?: string }>('/portfolio/refresh-snapshot-views').then(r => r.data)

export const getSnapshotViewStatus = () =>
  api.get<{ rows: number; last_refresh: string | null; view_name: string }>('/portfolio/snapshot-views/status').then(r => r.data)

export const setManualPrice = (securityId: number, price: number, currency: string) =>
  api.put(`/prices/${securityId}/manual`, { price, currency }).then(r => r.data)

export const clearManualPrice = (securityId: number) =>
  api.delete(`/prices/${securityId}`).then(r => r.data)

export const recordOptionHistory = () =>
  api.post('/prices/record-option-history').then(r => r.data)

// ─── IBKR Flex Query ──────────────────────────────────────────────────────────

export interface ImportDetail {
  date: string
  type: string
  ticker: string
  qty: string
  amount: string
  currency: string
  account: string
}

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
  last_sync_details: string | null   // JSON-encoded ImportDetail[]
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

export const uploadFlexXml = (file: File) => {
  const fd = new FormData()
  fd.append('file', file)
  return api.post<{ imported: number; message: string; error: string | null; details?: ImportDetail[] }>(
    '/ibkr/flex/upload-xml', fd,
    { headers: { 'Content-Type': 'multipart/form-data' } },
  ).then(r => r.data)
}

export const getAllFlexConfigs = () =>
  api.get<IBKRFlexConfig[]>('/ibkr/flex/configs').then(r => r.data)

export const importStatement = (file: File, owner: string, accountId?: number | null) => {
  const fd = new FormData()
  fd.append('file', file)
  fd.append('owner', owner)
  if (accountId != null) fd.append('account_id', String(accountId))
  return api.post<{ institution: string; account: string; as_of: string; currency: string; holdings: number; total: string; contribution: string | null; engine: string }>(
    '/imports/statement', fd,
    { headers: { 'Content-Type': 'multipart/form-data' } },
  ).then(r => r.data)
}

export interface StoredStatement {
  id: number
  account_id: number | null
  account: string | null
  institution: string | null
  owner: string | null
  as_of: string | null
  original_filename: string | null
  byte_size: number
  engine: string | null
  uploaded_at: string | null
}

export const listStatements = () =>
  api.get<StoredStatement[]>('/imports/statements').then(r => r.data)

export const openStatementFile = async (id: number) => {
  const r = await api.get(`/imports/statements/${id}/file`, { responseType: 'blob' })
  const url = URL.createObjectURL(new Blob([r.data], { type: 'application/pdf' }))
  window.open(url, '_blank')
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}

export const deleteStatement = (id: number) =>
  api.delete<{ deleted: number }>(`/imports/statements/${id}`).then(r => r.data)

export const reprocessStatement = (id: number) =>
  api.post<{ account: string; as_of: string; holdings: number }>(`/imports/statements/${id}/reprocess`).then(r => r.data)

export const reprocessStatements = (accountId?: number) =>
  api.post<{ reprocessed: number; total: number; results: { id: number; as_of: string | null; account?: string; holdings?: number; error?: string }[] }>(
    `/imports/statements/reprocess${accountId ? `?account_id=${accountId}` : ''}`).then(r => r.data)

export interface ImportStatusRow {
  account_id: number
  brokerage: string
  account: string
  owner: string
  account_type: string
  source: string
  last_loaded: string | null
  latest_txn: string | null
  days_since_load: number | null
  stale: boolean
  note: string | null
}

export const getImportStatus = () =>
  api.get<ImportStatusRow[]>('/imports/status').then(r => r.data)

export const switchSecurity = (accountId: number, fromSecurityId: number, toSecurityId: number, switchDate: string) =>
  api.post<{ account: string; from: string; to: string; switch_date: string; value_moved_cad: string }>(
    '/imports/switch',
    { account_id: accountId, from_security_id: fromSecurityId, to_security_id: toSecurityId, switch_date: switchDate },
  ).then(r => r.data)

export const statementHandoff = (accountId: number, cutoverDate: string) =>
  api.post<{ account: string; cutover_date: string; securities_unwound: number }>(
    '/imports/statements/handoff', { account_id: accountId, cutover_date: cutoverDate },
  ).then(r => r.data)

export const syncAllFlexAccounts = () =>
  api.post<{ job_id: string; status: string }>('/ibkr/flex/sync-all').then(r => r.data)


// ─── Scanner (IBeam status + extra-candidate watchlist only — the scan/results UI
//     was retired in favour of the Covered Call Portfolio Builder below) ───────

export interface ScannerMeta {
  available: boolean
  scan_run_id?: string
  scanned_at?: string
  total_rows?: number
  tickers?: number
  ibeam_available?: boolean
}

export interface WatchlistItem {
  id: number
  ticker: string
  company_name: string | null
  notes: string | null
  added_at: string | null
}

export const getScannerMeta = () =>
  api.get<ScannerMeta>('/scanner/meta').then(r => r.data)

export const getWatchlist = () =>
  api.get<WatchlistItem[]>('/scanner/watchlist').then(r => r.data)

export const addToWatchlist = (ticker: string, notes?: string) =>
  api.post<WatchlistItem>('/scanner/watchlist', { ticker, notes }).then(r => r.data)

export const removeFromWatchlist = (ticker: string) =>
  api.delete(`/scanner/watchlist/${ticker}`).then(r => r.data)

// ─── Covered Call Portfolio Builder & Manager ───────────────────────────────

export interface CoveredCallPick {
  ticker: string
  company_name: string | null
  current_price: number
  currency: string | null
  dividend_yield: number | null
  strike: number
  expiry_date: string
  dte: number
  bid: number
  ask: number
  mid: number
  volume: number
  open_interest: number
  iv_pct: number | null
  hv_30_pct: number | null
  iv_hv_ratio: number | null
  otm_pct: number
  annual_yield_pct: number
  max_return_pct: number
  breakeven: number
  score: number
  why: string
  recommendation: string
  delta: number | null
  theta: number | null
  data_source: string
  in_portfolio: boolean
  portfolio_qty: number
}

export interface ProposeParams {
  min_dte?: number
  max_dte?: number
  min_otm_pct?: number
  max_otm_pct?: number
  min_option_oi?: number
  min_option_vol?: number
  min_avg_stock_vol?: number
  min_div_yield?: number
  min_annual_yield_pct?: number
  min_delta?: number
  max_delta?: number
  min_iv_pct?: number
  num_ca?: number
  num_us?: number
  extra_tickers?: string[]
  /** Rank the full in-screener-universe (S&P 500 / TSX 60) by liquidity, volatility & yield
   *  instead of the hand-curated static candidate list. Defaults ON. */
  dynamic_universe?: boolean
  us_pool?: number
  ca_pool?: number
  /** Step 2 of the two-step flow — an explicit ticker list approved in Step 1 (screen).
   *  When set, num_ca/num_us/extra_tickers are ignored; only these tickers are scanned. */
  tickers?: string[]
}

export interface ProposeResult {
  picks: CoveredCallPick[]
  ca_picks: number
  us_picks: number
  ca_candidates_scanned: number
  us_candidates_scanned: number
  errors: string[]
  data_source: string
  shortfall: { ca: number; us: number }
}

export interface CoveredCallScreenRow {
  ticker: string
  company_name: string | null
  currency: string | null
  current_price: number | null
  dividend_yield: number | null
  avg_stock_volume: number | null
  contracts_found: number
  total_open_interest: number
  best_score: number
  median_score: number
  best_annual_yield_pct: number
  best_iv_pct: number | null
  best_iv_hv_ratio: number | null
  best_dte: number
  best_strike: number
  best_expiry_date: string
  best_recommendation: string | null
}

export interface ScreenResult {
  ca: CoveredCallScreenRow[]
  us: CoveredCallScreenRow[]
  ca_candidates_scanned: number
  us_candidates_scanned: number
  errors: string[]
  data_source: string
}

export const screenStockUniverse = (params?: ProposeParams) =>
  api.post<{ job_id: string; status: string; already_running: boolean }>('/covered-call-portfolio/screen', params ?? {}).then(r => r.data)

export const getScreenJob = (jobId: string) =>
  api.get<{ id: string; status: string; result?: ScreenResult; error?: string; progress?: { stage: string; source: string | null; done: number; total: number } }>(
    `/covered-call-portfolio/screen/${jobId}`
  ).then(r => r.data)

export interface CoveredCallTrade {
  id: number
  trade_type: string
  strike: number
  expiry_date: string
  contracts: number
  premium_per_contract: number | null
  trade_date: string | null
  roll_chain_id: string | null
  notes: string | null
}

export interface CoveredCallHolding {
  id: number
  security_id: number
  ticker: string | null
  company_name: string | null
  currency: string | null
  shares: number | null
  cost_basis_per_share: number | null
  status: string
  opened_at: string | null
  proposal_score: number | null
  proposal_why: string | null
  trades: CoveredCallTrade[]
}

export interface CoveredCallPortfolioSummary {
  id: number
  name: string
  mode: 'SIMULATED' | 'REAL'
  status: string
  account_id: number | null
  created_at: string | null
  holdings: number
}

export interface CoveredCallPortfolioDetail extends Omit<CoveredCallPortfolioSummary, 'holdings'> {
  holdings: CoveredCallHolding[]
}

export const proposeCoveredCallPortfolio = (params?: ProposeParams) =>
  api.post<{ job_id: string; status: string; already_running: boolean }>('/covered-call-portfolio/propose', params ?? {}).then(r => r.data)

export const getProposeJob = (jobId: string) =>
  api.get<{ id: string; status: string; result?: ProposeResult; error?: string; progress?: { stage: string; source: string | null; done: number; total: number } }>(
    `/covered-call-portfolio/propose/${jobId}`
  ).then(r => r.data)

export const adoptCoveredCallPortfolio = (data: { name: string; mode: 'SIMULATED' | 'REAL'; account_id?: number; picks: CoveredCallPick[] }) =>
  api.post<{ id: number; name: string; mode: string; holdings: number }>('/covered-call-portfolio/adopt', data).then(r => r.data)

export const listCoveredCallPortfolios = () =>
  api.get<CoveredCallPortfolioSummary[]>('/covered-call-portfolio').then(r => r.data)

export const getCoveredCallPortfolio = (id: number) =>
  api.get<CoveredCallPortfolioDetail>(`/covered-call-portfolio/${id}`).then(r => r.data)

export const sellToOpen = (portfolioId: number, holdingId: number, data: {
  strike: number; expiry_date: string; contracts?: number; premium_per_contract?: number; trade_date?: string; notes?: string
}) => api.post(`/covered-call-portfolio/${portfolioId}/holdings/${holdingId}/sell-to-open`, data).then(r => r.data)

export const rollCoveredCall = (portfolioId: number, holdingId: number, data: {
  close_premium_per_contract?: number; new_strike: number; new_expiry_date: string
  new_premium_per_contract?: number; contracts?: number; trade_date?: string; notes?: string
}) => api.post(`/covered-call-portfolio/${portfolioId}/holdings/${holdingId}/roll`, data).then(r => r.data)

export const closeCoveredCall = (portfolioId: number, holdingId: number, data: {
  outcome: 'ASSIGNED' | 'EXPIRED_WORTHLESS'; trade_date?: string; notes?: string
}) => api.post(`/covered-call-portfolio/${portfolioId}/holdings/${holdingId}/close`, data).then(r => r.data)

export interface CoveredCallSummary {
  portfolio_id: number
  total_premium_collected: number
  total_cost_basis: number | null
  annualized_yield_on_capital_pct: number | null
  trade_counts: Record<string, number>
  per_holding: { holding_id: number; ticker: string | null; premium_collected: number; status: string }[]
}

export const getCoveredCallSummary = (portfolioId: number) =>
  api.get<CoveredCallSummary>(`/covered-call-portfolio/${portfolioId}/summary`).then(r => r.data)

export interface UnmatchedTransaction {
  transaction_id: number
  holding_id: number
  underlying: string
  transaction_type: string
  suggested_trade_type: string
  option_type: string
  strike: number
  expiry_date: string
  contracts: number | null
  transaction_date: string | null
  transaction_amount: number | null
}

export const getUnmatchedTransactions = (portfolioId: number) =>
  api.get<UnmatchedTransaction[]>(`/covered-call-portfolio/${portfolioId}/unmatched-transactions`).then(r => r.data)

export const matchTransaction = (portfolioId: number, holdingId: number, transactionId: number) =>
  api.post(`/covered-call-portfolio/${portfolioId}/holdings/${holdingId}/match-transaction`, { transaction_id: transactionId }).then(r => r.data)

export interface CoveredCallCalendarEntry {
  portfolio_id: number
  portfolio_name: string
  mode: 'SIMULATED' | 'REAL'
  holding_id: number
  ticker: string | null
  currency: string | null
  strike: number
  expiry_date: string
  dte: number
  contracts: number
  premium_per_contract: number | null
  current_price: number | null
  itm: boolean
}

export const getCoveredCallCalendar = () =>
  api.get<CoveredCallCalendarEntry[]>('/covered-call-portfolio/calendar').then(r => r.data)

// ── Plaid ─────────────────────────────────────────────────────────────────────
export interface PlaidItem {
  id: number
  institution: string | null
  accounts: number
  last_synced_at: string | null
}
export const getPlaidStatus = () =>
  api.get<{ configured: boolean; env: string }>('/plaid/status').then(r => r.data)
export const createPlaidLinkToken = () =>
  api.post<{ link_token: string }>('/plaid/link-token', {}).then(r => r.data)
export const exchangePlaidToken = (public_token: string, owner: string) =>
  api.post('/plaid/exchange', { public_token, owner }).then(r => r.data)
export const sandboxCreatePlaid = (owner: string) =>
  api.post('/plaid/sandbox-create', { public_token: 'sandbox', owner }).then(r => r.data)
export const getPlaidItems = () =>
  api.get<PlaidItem[]>('/plaid/items').then(r => r.data)
export const syncPlaidItem = (id: number) =>
  api.post(`/plaid/items/${id}/sync`, {}).then(r => r.data)
export const syncAllPlaid = () =>
  api.post('/plaid/sync', {}).then(r => r.data)
export const deletePlaidItem = (id: number) =>
  api.delete(`/plaid/items/${id}`).then(r => r.data)

// ─── Fundamental Screener ─────────────────────────────────────────────────────

export interface ScreenerStatus {
  universe_size: number
  with_fundamentals: number
  last_fetched_at: string | null
  refreshing: boolean
}
export interface ScreenerResult {
  security_id: number
  ticker: string
  name: string | null
  exchange: string | null
  sector: string | null
  industry: string | null
  currency: string | null
  market_cap: number | null
  pe_ratio: number | null
  forward_pe: number | null
  peg_ratio: number | null
  debt_to_equity: number | null
  return_on_equity: number | null
  revenue_growth: number | null
  profit_margin: number | null
  dividend_yield: number | null
  price_to_book: number | null
  beta: number | null
  composite_score: number | null
  fetched_at: string | null
}
export interface ScreenerFilters {
  sector?: string
  min_pe?: number; max_pe?: number
  min_debt_to_equity?: number; max_debt_to_equity?: number
  min_roe_pct?: number; max_roe_pct?: number
  min_revenue_growth_pct?: number; max_revenue_growth_pct?: number
  min_dividend_yield_pct?: number; max_dividend_yield_pct?: number
  min_market_cap?: number
  sort_by?: string
  sort_dir?: 'asc' | 'desc'
}

export const getScreenerStatus = () =>
  api.get<ScreenerStatus>('/screener/status').then(r => r.data)
export const seedScreenerUniverse = () =>
  api.post<{ universe_tickers: number; newly_flagged: number; job_id: string; status: string; already_running: boolean }>('/screener/seed-universe', {}).then(r => r.data)
export const refreshScreenerUniverse = () =>
  api.post<{ job_id: string; status: string; already_running: boolean }>('/screener/refresh', {}).then(r => r.data)
export interface IndexSyncResult {
  us_constituents: number
  ca_constituents: number
  added: string[]
  dropped: string[]
  added_count: number
  dropped_count: number
  job_id?: string   // background job backfilling name/sector for newly-added constituents
  status?: string
}
export const syncScreenerIndex = () =>
  api.post<IndexSyncResult>('/screener/sync-index', {}).then(r => r.data)
export const getScreenerResults = (filters: ScreenerFilters = {}) =>
  api.get<ScreenerResult[]>('/screener/results', { params: filters }).then(r => r.data)
export const getScreenerSectors = () =>
  api.get<string[]>('/screener/sectors').then(r => r.data)

// ─── IBKR Market Scanner (prototype) ────────────────────────────────────────
export interface ScannerInstrumentDef {
  display_name: string
  type: string
  filters: string[]
}
export interface ScannerScanTypeDef {
  display_name: string
  code: string
  instruments: string[]
}
export interface ScannerFilterDef {
  group: string
  display_name: string
  code: string
  type: string
}
export interface ScannerLocationNode {
  display_name: string
  type: string
  locations?: ScannerLocationNode[]
}
export interface ScannerParams {
  scan_type_list: ScannerScanTypeDef[]
  instrument_list: ScannerInstrumentDef[]
  filter_list: ScannerFilterDef[]
  location_tree: ScannerLocationNode[]
}
export const getIbkrScannerParams = () =>
  api.get<ScannerParams>('/ibkr-scanner/params').then(r => r.data)

export interface IbkrScanResult {
  symbol: string | null
  company_name: string | null
  exchange: string | null
  con_id: number | null
  sec_type: string | null
  last_price: number | null
  change: number | null
  change_pct: number | null
  day_high: number | null
  day_low: number | null
  open: number | null
  prior_close: number | null
  volume: string | null
  avg_volume: string | null
  week52_high: number | null
  week52_low: number | null
  industry: string | null
}
export const runIbkrScanner = (data: {
  instrument: string
  location: string
  scan_code: string
  filters: { code: string; value: number }[]
}) => api.post<{ items: IbkrScanResult[] }>('/ibkr-scanner/run', data).then(r => r.data)

// ─── Personal Assets & Liabilities (net worth) ────────────────────────────────

export type PersonalAssetClass = 'REAL_ESTATE' | 'LIFE_INSURANCE' | 'OTHER_ASSET' | 'LIABILITY'

// Personal assets/liabilities share the same Security/Position pipeline as real
// investment holdings, but should never appear as ordinary rows on investment-focused
// pages (Holdings, Dashboard's Brokerage/Account table) — they get their own dedicated
// Net Worth views instead.
export const PERSONAL_ASSET_CLASSES: ReadonlySet<string> = new Set(
  ['REAL_ESTATE', 'LIFE_INSURANCE', 'OTHER_ASSET', 'LIABILITY'] satisfies PersonalAssetClass[],
)

export interface PersonalAsset {
  security_id: number
  ticker: string
  name: string | null
  asset_class: PersonalAssetClass
  currency: string
  interest_rate: string | null
  owner: string | null
  acquired_date: string | null
  current_value: string | null
  current_value_cad: string | null
  value_updated_at: string | null
  property_type: string | null
  address_street: string | null
  address_city: string | null
  address_province: string | null
  address_postal_code: string | null
  address_country: string | null
  purchase_date: string | null
  purchase_price: string | null
  policy_number: string | null
  insurer_name: string | null
  beneficiary: string | null
  death_benefit_cad: string | null
  contract_type: string | null
  sum_insured_cad: string | null
  insured_name: string | null
  lender_name: string | null
  original_principal_cad: string | null
  maturity_date: string | null
  linked_security_id: number | null
  linked_name: string | null
  is_corporate: boolean
  entity_name: string | null
  zillow_estimate_cad: string | null
  zillow_estimate_date: string | null
  notes: string | null
  original_filename: string | null
  content_type: string | null
  byte_size: number | null
  uploaded_at: string | null
}

export interface PersonalAssetCreate {
  asset_class: PersonalAssetClass
  name: string
  owner: string
  value: number
  currency?: string
  acquired_date?: string
  interest_rate?: number
  property_type?: string
  address_street?: string
  address_city?: string
  address_province?: string
  address_postal_code?: string
  address_country?: string
  purchase_date?: string
  purchase_price?: number
  policy_number?: string
  insurer_name?: string
  beneficiary?: string
  death_benefit_cad?: number
  contract_type?: string
  sum_insured_cad?: number
  insured_name?: string
  lender_name?: string
  original_principal_cad?: number
  maturity_date?: string
  linked_security_id?: number
  is_corporate?: boolean
  entity_name?: string
  zillow_estimate_cad?: number
  zillow_estimate_date?: string
  notes?: string
}

export type PersonalAssetUpdate = Partial<Omit<PersonalAssetCreate, 'asset_class' | 'owner'>> & {
  as_of?: string   // dates a `value` update — see backend _set_value
}

export interface PersonalAssetIncomeEntry {
  id: number
  entry_date: string
  category: 'RENT' | 'EXPENSE' | 'OTHER_INCOME'
  amount_cad: string
  description: string | null
}

export const getPersonalAssets = () =>
  api.get<PersonalAsset[]>('/personal-assets').then(r => r.data)

export const createPersonalAsset = (data: PersonalAssetCreate) =>
  api.post<{ security_id: number; ticker: string }>('/personal-assets', data).then(r => r.data)

export const updatePersonalAsset = (securityId: number, data: PersonalAssetUpdate) =>
  api.put(`/personal-assets/${securityId}`, data).then(r => r.data)

export const deletePersonalAsset = (securityId: number) =>
  api.delete(`/personal-assets/${securityId}`).then(r => r.data)

export const uploadPersonalAssetFile = (securityId: number, file: File) => {
  const fd = new FormData()
  fd.append('file', file)
  return api.post(`/personal-assets/${securityId}/file`, fd, {
    headers: { 'Content-Type': 'multipart/form-data' },
  }).then(r => r.data)
}

export interface InsuranceStatementParsed {
  insurer_name: string | null
  contract_type: string | null
  policy_number: string | null
  policy_issue_date: string | null
  statement_date: string
  insured_name: string | null
  beneficiary: string | null
  sum_insured: string | null
  death_benefit: string | null
  cash_surrender_value: string | null
}

export const parseInsuranceStatement = (securityId: number, file: File) => {
  const fd = new FormData()
  fd.append('file', file)
  return api.post<{ security_id: number; parsed: InsuranceStatementParsed }>(
    `/personal-assets/${securityId}/parse-statement`, fd,
    { headers: { 'Content-Type': 'multipart/form-data' } },
  ).then(r => r.data)
}

export const openPersonalAssetFile = async (securityId: number) => {
  const r = await api.get(`/personal-assets/${securityId}/file`, { responseType: 'blob' })
  const url = URL.createObjectURL(new Blob([r.data], { type: 'application/pdf' }))
  window.open(url, '_blank')
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}

export const deletePersonalAssetFile = (securityId: number) =>
  api.delete(`/personal-assets/${securityId}/file`).then(r => r.data)

export const getPersonalAssetIncomeEntries = (securityId: number) =>
  api.get<PersonalAssetIncomeEntry[]>(`/personal-assets/${securityId}/income-entries`).then(r => r.data)

export const createPersonalAssetIncomeEntry = (securityId: number, data: {
  entry_date: string; category: 'RENT' | 'EXPENSE' | 'OTHER_INCOME'; amount_cad: number; description?: string
}) => api.post<{ id: number }>(`/personal-assets/${securityId}/income-entries`, data).then(r => r.data)

export const deletePersonalAssetIncomeEntry = (securityId: number, entryId: number) =>
  api.delete(`/personal-assets/${securityId}/income-entries/${entryId}`).then(r => r.data)

export default api
