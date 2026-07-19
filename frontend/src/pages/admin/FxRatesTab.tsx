import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { getFxRates, refreshFxRates } from '../../api/client'
import type { FXRate } from '../../api/client'
import { useSortState, SortTh, sortRows } from './shared'

// ─── FX Rates Tab ─────────────────────────────────────────────────────────────
export default function FxRatesTab() {
  const qc = useQueryClient()
  const [limit, setLimit] = useState(50)
  const { data: rates = [], isLoading, refetch } = useQuery({
    queryKey: ['fx-rates', limit],
    queryFn: () => getFxRates(limit),
  })
  const refreshMut = useMutation({
    mutationFn: refreshFxRates,
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['fx-rates'] }); refetch() },
  })
  const { sort, toggle } = useSortState('rate_date', 'desc')

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-4">
        <button
          onClick={() => refreshMut.mutate()}
          disabled={refreshMut.isPending}
          className="bg-primary text-white text-sm px-4 py-2 rounded disabled:opacity-40 flex items-center gap-2"
        >
          {refreshMut.isPending && <span className="animate-spin rounded-full h-3.5 w-3.5 border-b-2 border-white" />}
          Refresh from Bank of Canada
        </button>
        {refreshMut.isSuccess && (
          <span className="text-sm text-green-600">
            Added {(refreshMut.data as { added?: number })?.added ?? 0} new rates
          </span>
        )}
        <select className="bg-background text-foreground border rounded px-3 py-1.5 text-sm ml-auto" value={limit}
          onChange={e => setLimit(Number(e.target.value))}>
          <option value={50}>50 rates</option>
          <option value={100}>100 rates</option>
          <option value={500}>500 rates</option>
        </select>
      </div>
      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="min-w-full text-sm divide-y divide-border">
          <thead className="bg-muted/50">
            <tr className="text-xs text-muted-foreground uppercase">
              <SortTh label="Date" col="rate_date" sort={sort} toggle={toggle} className="px-3 py-3 text-left" />
              <SortTh label="Pair" col="from_currency" sort={sort} toggle={toggle} className="px-3 py-3 text-left" />
              <SortTh label="Rate" col="rate" sort={sort} toggle={toggle} className="px-3 py-3 text-right" />
              <SortTh label="Source" col="source" sort={sort} toggle={toggle} className="px-3 py-3 text-left" />
            </tr>
          </thead>
          <tbody className="divide-y divide-border/60">
            {isLoading ? (
              <tr><td colSpan={4} className="px-3 py-8 text-center text-muted-foreground">Loading...</td></tr>
            ) : sortRows(rates as FXRate[], sort.col, sort.dir).map(r => (
              <tr key={r.id}>
                <td className="px-3 py-2.5">{r.rate_date}</td>
                <td className="px-3 py-2.5 font-mono text-xs">{r.from_currency}/{r.to_currency}</td>
                <td className="px-3 py-2.5 text-right font-mono">{parseFloat(r.rate).toFixed(6)}</td>
                <td className="px-3 py-2.5 text-xs text-muted-foreground">{r.source}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
