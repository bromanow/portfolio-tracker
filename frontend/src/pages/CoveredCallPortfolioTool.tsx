import { useState, useEffect } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  proposeCoveredCallPortfolio, getProposeJob, adoptCoveredCallPortfolio,
  listCoveredCallPortfolios, getCoveredCallPortfolio, getAccounts,
  sellToOpen, rollCoveredCall, closeCoveredCall, getCoveredCallSummary,
  getUnmatchedTransactions, matchTransaction, getCoveredCallCalendar,
} from '../api/client'
import type { ProposeParams, ProposeResult, CoveredCallPick, Account, CoveredCallHolding, CoveredCallPortfolioDetail, CoveredCallCalendarEntry } from '../api/client'
import { ChevronDown, ChevronUp, ChevronLeft, ChevronRight, Loader2, Sparkles } from 'lucide-react'
import TickerLink from '../components/TickerLink'

// ─── Formatting helpers ───────────────────────────────────────────────────────

function fmt(n: number | null | undefined, d = 2): string {
  return n == null ? '—' : n.toFixed(d)
}
function fmtPct(n: number | null | undefined, d = 1): string {
  return n == null ? '—' : n.toFixed(d) + '%'
}
function fmtMoney(n: number | null | undefined, ccy?: string | null): string {
  if (n == null) return '—'
  const symbol = ccy === 'CAD' ? 'C$' : '$'
  return symbol + n.toFixed(2)
}

function RecommendationBadge({ rec }: { rec: string | null }) {
  if (!rec) return <span className="text-muted-foreground/50">—</span>
  const styles: Record<string, string> = {
    Best: 'bg-emerald-100 text-emerald-700 border border-emerald-200',
    Good: 'bg-primary/15 text-primary border border-primary/20',
    Fair: 'bg-amber-100 text-amber-700 border border-amber-200',
    Avoid: 'bg-red-100 text-red-600 dark:text-red-400 border border-red-200',
  }
  return (
    <span className={`inline-block px-1.5 py-0.5 rounded text-xs font-semibold ${styles[rec] ?? 'bg-accent text-muted-foreground border border-border'}`}>
      {rec}
    </span>
  )
}

function ScoreBadge({ score, why }: { score: number | null; why?: string | null }) {
  if (score == null) return <span className="text-muted-foreground/50">—</span>
  const color =
    score >= 20 ? 'bg-emerald-100 text-emerald-700' :
    score >= 12 ? 'bg-primary/15 text-primary' :
    score >= 6 ? 'bg-amber-100 text-amber-700' :
    'bg-accent text-muted-foreground'
  return (
    <span className={`inline-block px-1.5 py-0.5 rounded text-xs font-bold tabular-nums cursor-help ${color}`} title={why ?? undefined}>
      {score.toFixed(1)}
    </span>
  )
}

// ─── Target-parameter form ────────────────────────────────────────────────────

interface FormState {
  min_dte: number
  max_dte: number
  min_otm_pct: number
  max_otm_pct: number
  min_option_oi: number
  min_option_vol: number
  min_avg_stock_vol: number
  min_div_yield: number
  min_annual_yield_pct: number
  min_delta: number   // 0 = no floor
  max_delta: number   // 1 = no cap (delta can't exceed 1)
  min_iv_pct: number  // 0 = no floor
  num_ca: number
  num_us: number
}

const DEFAULT_FORM: FormState = {
  min_dte: 14, max_dte: 60, min_otm_pct: 0.5, max_otm_pct: 25,
  min_option_oi: 50, min_option_vol: 3, min_avg_stock_vol: 250_000,
  min_div_yield: 0, min_annual_yield_pct: 0,
  min_delta: 0, max_delta: 1, min_iv_pct: 0,
  num_ca: 5, num_us: 10,
}

function NumField({ label, value, onChange, step = 1, title }: {
  label: string; value: number; onChange: (v: number) => void; step?: number; title?: string
}) {
  return (
    <label className="flex flex-col gap-1" title={title}>
      <span className="text-xs text-muted-foreground">{label}</span>
      <input
        type="number" step={step} value={value}
        onChange={e => onChange(parseFloat(e.target.value) || 0)}
        className="bg-background border border-border rounded px-2 py-1.5 text-sm w-full focus:outline-none focus:border-primary/40"
      />
    </label>
  )
}

