import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Loader2, CheckCircle, Check } from 'lucide-react'
import { getOptionRetypePreview, applyOptionRetype, revertOptionRetype } from '../../api/client'

// ─── Fix Option Types Tab ─────────────────────────────────────────────────────
export default function OptionRetypeTab() {
  const qc = useQueryClient()
  const { data, isLoading, refetch } = useQuery({ queryKey: ['option-retype-preview'], queryFn: getOptionRetypePreview })
  const [msg, setMsg] = useState<string | null>(null)

  const applyMut = useMutation({
    mutationFn: applyOptionRetype,
    onSuccess: (r) => {
      setMsg(`Retyped ${r.sell_retyped} SELL→OPTION_SELL and ${r.buy_retyped} BUY→OPTION_BUY, and recomputed snapshots.`)
      refetch(); qc.invalidateQueries()
    },
    onError: () => setMsg('Apply failed.'),
  })
  const revertMut = useMutation({
    mutationFn: revertOptionRetype,
    onSuccess: (r) => { setMsg(`Reverted ${r.sell + r.buy} transactions.`); refetch(); qc.invalidateQueries() },
    onError: () => setMsg('Revert failed.'),
  })
  const busy = applyMut.isPending || revertMut.isPending

  return (
    <div className="space-y-4 max-w-3xl">
      <div>
        <h2 className="text-lg font-semibold text-gray-900">Fix Option Types</h2>
        <p className="text-sm text-gray-500 mt-1">
          Many option trades were imported as plain stock <code className="text-xs bg-gray-100 px-1 rounded">SELL</code> /
          <code className="text-xs bg-gray-100 px-1 rounded">BUY</code> instead of
          <code className="text-xs bg-gray-100 px-1 rounded">OPTION_SELL</code> /
          <code className="text-xs bg-gray-100 px-1 rounded">OPTION_BUY</code>. The ACB engine only applies option
          logic (premium on a write, buy-to-close, closing a long) to the OPTION_* types — so those premiums were
          treated as stock trades, corrupting option P&amp;L and leaving phantom long positions. Retyping fixes it
          and recomputes. It's reversible via the note markers it writes.
        </p>
      </div>

      {isLoading ? (
        <div className="flex items-center gap-2 text-gray-400 text-sm py-6"><Loader2 className="h-4 w-4 animate-spin" /> Scanning…</div>
      ) : !data ? null : data.total === 0 ? (
        <div className="bg-white border border-gray-200 rounded-xl px-4 py-3 flex items-center gap-3">
          <CheckCircle className="h-5 w-5 text-emerald-500" /> <span className="text-sm text-gray-600">No mis-typed option transactions. All options use OPTION_* types.</span>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
            <div className="bg-gray-50 rounded-lg p-3"><div className="text-xs text-gray-500">SELL → OPTION_SELL</div><div className="text-2xl font-semibold text-gray-800">{data.sell}</div></div>
            <div className="bg-gray-50 rounded-lg p-3"><div className="text-xs text-gray-500">BUY → OPTION_BUY</div><div className="text-2xl font-semibold text-gray-800">{data.buy}</div></div>
            <div className="bg-gray-50 rounded-lg p-3 col-span-2 sm:col-span-1"><div className="text-xs text-gray-500">Total to retype</div><div className="text-2xl font-semibold text-blue-700">{data.total}</div></div>
          </div>

          {data.by_brokerage.length > 0 && (
            <div className="text-sm text-gray-600">
              By brokerage: {data.by_brokerage.map(b => `${b.brokerage} (${b.count})`).join(' · ')}
            </div>
          )}
          {data.other > 0 && (
            <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
              Note: {data.other} option transactions are typed <code className="bg-white px-1 rounded">OTHER</code> — not touched by this retype; review separately.
            </p>
          )}

          <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
            <div className="px-4 py-2 bg-gray-50 text-xs uppercase tracking-wide text-gray-400 font-medium">Sample (most recent 12)</div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <tbody>
                  {data.sample.map((s, i) => (
                    <tr key={i} className="border-t border-gray-50">
                      <td className="px-3 py-1.5 text-gray-500 whitespace-nowrap">{s.date}</td>
                      <td className="px-3 py-1.5"><span className="text-xs font-medium text-gray-700">{s.type}</span> → <span className="text-xs font-medium text-blue-600">OPTION_{s.type}</span></td>
                      <td className="px-3 py-1.5 text-gray-700 whitespace-nowrap">{s.ticker}</td>
                      <td className="px-3 py-1.5 text-gray-500 text-right">{Number(s.quantity)}</td>
                      <td className="px-3 py-1.5 text-gray-500 whitespace-nowrap">{s.account}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {msg && <p className="text-xs text-gray-700 bg-gray-50 border border-gray-200 rounded-lg px-3 py-2">{msg}</p>}
          <div className="flex items-center gap-2">
            <button
              onClick={() => { if (confirm(`Retype ${data.total} option transactions and recompute snapshots?`)) applyMut.mutate() }}
              disabled={busy}
              className="flex items-center gap-1.5 px-4 py-2 rounded-lg bg-blue-600 text-white text-sm font-medium hover:bg-blue-700 disabled:opacity-50"
            >
              {applyMut.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
              Retype {data.total} & recompute
            </button>
            <button
              onClick={() => { if (confirm('Revert previously retyped option transactions?')) revertMut.mutate() }}
              disabled={busy}
              className="px-4 py-2 rounded-lg border border-gray-300 text-gray-700 text-sm font-medium hover:bg-gray-50 disabled:opacity-50"
            >
              Revert
            </button>
          </div>
        </>
      )}
    </div>
  )
}
