import { useState, useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { RefreshCw, TrendingUp, TrendingDown, Download, X } from 'lucide-react'
import { getAccounts, getCashStatement } from '../api/client'
import type { Account, CashStatementRow } from '../api/client'

const TYPE_LABELS: Record<string, string> = {
  CASH_OPENING:       'Opening Balance',
  BUY:                'Buy',
  SELL:               'Sell',
  DIVIDEND:           'Dividend',
  DRIP:               'DRIP',
  RETURN_OF_CAPITAL:  'Return of Capital',
  INTEREST:           'Interest',
  FEE:                'Fee',
  DEPOSIT:            'Deposit',
  WITHDRAWAL:         'Withdrawal',
  TRANSFER_IN:        'Transfer In',
  TRANSFER_OUT:       'Transfer Out',
  FX_CONVERSION:      'FX Conversion',
  FX_ADJUSTMENT:      'FX Adjustment',
  OPTION_BUY:         'Option Buy',
  OPTION_SELL:        'Option Sell',
  OPTION_EXPIRY:      'Option Expiry',
  OPTION_ASSIGNMENT:  'Option Assignment',
  OPTION_EXERCISE:    'Option Exercise',
  JOURNAL:            'Journal',
  ADJUSTMENT:         'Adjustment',
  OTHER:              'Other',
}

const TYPE_COLORS: Record<string, string> = {
  CASH_OPENING:       'bg-gray-100 text-gray-600',
  BUY:                'bg-blue-50 text-blue-700',
  OPTION_BUY:         'bg-blue-50 text-blue-700',
  SELL:               'bg-emerald-50 text-emerald-700',
  OPTION_SELL:        'bg-emerald-50 text-emerald-700',
  DIVIDEND:           'bg-purple-50 text-purple-700',
  DRIP:               'bg-purple-50 text-purple-700',
  INTEREST:           'bg-purple-50 text-purple-700',
  RETURN_OF_CAPITAL:  'bg-purple-50 text-purple-700',
  TRANSFER_IN:        'bg-teal-50 text-teal-700',
  TRANSFER_OUT:       'bg-orange-50 text-orange-700',
  DEPOSIT:            'bg-teal-50 text-teal-700',
  WITHDRAWAL:         'bg-orange-50 text-orange-700',
  FEE:                'bg-red-50 text-red-600',
  FX_CONVERSION:      'bg-yellow-50 text-yellow-700',
  FX_ADJUSTMENT:      'bg-yellow-50 text-yellow-700',
}

function fmt(val: string | number | null | undefined, decimals = 2) {
  const n = typeof val === 'number' ? val : parseFloat(val ?? '0')
  if (isNaN(n)) return '—'
  return Math.abs(n).toLocaleString('en-CA', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })
}

function BalanceCell({ value }: { value: string | null }) {
  const n = parseFloat(value ?? '0')
  const color = n < 0 ? 'text-red-600' : 'text-gray-900'
  return <span className={`font-mono font-medium ${color}`}>{fmt(value ?? '0')}</span>
}

function ImpactCells({ row }: { row: CashStatementRow }) {
  const n = parseFloat(row.impact)
  if (row.transaction_type === 'CASH_OPENING') {
    return (
      <>
        <td className="px-4 py-2.5 text-right text-gray-400 font-mono text-sm">—</td>
        <td className="px-4 py-2.5 text-right font-mono text-sm text-emerald-600">{fmt(row.impact)}</td>
      </>
    )
  }
  if (n < 0) {
    return (
      <>
        <td className="px-4 py-2.5 text-right font-mono text-sm text-red-600">{fmt(row.impact)}</td>
        <td className="px-4 py-2.5 text-right text-gray-400 font-mono text-sm">—</td>
      </>
    )
  }
  return (
    <>
      <td className="px-4 py-2.5 text-right text-gray-400 font-mono text-sm">—</td>
      <td className="px-4 py-2.5 text-right font-mono text-sm text-emerald-600">{fmt(row.impact)}</td>
    </>
  )
}

function exportCsv(statement: { account_name: string; currency: string; closing_balance: string; rows: CashStatementRow[] }) {
  const headers = ['Date', 'Settlement Date', 'Type', 'Ticker', 'Description', 'Debit', 'Credit', 'Balance', 'Currency']
  const escCsv = (v: string | null | undefined) => {
    const s = String(v ?? '')
    return s.includes(',') || s.includes('"') || s.includes('\n') ? `"${s.replace(/"/g, '""')}"` : s
  }
  const rows = statement.rows.map(r => {
    const n = parseFloat(r.impact)
    const debit  = n < 0 ? Math.abs(n).toFixed(2) : ''
    const credit = n > 0 ? n.toFixed(2) : ''
    return [
      r.date,
      r.settlement_date ?? '',
      TYPE_LABELS[r.transaction_type] ?? r.transaction_type,
      r.ticker ?? '',
      r.description ?? '',
      debit,
      credit,
      r.balance != null ? parseFloat(r.balance).toFixed(2) : '',
      r.currency ?? statement.currency,
    ].map(escCsv).join(',')
  })
  // Footer row
  const totalDebits  = statement.rows.filter(r => parseFloat(r.impact) < 0).reduce((s, r) => s + parseFloat(r.impact), 0)
  const totalCredits = statement.rows.filter(r => parseFloat(r.impact) > 0).reduce((s, r) => s + parseFloat(r.impact), 0)
  rows.push(['', '', 'Closing Balance', '', '', Math.abs(totalDebits).toFixed(2), totalCredits.toFixed(2), parseFloat(statement.closing_balance).toFixed(2), ''].map(escCsv).join(','))

  const csv = [headers.join(','), ...rows].join('\n')
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  const safeName = statement.account_name.replace(/[^a-z0-9]/gi, '_')
  link.download = `cash_statement_${safeName}_${new Date().toISOString().slice(0, 10)}.csv`
  link.click()
  URL.revokeObjectURL(url)
}