// ─── Job polling (react-query's refetchInterval callback form has proven
//     unreliable for this app in prior testing — a manual recursive setTimeout
//     is used instead, mirroring Header.tsx's price-refresh job poll) ────────

function useProposeJob() {
  const [jobId, setJobId] = useState<string | null>(null)
  const [job, setJob] = useState<{ status: string; result?: ProposeResult; error?: string; progress?: any } | undefined>()

  useEffect(() => {
    if (!jobId) { setJob(undefined); return }
    let cancelled = false
    let timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      let data
      try { data = await getProposeJob(jobId) } catch { if (!cancelled) timer = setTimeout(poll, 1500); return }
      if (cancelled) return
      setJob(data)
      if (data.status === 'running') timer = setTimeout(poll, 1500)
    }
    poll()
    return () => { cancelled = true; clearTimeout(timer) }
  }, [jobId])

  return { jobId, setJobId, job }
}

// ─── Main tool ────────────────────────────────────────────────────────────────

export default function CoveredCallPortfolioTool() {
  const qc = useQueryClient()
  const [form, setForm] = useState<FormState>(DEFAULT_FORM)
  const [extraTickers, setExtraTickers] = useState('')
  const { jobId, setJobId, job } = useProposeJob()
  const [selectedPicks, setSelectedPicks] = useState<Set<string>>(new Set())
  const [mode, setMode] = useState<'SIMULATED' | 'REAL'>('SIMULATED')
  const [accountId, setAccountId] = useState<number | ''>('')
  const [portfolioName, setPortfolioName] = useState('Covered Call Portfolio')
  const [adopting, setAdopting] = useState(false)
  const [expandedId, setExpandedId] = useState<number | null>(null)

  const { data: accounts } = useQuery({ queryKey: ['accounts'], queryFn: () => getAccounts() })
  const { data: portfolios, refetch: refetchPortfolios } = useQuery({
    queryKey: ['covered-call-portfolios'], queryFn: listCoveredCallPortfolios,
  })
  const { data: expanded } = useQuery({
    queryKey: ['covered-call-portfolio', expandedId],
    queryFn: () => getCoveredCallPortfolio(expandedId!),
    enabled: expandedId != null,
  })

  const result = job?.status === 'done' ? job.result : undefined
  const isBusy = job?.status === 'running'

  useEffect(() => {
    if (result) setSelectedPicks(new Set(result.picks.map(p => p.ticker)))
  }, [result])

  const runPropose = async () => {
    const params: ProposeParams = {
      ...form,
      extra_tickers: extraTickers.split(',').map(t => t.trim().toUpperCase()).filter(Boolean),
    }
    const r = await proposeCoveredCallPortfolio(params)
    setJobId(r.job_id)
  }

  const togglePick = (ticker: string) => {
    setSelectedPicks(prev => {
      const next = new Set(prev)
      if (next.has(ticker)) next.delete(ticker); else next.add(ticker)
      return next
    })
  }

  const adopt = async () => {
    if (!result) return
    const picks = result.picks.filter(p => selectedPicks.has(p.ticker))
    if (picks.length === 0) return
    if (mode === 'REAL' && !accountId) { alert('Pick an account for Real mode.'); return }
    setAdopting(true)
    try {
      await adoptCoveredCallPortfolio({
        name: portfolioName, mode, account_id: mode === 'REAL' ? Number(accountId) : undefined, picks,
      })
      await refetchPortfolios()
      setJobId(null)
    } finally {
      setAdopting(false)
    }
  }

  const caPicks = result?.picks.filter(p => p.currency === 'CAD') ?? []
  const usPicks = result?.picks.filter(p => p.currency !== 'CAD') ?? []

  return (
    <div className="space-y-6">
      {/* ── Target parameters ── */}
      <div className="bg-card border border-border rounded-xl p-5 space-y-4">
        <h3 className="text-sm font-semibold text-foreground">Target Parameters</h3>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <NumField label="Target CA names" value={form.num_ca} onChange={v => setForm(f => ({ ...f, num_ca: v }))} />
          <NumField label="Target US names" value={form.num_us} onChange={v => setForm(f => ({ ...f, num_us: v }))} />
          <NumField label="Min annualized yield %" value={form.min_annual_yield_pct} onChange={v => setForm(f => ({ ...f, min_annual_yield_pct: v }))} step={0.5}
            title="The 'target return' floor — annualized covered-call premium yield" />
          <NumField label="Min dividend yield %" value={form.min_div_yield} onChange={v => setForm(f => ({ ...f, min_div_yield: v }))} step={0.5} />
          <NumField label="Min DTE" value={form.min_dte} onChange={v => setForm(f => ({ ...f, min_dte: v }))} />
          <NumField label="Max DTE" value={form.max_dte} onChange={v => setForm(f => ({ ...f, max_dte: v }))} />
          <NumField label="Min OTM %" value={form.min_otm_pct} onChange={v => setForm(f => ({ ...f, min_otm_pct: v }))} step={0.5}
            title="Fallback strike-distance filter, only used when delta isn't available" />
          <NumField label="Max OTM %" value={form.max_otm_pct} onChange={v => setForm(f => ({ ...f, max_otm_pct: v }))} step={0.5}
            title="Fallback strike-distance filter, only used when delta isn't available" />
          <NumField label="Min delta" value={form.min_delta} onChange={v => setForm(f => ({ ...f, min_delta: v }))} step={0.05}
            title="Aggressiveness dial — 0.15-0.25 conservative, 0.35-0.50 aggressive. 0 = no floor." />
          <NumField label="Max delta" value={form.max_delta} onChange={v => setForm(f => ({ ...f, max_delta: v }))} step={0.05}
            title="Aggressiveness dial — higher delta = closer to the money, more premium, more assignment risk. 1 = no cap." />
          <NumField label="Min implied vol %" value={form.min_iv_pct} onChange={v => setForm(f => ({ ...f, min_iv_pct: v }))} step={5}
            title="Absolute IV floor — chase high-premium, high-vol names outright, regardless of IV/HV richness. 0 = no floor." />
          <NumField label="Min option open interest" value={form.min_option_oi} onChange={v => setForm(f => ({ ...f, min_option_oi: v }))} />
          <NumField label="Min option volume" value={form.min_option_vol} onChange={v => setForm(f => ({ ...f, min_option_vol: v }))} />
          <NumField label="Min avg stock volume" value={form.min_avg_stock_vol} onChange={v => setForm(f => ({ ...f, min_avg_stock_vol: v }))} step={10000} />
        </div>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-muted-foreground">Extra candidate tickers (comma-separated, optional — appended to the curated CA/US lists)</span>
          <input
            type="text" value={extraTickers} onChange={e => setExtraTickers(e.target.value)}
            placeholder="e.g. SHOP.TO, PLTR"
            className="bg-background border border-border rounded px-2 py-1.5 text-sm w-full focus:outline-none focus:border-primary/40"
          />
        </label>
        <button
          onClick={runPropose}
          disabled={isBusy}
          className="flex items-center gap-2 px-4 py-2 bg-primary text-white rounded-lg text-sm font-medium hover:bg-primary/90 disabled:opacity-50"
        >
          {isBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
          {isBusy ? `Scanning… ${job?.progress?.source ?? ''} ${job?.progress ? `${job.progress.done}/${job.progress.total}` : ''}` : 'Propose Portfolio'}
        </button>
        {job?.status === 'failed' && <p className="text-xs text-red-600 dark:text-red-400">{job.error}</p>}
      </div>

      {/* ── Proposal results ── */}
      {result && (
        <div className="bg-card border border-border rounded-xl p-5 space-y-5">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <h3 className="text-sm font-semibold text-foreground">
              Proposal — {result.ca_picks} CA + {result.us_picks} US picks
              {(result.shortfall.ca > 0 || result.shortfall.us > 0) && (
                <span className="ml-2 text-xs font-normal text-amber-600 dark:text-amber-400">
                  (short {result.shortfall.ca > 0 ? `${result.shortfall.ca} CA` : ''}{result.shortfall.ca > 0 && result.shortfall.us > 0 ? ', ' : ''}{result.shortfall.us > 0 ? `${result.shortfall.us} US` : ''} — loosen filters or add extra tickers)
                </span>
              )}
            </h3>
            <span className="text-xs text-muted-foreground">via {result.data_source}</span>
          </div>

          {[{ label: 'Canadian', picks: caPicks }, { label: 'US', picks: usPicks }].map(group => group.picks.length > 0 && (
            <div key={group.label} className="space-y-2">
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">{group.label}</p>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-xs text-muted-foreground border-b border-border">
                      <th className="text-left py-1.5 pr-2"></th>
                      <th className="text-left py-1.5 pr-2">Ticker</th>
                      <th className="text-right py-1.5 pr-2">Price</th>
                      <th className="text-right py-1.5 pr-2">Div Yield</th>
                      <th className="text-right py-1.5 pr-2">Strike</th>
                      <th className="text-right py-1.5 pr-2">Expiry</th>
                      <th className="text-right py-1.5 pr-2">DTE</th>
                      <th className="text-right py-1.5 pr-2">Premium</th>
                      <th className="text-right py-1.5 pr-2">Ann. Yield</th>
                      <th className="text-right py-1.5 pr-2">Score</th>
                      <th className="text-left py-1.5 pr-2">Rating</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border/60">
                    {group.picks.map(p => (
                      <tr key={p.ticker}>
                        <td className="py-1.5 pr-2">
                          <input type="checkbox" checked={selectedPicks.has(p.ticker)} onChange={() => togglePick(p.ticker)} />
                        </td>
                        <td className="py-1.5 pr-2"><TickerLink ticker={p.ticker} /></td>
                        <td className="py-1.5 pr-2 text-right tabular-nums">{fmtMoney(p.current_price, p.currency)}</td>
                        <td className="py-1.5 pr-2 text-right tabular-nums">{fmtPct(p.dividend_yield)}</td>
                        <td className="py-1.5 pr-2 text-right tabular-nums">{fmt(p.strike)}</td>
                        <td className="py-1.5 pr-2 text-right">{p.expiry_date}</td>
                        <td className="py-1.5 pr-2 text-right tabular-nums">{p.dte}d</td>
                        <td className="py-1.5 pr-2 text-right tabular-nums">{fmtMoney(p.mid, p.currency)}</td>
                        <td className="py-1.5 pr-2 text-right tabular-nums font-medium">{fmtPct(p.annual_yield_pct)}</td>
                        <td className="py-1.5 pr-2 text-right"><ScoreBadge score={p.score} why={p.why} /></td>
                        <td className="py-1.5 pr-2"><RecommendationBadge rec={p.recommendation} /></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ))}

          {/* ── Adopt ── */}
          <div className="border-t border-border pt-4 flex flex-wrap items-end gap-3">
            <label className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground">Portfolio name</span>
              <input type="text" value={portfolioName} onChange={e => setPortfolioName(e.target.value)}
                className="bg-background border border-border rounded px-2 py-1.5 text-sm focus:outline-none focus:border-primary/40" />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs text-muted-foreground">Mode</span>
              <select value={mode} onChange={e => setMode(e.target.value as 'SIMULATED' | 'REAL')}
                className="bg-background border border-border rounded px-2 py-1.5 text-sm focus:outline-none focus:border-primary/40">
                <option value="SIMULATED">Simulated (paper)</option>
                <option value="REAL">Real (I'll trade these myself)</option>
              </select>
            </label>
            {mode === 'REAL' && (
              <label className="flex flex-col gap-1">
                <span className="text-xs text-muted-foreground">Account</span>
                <select value={accountId} onChange={e => setAccountId(e.target.value ? Number(e.target.value) : '')}
                  className="bg-background border border-border rounded px-2 py-1.5 text-sm focus:outline-none focus:border-primary/40">
                  <option value="">Select account…</option>
                  {accounts?.map((a: Account) => <option key={a.id} value={a.id}>{a.name}</option>)}
                </select>
              </label>
            )}
            <button
              onClick={adopt}
              disabled={adopting || selectedPicks.size === 0}
              className="px-4 py-2 bg-primary text-white rounded-lg text-sm font-medium hover:bg-primary/90 disabled:opacity-50"
            >
              {adopting ? 'Adopting…' : `Adopt ${selectedPicks.size} pick${selectedPicks.size === 1 ? '' : 's'}`}
            </button>
          </div>
        </div>
      )}

      {/* ── Existing portfolios ── */}
      {portfolios && portfolios.length > 0 && (
        <div className="bg-card border border-border rounded-xl p-5 space-y-3">
          <h3 className="text-sm font-semibold text-foreground">Your Covered Call Portfolios</h3>
          <div className="divide-y divide-border/60">
            {portfolios.map(p => (
              <div key={p.id}>
                <button
                  onClick={() => setExpandedId(expandedId === p.id ? null : p.id)}
                  className="w-full flex items-center justify-between py-2.5 text-left hover:bg-muted/50 rounded px-2 -mx-2"
                >
                  <span className="text-sm">
                    <span className="font-medium text-foreground">{p.name}</span>
                    <span className="ml-2 text-xs px-1.5 py-0.5 rounded bg-accent text-muted-foreground">{p.mode}</span>
                    <span className="ml-2 text-xs text-muted-foreground">{p.holdings} holdings</span>
                  </span>
                  {expandedId === p.id ? <ChevronUp className="h-4 w-4 text-muted-foreground" /> : <ChevronDown className="h-4 w-4 text-muted-foreground" />}
                </button>
                {expandedId === p.id && expanded && (
                  <PortfolioDetail portfolio={expanded} />
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      <ExpiryCalendar />
    </div>
  )
}

// ─── Portfolio detail: summary, per-holding trade management, REAL-mode matching ──

function PortfolioDetail({ portfolio }: { portfolio: CoveredCallPortfolioDetail }) {
  const qc = useQueryClient()
  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['covered-call-portfolio', portfolio.id] })
    qc.invalidateQueries({ queryKey: ['covered-call-summary', portfolio.id] })
    qc.invalidateQueries({ queryKey: ['covered-call-unmatched', portfolio.id] })
  }

  const { data: summary } = useQuery({
    queryKey: ['covered-call-summary', portfolio.id],
    queryFn: () => getCoveredCallSummary(portfolio.id),
  })
  const { data: unmatched } = useQuery({
    queryKey: ['covered-call-unmatched', portfolio.id],
    queryFn: () => getUnmatchedTransactions(portfolio.id),
    enabled: portfolio.mode === 'REAL',
  })

  return (
    <div className="pb-4 pl-2 space-y-4">
      {summary && (
        <div className="flex flex-wrap gap-x-6 gap-y-1 text-xs text-muted-foreground bg-muted/40 rounded px-3 py-2">
          <span>Premium collected: <span className="font-semibold text-foreground">{fmtMoney(summary.total_premium_collected)}</span></span>
          {summary.annualized_yield_on_capital_pct != null && (
            <span>Annualized yield on capital: <span className="font-semibold text-foreground">{fmtPct(summary.annualized_yield_on_capital_pct)}</span></span>
          )}
          <span>Sold {summary.trade_counts.SELL_TO_OPEN ?? 0} · Rolled {summary.trade_counts.BUY_TO_CLOSE ?? 0} · Expired worthless {summary.trade_counts.EXPIRED_WORTHLESS ?? 0} · Assigned {summary.trade_counts.ASSIGNED ?? 0}</span>
        </div>
      )}

      <div className="space-y-2">
        {portfolio.holdings.map(h => (
          <HoldingRow key={h.id} portfolioId={portfolio.id} holding={h} onChanged={invalidate} />
        ))}
      </div>

      {portfolio.mode === 'REAL' && unmatched && unmatched.length > 0 && (
        <div className="border-t border-border pt-3 space-y-2">
          <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">
            Unmatched real transactions — link instead of re-entering by hand
          </p>
          {unmatched.map(u => (
            <div key={u.transaction_id} className="flex items-center justify-between text-xs bg-muted/30 rounded px-3 py-2">
              <span>
                <span className="font-medium text-foreground">{u.underlying}</span>{' '}
                {u.suggested_trade_type} ${fmt(u.strike)} exp {u.expiry_date} · {u.transaction_date} · {u.transaction_type}
              </span>
              <button
                onClick={async () => { await matchTransaction(portfolio.id, u.holding_id, u.transaction_id); invalidate() }}
                className="px-2 py-1 bg-primary text-white rounded text-xs font-medium hover:bg-primary/90"
              >
                Match
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function HoldingRow({ portfolioId, holding, onChanged }: {
  portfolioId: number; holding: CoveredCallHolding; onChanged: () => void
}) {
  const [action, setAction] = useState<'sell' | 'roll' | 'close' | null>(null)
  const [strike, setStrike] = useState('')
  const [expiry, setExpiry] = useState('')
  const [premium, setPremium] = useState('')
  const [closePremium, setClosePremium] = useState('')
  const [submitting, setSubmitting] = useState(false)

  const openLeg = holding.trades[0]?.trade_type === 'SELL_TO_OPEN' ? holding.trades[0] : null

  const reset = () => { setAction(null); setStrike(''); setExpiry(''); setPremium(''); setClosePremium('') }

  const submitSell = async () => {
    if (!strike || !expiry) return
    setSubmitting(true)
    try {
      await sellToOpen(portfolioId, holding.id, { strike: parseFloat(strike), expiry_date: expiry, premium_per_contract: premium ? parseFloat(premium) : undefined })
      onChanged(); reset()
    } finally { setSubmitting(false) }
  }
  const submitRoll = async () => {
    if (!strike || !expiry) return
    setSubmitting(true)
    try {
      await rollCoveredCall(portfolioId, holding.id, {
        new_strike: parseFloat(strike), new_expiry_date: expiry,
        new_premium_per_contract: premium ? parseFloat(premium) : undefined,
        close_premium_per_contract: closePremium ? parseFloat(closePremium) : undefined,
      })
      onChanged(); reset()
    } finally { setSubmitting(false) }
  }
  const submitClose = async (outcome: 'ASSIGNED' | 'EXPIRED_WORTHLESS') => {
    setSubmitting(true)
    try {
      await closeCoveredCall(portfolioId, holding.id, { outcome })
      onChanged(); reset()
    } finally { setSubmitting(false) }
  }

  return (
    <div className="text-sm border border-border/60 rounded-lg px-3 py-2 space-y-2">
      <div className="flex items-center justify-between">
        <span>
          <TickerLink ticker={holding.ticker ?? ''} />
          {holding.shares != null && <span className="ml-2 text-xs text-muted-foreground">{holding.shares} sh</span>}
          {holding.status === 'CLOSED' && <span className="ml-2 text-xs px-1.5 py-0.5 rounded bg-accent text-muted-foreground">Closed</span>}
        </span>
        {openLeg ? (
          <span className="text-xs text-muted-foreground tabular-nums">
            Short ${fmt(openLeg.strike)} exp {openLeg.expiry_date}
            {openLeg.premium_per_contract != null && ` @ ${fmtMoney(openLeg.premium_per_contract, holding.currency)}`}
          </span>
        ) : (
          <span className="text-xs text-muted-foreground">No open call</span>
        )}
      </div>

      {holding.status === 'ACTIVE' && (
        <div className="flex items-center gap-2">
          {!openLeg && action !== 'sell' && (
            <button onClick={() => setAction('sell')} className="px-2 py-1 text-xs rounded bg-primary/10 text-primary hover:bg-primary/20">Sell to open</button>
          )}
          {openLeg && action !== 'roll' && (
            <button onClick={() => setAction('roll')} className="px-2 py-1 text-xs rounded bg-primary/10 text-primary hover:bg-primary/20">Roll</button>
          )}
          {openLeg && action !== 'close' && (
            <button onClick={() => setAction('close')} className="px-2 py-1 text-xs rounded bg-accent text-muted-foreground hover:bg-accent/70">Close</button>
          )}
        </div>
      )}

      {action === 'sell' && (
        <div className="flex flex-wrap items-end gap-2 bg-muted/30 rounded p-2">
          <label className="flex flex-col gap-0.5"><span className="text-xs text-muted-foreground">Strike</span>
            <input type="number" value={strike} onChange={e => setStrike(e.target.value)} className="w-20 bg-background border border-border rounded px-1.5 py-1 text-xs" /></label>
          <label className="flex flex-col gap-0.5"><span className="text-xs text-muted-foreground">Expiry</span>
            <input type="date" value={expiry} onChange={e => setExpiry(e.target.value)} className="bg-background border border-border rounded px-1.5 py-1 text-xs" /></label>
          <label className="flex flex-col gap-0.5"><span className="text-xs text-muted-foreground">Premium/contract</span>
            <input type="number" value={premium} onChange={e => setPremium(e.target.value)} className="w-24 bg-background border border-border rounded px-1.5 py-1 text-xs" /></label>
          <button onClick={submitSell} disabled={submitting} className="px-2 py-1 bg-primary text-white rounded text-xs font-medium disabled:opacity-50">Confirm</button>
          <button onClick={reset} className="px-2 py-1 text-xs text-muted-foreground hover:text-foreground">Cancel</button>
        </div>
      )}

      {action === 'roll' && (
        <div className="flex flex-wrap items-end gap-2 bg-muted/30 rounded p-2">
          <label className="flex flex-col gap-0.5"><span className="text-xs text-muted-foreground">Buy-back cost/contract</span>
            <input type="number" value={closePremium} onChange={e => setClosePremium(e.target.value)} className="w-24 bg-background border border-border rounded px-1.5 py-1 text-xs" /></label>
          <label className="flex flex-col gap-0.5"><span className="text-xs text-muted-foreground">New strike</span>
            <input type="number" value={strike} onChange={e => setStrike(e.target.value)} className="w-20 bg-background border border-border rounded px-1.5 py-1 text-xs" /></label>
          <label className="flex flex-col gap-0.5"><span className="text-xs text-muted-foreground">New expiry</span>
            <input type="date" value={expiry} onChange={e => setExpiry(e.target.value)} className="bg-background border border-border rounded px-1.5 py-1 text-xs" /></label>
          <label className="flex flex-col gap-0.5"><span className="text-xs text-muted-foreground">New premium/contract</span>
            <input type="number" value={premium} onChange={e => setPremium(e.target.value)} className="w-24 bg-background border border-border rounded px-1.5 py-1 text-xs" /></label>
          <button onClick={submitRoll} disabled={submitting} className="px-2 py-1 bg-primary text-white rounded text-xs font-medium disabled:opacity-50">Confirm roll</button>
          <button onClick={reset} className="px-2 py-1 text-xs text-muted-foreground hover:text-foreground">Cancel</button>
        </div>
      )}

      {action === 'close' && (
        <div className="flex items-center gap-2 bg-muted/30 rounded p-2">
          <button onClick={() => submitClose('EXPIRED_WORTHLESS')} disabled={submitting} className="px-2 py-1 bg-emerald-600 text-white rounded text-xs font-medium disabled:opacity-50">Expired worthless</button>
          <button onClick={() => submitClose('ASSIGNED')} disabled={submitting} className="px-2 py-1 bg-amber-600 text-white rounded text-xs font-medium disabled:opacity-50">Assigned</button>
          <button onClick={reset} className="px-2 py-1 text-xs text-muted-foreground hover:text-foreground">Cancel</button>
        </div>
      )}
    </div>
  )
}

// ─── Expiry calendar ──────────────────────────────────────────────────────────
// Day-grid/month-nav math mirrors DatePicker.tsx (firstWd/daysIn/cells + shiftMonth) —
// no other full calendar-grid view exists yet in this app, so this is the reusable
// starting point rather than a from-scratch layout.

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']
const WD = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa']

function dteColor(dte: number): string {
  if (dte < 7) return 'bg-red-100 text-red-700'
  if (dte < 14) return 'bg-orange-100 text-orange-700'
  if (dte < 30) return 'bg-yellow-100 text-yellow-700 dark:text-yellow-400'
  return 'bg-green-100 text-green-600 dark:text-green-400'
}

function ExpiryCalendar() {
  const today = new Date()
  const [view, setView] = useState({ y: today.getFullYear(), m: today.getMonth() })
  const { data: entries } = useQuery({ queryKey: ['covered-call-calendar'], queryFn: getCoveredCallCalendar })

  const byDate = new Map<string, CoveredCallCalendarEntry[]>()
  for (const e of entries ?? []) {
    const list = byDate.get(e.expiry_date) ?? []
    list.push(e)
    byDate.set(e.expiry_date, list)
  }

  const firstWd = new Date(view.y, view.m, 1).getDay()
  const daysIn = new Date(view.y, view.m + 1, 0).getDate()
  const cells: (number | null)[] = [
    ...Array(firstWd).fill(null),
    ...Array.from({ length: daysIn }, (_, i) => i + 1),
  ]

  const shiftMonth = (delta: number) => {
    setView(v => {
      let m = v.m + delta, y = v.y
      if (m < 0) { m = 11; y-- }
      if (m > 11) { m = 0; y++ }
      return { y, m }
    })
  }

  const pad = (n: number) => String(n).padStart(2, '0')
  const dateKey = (d: number) => `${view.y}-${pad(view.m + 1)}-${pad(d)}`

  return (
    <div className="bg-card border border-border rounded-xl p-5 space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold text-foreground">Expiry Calendar</h3>
        <div className="flex items-center gap-2">
          <button onClick={() => shiftMonth(-1)} className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-accent">
            <ChevronLeft className="h-4 w-4" />
          </button>
          <span className="text-sm font-medium text-foreground w-32 text-center">{MONTHS[view.m]} {view.y}</span>
          <button onClick={() => shiftMonth(1)} className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-accent">
            <ChevronRight className="h-4 w-4" />
          </button>
        </div>
      </div>

      <div className="grid grid-cols-7 gap-1">
        {WD.map(w => <div key={w} className="text-xs text-muted-foreground font-medium text-center py-1">{w}</div>)}
        {cells.map((d, i) => {
          if (d === null) return <div key={i} />
          const key = dateKey(d)
          const dayEntries = byDate.get(key) ?? []
          const isToday = today.getFullYear() === view.y && today.getMonth() === view.m && today.getDate() === d
          return (
            <div key={i} className={`min-h-[4.5rem] rounded border p-1 space-y-0.5 ${isToday ? 'border-primary/50 bg-primary/5' : 'border-border/60'}`}>
              <div className={`text-xs ${isToday ? 'font-semibold text-primary' : 'text-muted-foreground'}`}>{d}</div>
              {dayEntries.map(e => (
                <div
                  key={`${e.holding_id}-${e.strike}`}
                  title={`${e.ticker} $${e.strike} × ${e.contracts} — ${e.portfolio_name}${e.itm ? ' — ITM, assignment risk' : ''}`}
                  className={`text-[10px] px-1 py-0.5 rounded truncate flex items-center gap-1 ${dteColor(e.dte)}`}
                >
                  <span className="font-medium truncate">{e.ticker}</span>
                  {e.itm && <span className="shrink-0">⚠</span>}
                </div>
              ))}
            </div>
          )
        })}
      </div>

      <div className="flex items-center gap-4 text-xs text-muted-foreground pt-1">
        <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-sm bg-green-100"></span> 30d+</span>
        <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-sm bg-yellow-100"></span> 14–29d</span>
        <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-sm bg-orange-100"></span> 7–13d</span>
        <span className="flex items-center gap-1"><span className="w-2.5 h-2.5 rounded-sm bg-red-100"></span> &lt;7d</span>
        <span className="flex items-center gap-1">⚠ ITM / assignment risk</span>
      </div>
    </div>
  )
}
