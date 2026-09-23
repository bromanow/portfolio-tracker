import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Loader2, CheckCircle, Check } from 'lucide-react'
import { getReinvestRetypePreview, applyReinvestRetype, revertReinvestRetype } from '../../api/client'

// ─── Fix Reinvestment Types Tab ────────────────────────────────────────────────
export default function ReinvestRetypeTab() {
  const qc = useQueryClient()
  const { data, isLoading, refetch } = useQuery({ queryKey: ['reinvest-retype-preview'], queryFn: getReinvestRetypePreview })
  const [msg, setMsg] = useState<string | null>(null)

  const applyMut = useMutation({
    mutationFn: applyReinvestRetype,
    onSuccess: (r) => {
      setMsg(`Retyped ${r.retyped} → DRIP (${r.retyped_from_other} from OTHER, ${r.retyped_from_dividend} from DIVIDEND) and backfilled cost on ${r.cost_backfilled} from their disclosed book value, and recomputed snapshots.`)
      refetch(); qc.invalidateQueries()
    },
    onError: () => setMsg('Apply failed.'),
  })
  const revertMut = useMutation({
    mutationFn: revertReinvestRetype,
    onSuccess: (r) => { setMsg(`Reverted ${r.count} transactions (${r.from_other} back to OTHER, ${r.from_dividend} back to DIVIDEND).`); refetch(); qc.invalidateQueries() },
    onError: () => setMsg('Revert failed.'),
  })
  const busy = applyMut.isPending || revertMut.isPending

  return (
    <div className="space-y-4 max-w-3xl">
      <div>
        <h2 className="text-lg font-semibold text-foreground">Fix Reinvestment Types</h2>
        <p className="text-sm text-muted-foreground mt-1">
          Some brokerage reinvestments (e.g. Scotia Wealth private pools like "SHORT-MID GOVT BD POOL SR K") land as{' '}
          <code className="text-xs bg-accent px-1 rounded">OTHER</code> (an unrecognized activity code) or{' '}
          <code className="text-xs bg-accent px-1 rounded">DIVIDEND</code> (mapped as a plain cash dividend) even
          though the description clearly says "REINVEST ... PLUS FRACTIONS OF ...". Neither type adds quantity in the
          ACB engine, so these silently contribute zero — a real position can quietly disappear from Holdings or go
          negative. Retyping to <code className="text-xs bg-accent px-1 rounded">DRIP</code> fixes the quantity;
          backfilling cost from the broker's own disclosed "BOOK VALUE $x.xx" (OTHER-sourced rows only — DIVIDEND rows
          already have a correct amount) fixes the cost. Reversible via the note markers it writes — each row reverts
          to its own original type.
        </p>
      </div>

      {isLoading ? (
        <div className="flex items-center gap-2 text-muted-foreground text-sm py-6"><Loader2 className="h-4 w-4 animate-spin" /> Scanning…</div>
      ) : !data ? null : data.total === 0 ? (
        <div className="bg-card border border-border rounded-xl px-4 py-3 flex items-center gap-3">
          <CheckCircle className="h-5 w-5 text-emerald-500" /> <span className="text-sm text-muted-foreground">No mis-typed reinvestment transactions found.</span>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
            <div className="bg-muted/50 rounded-lg p-3 col-span-2 sm:col-span-1"><div className="text-xs text-muted-foreground">Transactions to fix</div><div className="text-2xl font-semibold text-primary">{data.total}</div></div>
          </div>

          {data.by_account.length > 0 && (
            <div className="text-sm text-muted-foreground">
              By account: {data.by_account.map(a => `${a.account} (${a.brokerage}, from ${a.from_type}) — ${a.count}`).join(' · ')}
            </div>
          )}

          <div className="bg-card border border-border rounded-xl overflow-hidden">
            <div className="px-4 py-2 bg-muted/50 text-xs uppercase tracking-wide text-muted-foreground font-medium">Sample (most recent 15)</div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-xs text-muted-foreground">
                    <th className="px-3 py-1.5 text-left">Date</th>
                    <th className="px-3 py-1.5 text-left">Ticker</th>
                    <th className="px-3 py-1.5 text-left">From</th>
                    <th className="px-3 py-1.5 text-right">Fraction qty</th>
                    <th className="px-3 py-1.5 text-right">Current cost</th>
                    <th className="px-3 py-1.5 text-right">Book value</th>
                    <th className="px-3 py-1.5 text-left">Account</th>
                  </tr>
                </thead>
                <tbody>
                  {data.sample.map((s, i) => (
                    <tr key={i} className="border-t border-border">
                      <td className="px-3 py-1.5 text-muted-foreground whitespace-nowrap">{s.date}</td>
                      <td className="px-3 py-1.5 text-foreground whitespace-nowrap">{s.ticker}</td>
                      <td className="px-3 py-1.5 text-muted-foreground whitespace-nowrap">{s.from_type}</td>
                      <td className="px-3 py-1.5 text-muted-foreground text-right">{Number(s.quantity)}</td>
                      <td className="px-3 py-1.5 text-muted-foreground text-right">{s.cad_amount ?? '—'}</td>
                      <td className="px-3 py-1.5 text-primary font-medium text-right">{s.book_value ? `$${s.book_value}` : '—'}</td>
                      <td className="px-3 py-1.5 text-muted-foreground whitespace-nowrap">{s.account}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {msg && <p className="text-xs text-foreground bg-muted/50 border border-border rounded-lg px-3 py-2">{msg}</p>}
          <div className="flex items-center gap-2">
            <button
              onClick={() => { if (confirm(`Retype ${data.total} reinvestment transactions and recompute snapshots?`)) applyMut.mutate() }}
              disabled={busy}
              className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-primary text-white text-sm font-medium hover:bg-primary/90 disabled:opacity-50"
            >
              {applyMut.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
              Retype {data.total} & recompute
            </button>
            <button
              onClick={() => { if (confirm('Revert previously retyped reinvestment transactions?')) revertMut.mutate() }}
              disabled={busy}
              className="px-4 py-2 rounded-lg border border-border text-foreground text-sm font-medium hover:bg-muted/50 disabled:opacity-50"
            >
              Revert
            </button>
          </div>
        </>
      )}
    </div>
  )
}
