import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import DatePicker from '../../components/DatePicker'
import { getAccounts, getAccountCurrencySummary, splitCurrencyTransactions } from '../../api/client'
import type { Account, CurrencySummary } from '../../api/client'

// ─── Currency Split Tab ───────────────────────────────────────────────────────
export default function CurrencySplitTab() {
  const qc = useQueryClient()
  const { data: rawAccounts = [] } = useQuery({ queryKey: ['accounts', 'admin'], queryFn: () => getAccounts(true) })
  const accounts = rawAccounts as Account[]

  const [sourceId, setSourceId] = useState<number | ''>('')
  const [targetId, setTargetId] = useState<number | ''>('')
  const [currency, setCurrency] = useState('USD')
  const [fromDate, setFromDate] = useState('')
  const [toDate, setToDate]     = useState('')
  const [confirmed, setConfirmed] = useState(false)
  const [result, setResult] = useState<{ moved: number; from_account: string; to_account: string; from_date?: string; to_date?: string } | null>(null)
  const [error, setError] = useState<string | null>(null)

  const { data: summary, isLoading: summaryLoading } = useQuery<CurrencySummary>({
    queryKey: ['currency-summary', sourceId],
    queryFn: () => getAccountCurrencySummary(sourceId as number),
    enabled: !!sourceId,
  })

  const splitMut = useMutation({
    mutationFn: () => splitCurrencyTransactions(sourceId as number, targetId as number, currency, fromDate || undefined, toDate || undefined),
    onSuccess: (data) => {
      setResult(data)
      setConfirmed(false)
      qc.invalidateQueries({ queryKey: ['transactions'] })
      qc.invalidateQueries({ queryKey: ['positions'] })
      qc.invalidateQueries({ queryKey: ['currency-summary'] })
    },
    onError: (e: { response?: { data?: { detail?: string } }; message?: string }) => {
      setError(e?.response?.data?.detail || e?.message || 'Migration failed')
    },
  })

  const foreignCurrencies = summary?.by_currency.filter(r => r.currency !== summary.base_currency) ?? []
  const previewRow = summary?.by_currency.find(r => r.currency === currency)
  const canRun = !!sourceId && !!targetId && !!currency && sourceId !== targetId

  return (
    <div className="space-y-6 max-w-2xl">
      <div>
        <h2 className="text-lg font-semibold text-foreground">Currency Sub-Account Split</h2>
        <p className="text-sm text-muted-foreground mt-1">
          Brokerages like iTrade and Scotia Wealth maintain separate CAD and USD ledgers.
          Use this tool to move all transactions of a given currency from one account record
          into a dedicated sub-account you've already created.
        </p>
      </div>

      <div className="bg-amber-50 border border-amber-200 rounded-lg px-4 py-3 text-sm text-amber-800">
        <strong>Before running:</strong> Create the target USD account in the Accounts tab first
        (set its base_currency to USD). This tool will move transactions — it cannot be undone
        without re-importing.
      </div>

      <div className="bg-card border border-border rounded-xl p-5 space-y-4">
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-xs font-medium text-muted-foreground mb-1">Source account (mixed CAD+USD)</label>
            <select
              className="bg-background text-foreground w-full border border-border rounded-lg px-3 py-2 text-sm"
              value={sourceId}
              onChange={e => { setSourceId(e.target.value ? Number(e.target.value) : ''); setResult(null); setError(null) }}
            >
              <option value="">— select —</option>
              {accounts.map(a => <option key={a.id} value={a.id}>{a.name} ({a.base_currency})</option>)}
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-muted-foreground mb-1">Target account (USD sub-account)</label>
            <select
              className="bg-background text-foreground w-full border border-border rounded-lg px-3 py-2 text-sm"
              value={targetId}
              onChange={e => { setTargetId(e.target.value ? Number(e.target.value) : ''); setResult(null); setError(null) }}
            >
              <option value="">— select —</option>
              {accounts.filter(a => a.id !== sourceId).map(a => <option key={a.id} value={a.id}>{a.name} ({a.base_currency})</option>)}
            </select>
          </div>
        </div>

        <div className="flex items-end gap-3 flex-wrap">
          <div>
            <label className="block text-xs font-medium text-muted-foreground mb-1">Currency to move</label>
            <input
              className="bg-background text-foreground border border-border rounded-lg px-3 py-2 text-sm w-28 font-mono uppercase"
              value={currency}
              onChange={e => { setCurrency(e.target.value.toUpperCase()); setResult(null); setError(null) }}
              placeholder="USD"
              maxLength={3}
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-muted-foreground mb-1">From date <span className="text-muted-foreground font-normal">(optional)</span></label>
            <DatePicker className="w-36" max={new Date().toISOString().slice(0, 10)}
              value={fromDate || ''} placeholder="From"
              onChange={v => { setFromDate(v); setResult(null); setError(null) }} />
          </div>
          <div>
            <label className="block text-xs font-medium text-muted-foreground mb-1">To date <span className="text-muted-foreground font-normal">(optional)</span></label>
            <DatePicker className="w-36" max={new Date().toISOString().slice(0, 10)}
              value={toDate || ''} placeholder="To"
              onChange={v => { setToDate(v); setResult(null); setError(null) }}
            />
          </div>
        </div>

        {/* Preview */}
        {summaryLoading && <p className="text-sm text-muted-foreground">Loading summary…</p>}
        {summary && (
          <div className="rounded-lg border border-border overflow-hidden">
            <div className="px-4 py-2 bg-muted/50 border-b border-border text-xs font-semibold text-muted-foreground uppercase tracking-wide">
              Transaction breakdown for {summary.account_name}
            </div>
            <table className="w-full text-sm">
              <thead>
                <tr className="text-xs text-muted-foreground border-b border-border">
                  <th className="px-4 py-2 text-left">Currency</th>
                  <th className="px-4 py-2 text-right">Count</th>
                  <th className="px-4 py-2 text-right">Earliest</th>
                  <th className="px-4 py-2 text-right">Latest</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/60">
                {summary.by_currency.map(r => (
                  <tr key={r.currency} className={r.currency === currency ? 'bg-amber-50' : ''}>
                    <td className="px-4 py-2 font-mono font-medium">{r.currency}</td>
                    <td className="px-4 py-2 text-right">{r.count}</td>
                    <td className="px-4 py-2 text-right text-muted-foreground">{r.earliest ?? '—'}</td>
                    <td className="px-4 py-2 text-right text-muted-foreground">{r.latest ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {foreignCurrencies.length === 0 && (
              <p className="px-4 py-3 text-sm text-muted-foreground">No foreign-currency transactions found — this account may already be single-currency.</p>
            )}
          </div>
        )}

        {previewRow && (
          <div className="rounded-lg bg-primary/10 border border-primary/20 px-4 py-3 text-sm text-primary">
            {fromDate || toDate ? (
              <>This will move <strong>{currency} transactions</strong> dated{' '}
              {fromDate && <><strong>{fromDate}</strong> and after</>}
              {fromDate && toDate && ' through '}
              {toDate && <><strong>{toDate}</strong></>}{' '}
              to the target account.{' '}</>
            ) : (
              <>This will move <strong>all {previewRow.count} {currency} transactions</strong> ({previewRow.earliest} → {previewRow.latest}) to the target account.{' '}</>
            )}
            FX conversion rows for {currency} will move with them; the CAD legs stay in the source account.
          </div>
        )}

        {error && <p className="text-sm text-red-600 dark:text-red-400">{error}</p>}
        {result && (
          <div className="rounded-lg bg-emerald-50 border border-emerald-200 px-4 py-3 text-sm text-emerald-800">
            ✓ Moved <strong>{result.moved}</strong> {currency} transactions from <em>{result.from_account}</em> to <em>{result.to_account}</em>
            {(result.from_date || result.to_date) && (
              <span className="text-emerald-600 dark:text-emerald-400">
                {' '}({result.from_date ?? '…'} → {result.to_date ?? 'now'})
              </span>
            )}.
          </div>
        )}

        <div className="flex items-center gap-3">
          {!confirmed ? (
            <button
              disabled={!canRun || !previewRow}
              onClick={() => setConfirmed(true)}
              className="px-4 py-2 bg-amber-600 text-white rounded-lg text-sm font-medium hover:bg-amber-700 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              Preview → Confirm
            </button>
          ) : (
            <>
              <span className="text-sm text-muted-foreground">Move {previewRow?.count} transactions?</span>
              <button
                onClick={() => splitMut.mutate()}
                disabled={splitMut.isPending}
                className="px-4 py-2 bg-red-600 text-white rounded-lg text-sm font-medium hover:bg-red-700 disabled:opacity-50"
              >
                {splitMut.isPending ? 'Moving…' : 'Yes, move them'}
              </button>
              <button onClick={() => setConfirmed(false)} className="text-sm text-muted-foreground hover:text-foreground">Cancel</button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