export default function CashStatement() {
  const [brokerageFilter, setBrokerageFilter] = useState('')
  const [accountId, setAccountId] = useState<number | null>(null)
  const [fromDate, setFromDate] = useState('')
  const [toDate, setToDate] = useState('')

  const { data: accounts = [] } = useQuery({ queryKey: ['accounts'], queryFn: getAccounts })

  // Unique brokerages for the filter dropdown
  const brokerages = useMemo(() => {
    const seen = new Set<string>()
    const out: string[] = []
    ;(accounts as Account[]).forEach(a => {
      if (!seen.has(a.brokerage_name)) { seen.add(a.brokerage_name); out.push(a.brokerage_name) }
    })
    return out
  }, [accounts])

  const filteredAccounts = useMemo(() =>
    (accounts as Account[]).filter(a => !brokerageFilter || a.brokerage_name === brokerageFilter),
    [accounts, brokerageFilter]
  )

  const params = useMemo(() => ({
    account_id:  accountId ?? undefined,
    from_date:   fromDate || undefined,
    to_date:     toDate   || undefined,
  }), [accountId, fromDate, toDate])

  const { data: statement, isLoading, refetch } = useQuery({
    queryKey: ['cash-statement', params],
    queryFn: () => getCashStatement(params),
    enabled: accountId !== null,
  })

  const closingBalance = statement ? parseFloat(statement.closing_balance) : null

  const clearDates = () => { setFromDate(''); setToDate('') }
  const hasDates = fromDate || toDate

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-gray-900">Cash Statement</h1>

      {/* Controls */}
      <div className="flex flex-wrap items-end gap-3">
        {/* Brokerage filter */}
        <div className="space-y-1">
          <label className="block text-xs font-medium text-gray-600">Brokerage</label>
          <select
            value={brokerageFilter}
            onChange={e => { setBrokerageFilter(e.target.value); setAccountId(null) }}
            className="border border-gray-300 rounded-lg px-3 py-2 text-sm min-w-44 focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            <option value="">All Brokerages</option>
            {brokerages.map(b => <option key={b} value={b}>{b}</option>)}
          </select>
        </div>

        {/* Account selector */}
        <div className="space-y-1">
          <label className="block text-xs font-medium text-gray-600">Account(s)</label>
          <select
            value={accountId ?? ''}
            onChange={e => setAccountId(e.target.value ? Number(e.target.value) : null)}
            className="border border-gray-300 rounded-lg px-3 py-2 text-sm min-w-56 focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            <option value="">— Select account —</option>
            {filteredAccounts.map(a => (
              <option key={a.id} value={a.id}>{a.name}</option>
            ))}
          </select>
        </div>

        {/* Date range */}
        <div className="space-y-1">
          <label className="block text-xs font-medium text-gray-600">From</label>
          <input
            type="date"
            value={fromDate}
            onChange={e => setFromDate(e.target.value)}
            className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>
        <div className="space-y-1">
          <label className="block text-xs font-medium text-gray-600">To</label>
          <input
            type="date"
            value={toDate}
            onChange={e => setToDate(e.target.value)}
            className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>

        {hasDates && (
          <button
            onClick={clearDates}
            className="flex items-center gap-1.5 px-3 py-2 rounded-lg border border-gray-300 text-sm text-gray-500 hover:bg-gray-50 transition-colors"
          >
            <X className="h-4 w-4" /> Clear dates
          </button>
        )}

        {accountId && (
          <button
            onClick={() => refetch()}
            disabled={isLoading}
            className="flex items-center gap-1.5 px-3 py-2 rounded-lg border border-gray-300 text-sm text-gray-600 hover:bg-gray-50 disabled:opacity-50 transition-colors"
          >
            <RefreshCw className={`h-4 w-4 ${isLoading ? 'animate-spin' : ''}`} />
            Refresh
          </button>
        )}

        {statement && statement.rows.length > 0 && (
          <button
            onClick={() => exportCsv(statement)}
            className="flex items-center gap-1.5 px-3 py-2 rounded-lg border border-gray-300 text-sm text-gray-600 hover:bg-gray-50 transition-colors ml-auto"
          >
            <Download className="h-4 w-4" />
            Export CSV
          </button>
        )}
      </div>

      {/* Summary cards */}
      {statement && (
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
          <div className="bg-white border border-gray-200 rounded-xl p-4">
            <p className="text-xs text-gray-500 mb-1">Closing Balance</p>
            <p className={`text-xl font-bold font-mono ${closingBalance !== null && closingBalance < 0 ? 'text-red-600' : 'text-gray-900'}`}>
              {closingBalance !== null ? (
                <>
                  {closingBalance < 0 ? '−' : ''}{Math.abs(closingBalance).toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </>
              ) : '—'}
            </p>
            <p className="text-xs text-gray-400 mt-0.5">{statement.currency}</p>
          </div>
          <div className="bg-white border border-gray-200 rounded-xl p-4">
            <p className="text-xs text-gray-500 mb-1">Total Credits</p>
            <p className="text-xl font-bold font-mono text-emerald-600">
              {statement.rows
                .filter(r => parseFloat(r.impact) > 0)
                .reduce((s, r) => s + parseFloat(r.impact), 0)
                .toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            </p>
          </div>
          <div className="bg-white border border-gray-200 rounded-xl p-4">
            <p className="text-xs text-gray-500 mb-1">Total Debits</p>
            <p className="text-xl font-bold font-mono text-red-600">
              {Math.abs(statement.rows
                .filter(r => parseFloat(r.impact) < 0)
                .reduce((s, r) => s + parseFloat(r.impact), 0))
                .toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            </p>
          </div>
        </div>
      )}

      {/* Statement table */}
      {!accountId && (
        <div className="text-center py-20 text-gray-400">Select an account to view its cash statement.</div>
      )}
      {accountId && isLoading && (
        <div className="text-center py-20 text-gray-400">Loading…</div>
      )}
      {statement && statement.rows.length === 0 && (
        <div className="text-center py-20 text-gray-400">No cash transactions found for this account and date range.</div>
      )}

      {statement && statement.rows.length > 0 && (
        <div className="bg-white border border-gray-200 rounded-xl overflow-x-auto">
          <table className="w-full text-sm min-w-[640px]">
            <thead>
              <tr className="border-b border-gray-200 bg-gray-50 text-xs font-semibold text-gray-500 uppercase tracking-wide">
                <th className="px-4 py-3 text-left">Date</th>
                <th className="px-4 py-3 text-left">Type</th>
                <th className="px-4 py-3 text-left">Description</th>
                <th className="px-4 py-3 text-right">Debit</th>
                <th className="px-4 py-3 text-right">Credit</th>
                <th className="px-4 py-3 text-right">Balance</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {statement.rows.map((row) => {
                const isOpening = row.transaction_type === 'CASH_OPENING'
                const label = TYPE_LABELS[row.transaction_type] ?? row.transaction_type
                const badgeColor = TYPE_COLORS[row.transaction_type] ?? 'bg-gray-100 text-gray-600'
                return (
                  <tr
                    key={row.id}
                    className={`hover:bg-gray-50 transition-colors ${isOpening ? 'bg-gray-50/60' : ''}`}
                  >
                    <td className="px-4 py-2.5 whitespace-nowrap">
                      <span className="text-gray-800 font-medium">{row.date}</span>
                      {row.settlement_date && row.settlement_date !== row.date && (
                        <span className="block text-xs text-gray-400">Settles {row.settlement_date}</span>
                      )}
                    </td>
                    <td className="px-4 py-2.5 whitespace-nowrap">
                      <span className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${badgeColor}`}>
                        {label}
                      </span>
                    </td>
                    <td className="px-4 py-2.5 text-gray-600 max-w-xs truncate">
                      {row.ticker && <span className="font-mono font-medium text-gray-800 mr-1.5">{row.ticker}</span>}
                      {row.description}
                    </td>
                    <ImpactCells row={row} />
                    <td className="px-4 py-2.5 text-right">
                      {row.balance != null ? <BalanceCell value={row.balance} /> : <span className="text-gray-400">—</span>}
                    </td>
                  </tr>
                )
              })}
            </tbody>
            <tfoot>
              <tr className="border-t-2 border-gray-300 bg-gray-50 font-semibold">
                <td colSpan={3} className="px-4 py-3 text-gray-700">Closing Balance</td>
                <td className="px-4 py-3 text-right font-mono text-sm text-red-600">
                  {(() => {
                    const total = statement.rows.filter(r => parseFloat(r.impact) < 0).reduce((s, r) => s + parseFloat(r.impact), 0)
                    return total !== 0 ? Math.abs(total).toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '—'
                  })()}
                </td>
                <td className="px-4 py-3 text-right font-mono text-sm text-emerald-600">
                  {(() => {
                    const total = statement.rows.filter(r => parseFloat(r.impact) > 0).reduce((s, r) => s + parseFloat(r.impact), 0)
                    return total !== 0 ? total.toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '—'
                  })()}
                </td>
                <td className="px-4 py-3 text-right">
                  <BalanceCell value={statement.closing_balance} />
                </td>
              </tr>
            </tfoot>
          </table>
        </div>
      )}
    </div>
  )
}
