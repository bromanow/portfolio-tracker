import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Loader2, CheckCircle, Check } from 'lucide-react'
import { getExpiredOptions, closeExpiredOptions, type ExpiredOption } from '../../api/client'

// ─── Expired Options Tab ──────────────────────────────────────────────────────
export default function ExpiredOptionsTab() {
  const qc = useQueryClient()
  const { data, isLoading, refetch } = useQuery({ queryKey: ['expired-options'], queryFn: getExpiredOptions })
  const items = (data?.items ?? []).filter(o => !o.already_recorded)
  const [sel, setSel] = useState<Set<string>>(new Set())
  const [msg, setMsg] = useState<string | null>(null)

  const keyOf = (o: ExpiredOption) => `${o.security_id}:${o.account_id}`
  const allSelected = items.length > 0 && items.every(o => sel.has(keyOf(o)))
  const toggle = (k: string) => setSel(s => { const n = new Set(s); n.has(k) ? n.delete(k) : n.add(k); return n })
  const toggleAll = () => setSel(allSelected ? new Set() : new Set(items.map(keyOf)))

  const closeMut = useMutation({
    mutationFn: (body: { keys?: number[][]; all?: boolean }) => closeExpiredOptions(body),
    onSuccess: (r) => {
      setMsg(`Closed ${r.closed} option${r.closed === 1 ? '' : 's'}${r.skipped ? `, skipped ${r.skipped} already recorded` : ''}.`)
      setSel(new Set())
      refetch()
      qc.invalidateQueries({ queryKey: ['data-health'] })
      qc.invalidateQueries({ queryKey: ['perf-timeline'] })
      qc.invalidateQueries({ queryKey: ['positions'] })
    },
    onError: () => setMsg('Close failed.'),
  })

  const fmt = (v: string) => `${Number(v) >= 0 ? '+' : ''}$${Number(v).toLocaleString(undefined, { maximumFractionDigits: 0 })}`
  const selectedKeys = items.filter(o => sel.has(keyOf(o))).map(o => [o.security_id, o.account_id])

  return (
    <div className="space-y-4 max-w-4xl">
      <div>
        <h2 className="text-lg font-semibold text-foreground">Expired Options</h2>
        <p className="text-sm text-muted-foreground mt-1">
          Options past their expiry that were never closed (worthless options that dropped off statements).
          Closing records the missing expiry — realizing the short premium as a gain, or the long cost as a
          loss — so historical P&amp;L and returns are correct. Review each, then close the ones you select.
        </p>
      </div>

      {isLoading ? (
        <div className="flex items-center gap-2 text-muted-foreground text-sm py-6"><Loader2 className="h-4 w-4 animate-spin" /> Loading…</div>
      ) : items.length === 0 ? (
        <div className="bg-card border border-border rounded-xl px-4 py-3 flex items-center gap-3">
          <CheckCircle className="h-5 w-5 text-emerald-500" /> <span className="text-sm text-muted-foreground">No unclosed expired options.</span>
        </div>
      ) : (
        <>
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <span className="text-sm text-muted-foreground">{items.length} unclosed · {sel.size} selected</span>
            <div className="flex items-center gap-2">
              <button
                onClick={() => closeMut.mutate({ keys: selectedKeys })}
                disabled={sel.size === 0 || closeMut.isPending}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-primary text-white text-sm font-medium hover:bg-primary/90 disabled:opacity-50"
              >
                {closeMut.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
                Close selected ({sel.size})
              </button>
              <button
                onClick={() => { if (confirm(`Close all ${items.length} expired options?`)) closeMut.mutate({ all: true }) }}
                disabled={closeMut.isPending}
                className="px-3 py-1.5 rounded-lg border border-border text-foreground text-sm font-medium hover:bg-muted/50 disabled:opacity-50"
              >
                Close all
              </button>
            </div>
          </div>
          {msg && <p className="text-xs text-foreground bg-muted/50 border border-border rounded-lg px-3 py-2">{msg}</p>}
          <div className="bg-card border border-border rounded-xl overflow-hidden">
            <div className="max-h-[28rem] overflow-y-auto">
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-muted/50">
                  <tr className="text-left text-xs uppercase tracking-wide text-muted-foreground">
                    <th className="px-3 py-2 w-8"><input type="checkbox" checked={allSelected} onChange={toggleAll} className="bg-background text-foreground rounded" /></th>
                    <th className="px-3 py-2 font-medium">Option</th>
                    <th className="px-3 py-2 font-medium">Account</th>
                    <th className="px-3 py-2 font-medium">Expired</th>
                    <th className="px-3 py-2 font-medium text-right">Qty</th>
                    <th className="px-3 py-2 font-medium text-right">Realizes</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map(o => {
                    const k = keyOf(o)
                    return (
                      <tr key={k} className="border-t border-border hover:bg-muted/50 cursor-pointer" onClick={() => toggle(k)}>
                        <td className="px-3 py-2"><input type="checkbox" checked={sel.has(k)} onChange={() => toggle(k)} onClick={e => e.stopPropagation()} className="bg-background text-foreground rounded" /></td>
                        <td className="px-3 py-2 text-foreground whitespace-nowrap">{o.ticker} {o.is_short ? <span className="text-[10px] text-red-500 dark:text-red-400">SHORT</span> : <span className="text-[10px] text-primary/70">LONG</span>}</td>
                        <td className="px-3 py-2 text-muted-foreground whitespace-nowrap">{o.account ?? '—'}</td>
                        <td className="px-3 py-2 text-muted-foreground whitespace-nowrap">{o.expiry} <span className="text-muted-foreground">({o.days_past}d)</span></td>
                        <td className="px-3 py-2 text-right text-muted-foreground">{Number(o.quantity)}</td>
                        <td className={`px-3 py-2 text-right font-medium ${Number(o.est_realized_cad) >= 0 ? 'text-emerald-600 dark:text-emerald-400' : 'text-red-500 dark:text-red-400'}`}>{fmt(o.est_realized_cad)}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  )
}
