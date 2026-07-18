import { useState, useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { X, RefreshCw, Download, FileText } from 'lucide-react'
import { getAccounts, getCashStatement } from '../../api/client'
import type { Account, CashStatementRow } from '../../api/client'
import MultiSelectDropdown from '../../components/MultiSelectDropdown'
import DatePicker from '../../components/DatePicker'
import TickerLink from '../../components/TickerLink'
import { getPref } from '../../hooks/usePreference'
import {
  fmtAmt, PaginationBar, ImpactCells, cashExportCsv, cashExportPdf, CASH_TYPE_LABELS,
} from './shared'

// ── Cash Statement ────────────────────────────────────────────────────────────

const CASH_TYPE_COLORS: Record<string, string> = {
  CASH_OPENING: 'bg-gray-100 text-gray-600',
  BUY: 'bg-blue-50 text-blue-700', OPTION_BUY: 'bg-blue-50 text-blue-700',
  SELL: 'bg-emerald-50 text-emerald-700', OPTION_SELL: 'bg-emerald-50 text-emerald-700',
  DIVIDEND: 'bg-purple-50 text-purple-700', DRIP: 'bg-purple-50 text-purple-700',
  INTEREST: 'bg-purple-50 text-purple-700', RETURN_OF_CAPITAL: 'bg-purple-50 text-purple-700',
  TRANSFER_IN: 'bg-teal-50 text-teal-700', DEPOSIT: 'bg-teal-50 text-teal-700',
  TRANSFER_OUT: 'bg-orange-50 text-orange-700', WITHDRAWAL: 'bg-orange-50 text-orange-700',
  FEE: 'bg-red-50 text-red-600',
  FX_CONVERSION: 'bg-yellow-50 text-yellow-700', FX_ADJUSTMENT: 'bg-yellow-50 text-yellow-700',
}

export default function CashStatementReport() {
  const [brokerageFilter,    setBrokerageFilter]    = useState('')
  const [selectedAccountIds, setSelectedAccountIds] = useState<string[]>([])
  const [fromDate, setFromDate] = useState('')
  const [toDate,   setToDate]   = useState('')
  const [page,     setPage]     = useState(1)
  const [pageSize, setPageSize] = useState(50)

  const { data: accounts = [] } = useQuery({ queryKey: ['accounts'], queryFn: () => getAccounts() })
  const accts = accounts as Account[]

  // Unique brokerages
  const brokerages = useMemo(
    () => [...new Set(accts.map(a => a.brokerage_name))].sort(),
    [accts],
  )

  // Accounts filtered by brokerage cascade
  const accountOptions = useMemo(
    () => accts
      .filter(a => !brokerageFilter || a.brokerage_name === brokerageFilter)
      .map(a => ({ value: String(a.id), label: a.name })),
    [accts, brokerageFilter],
  )

  // When brokerage filter changes, drop any selected accounts that no longer belong
  const handleBrokerageChange = (brok: string) => {
    setBrokerageFilter(brok)
    if (brok) {
      const validIds = new Set(accts.filter(a => a.brokerage_name === brok).map(a => String(a.id)))
      setSelectedAccountIds(prev => prev.filter(id => validIds.has(id)))
    }
    setPage(1)
  }

  const isSingle = selectedAccountIds.length === 1

  // Fall back to all user accounts when nothing explicitly selected
  const effectiveAccountIds = selectedAccountIds.length > 0
    ? selectedAccountIds
    : accts.map(a => String(a.id))

  const { data: statement, isLoading, refetch } = useQuery({
    queryKey: ['cash-statement', effectiveAccountIds, fromDate, toDate],
    queryFn: () => getCashStatement({
      account_ids: effectiveAccountIds.join(','),
      from_date: fromDate || undefined,
      to_date:   toDate   || undefined,
    }),
    enabled: effectiveAccountIds.length > 0,
  })

  const allRows: CashStatementRow[] = statement?.rows ?? []
  const totalPages = Math.max(1, Math.ceil(allRows.length / pageSize))
  const pagedRows  = allRows.slice((page - 1) * pageSize, page * pageSize)

  const closingBalance = statement ? parseFloat(statement.closing_balance) : null

  const totalCredits = allRows.filter(r => parseFloat(r.impact) > 0).reduce((s, r) => s + parseFloat(r.impact), 0)
  const totalDebits  = allRows.filter(r => parseFloat(r.impact) < 0).reduce((s, r) => s + parseFloat(r.impact), 0)

  return (
    <div className="space-y-6">
      {/* Parameters */}
      <div className="flex flex-wrap items-end gap-4">
        <div>
          <label className="block text-xs text-gray-500 mb-1">Brokerage</label>
          <select
            value={brokerageFilter}
            onChange={e => handleBrokerageChange(e.target.value)}
            className="border border-gray-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            <option value="">All brokerages</option>
            {brokerages.map(b => <option key={b} value={b}>{b}</option>)}
          </select>
        </div>

        <div>
          <label className="block text-xs text-gray-500 mb-1">Account(s)</label>
          <MultiSelectDropdown
            placeholder="— Select accounts —"
            options={accountOptions}
            selected={selectedAccountIds}
            onChange={ids => { setSelectedAccountIds(ids); setPage(1) }}
          />
        </div>

        <div>
          <label className="block text-xs text-gray-500 mb-1">From</label>
          <DatePicker value={fromDate || ''} onChange={v => { setFromDate(v); setPage(1) }}
            max={new Date().toISOString().slice(0, 10)} placeholder="From" highlight={!!fromDate} className="w-36" />
        </div>

        <div>
          <label className="block text-xs text-gray-500 mb-1">To</label>
          <DatePicker value={toDate || ''} onChange={v => { setToDate(v); setPage(1) }}
            max={new Date().toISOString().slice(0, 10)} placeholder="To" highlight={!!toDate} className="w-36" />
        </div>

        {(fromDate || toDate) && (
          <button
            onClick={() => { setFromDate(''); setToDate(''); setPage(1) }}
            className="self-end flex items-center gap-1 text-xs text-gray-400 hover:text-gray-600 pb-2"
          >
            <X className="h-3.5 w-3.5" /> Clear dates
          </button>
        )}

        <button
          onClick={() => refetch()}
          disabled={selectedAccountIds.length === 0 || isLoading}
          className="self-end flex items-center gap-1.5 px-3 py-2 rounded-lg border border-gray-300 text-sm text-gray-600 hover:bg-gray-50 disabled:opacity-50 transition-colors"
        >
          <RefreshCw className={`h-4 w-4 ${isLoading ? 'animate-spin' : ''}`} />
          Refresh
        </button>
      </div>

      {selectedAccountIds.length === 0 && (
        <div className="text-center py-20 text-gray-400">Select one or more accounts to view the cash statement.</div>
      )}

      {selectedAccountIds.length > 0 && isLoading && (
        <div className="text-center py-20 text-gray-400">Loading…</div>
      )}

      {statement && (
        <>
          {/* Summary cards */}
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-4">
            <div className="bg-white border border-gray-200 rounded-xl p-4">
              <p className="text-xs text-gray-500 mb-1">Closing Balance</p>
              <p className={`text-xl font-bold font-mono ${closingBalance !== null && closingBalance < 0 ? 'text-red-600' : 'text-gray-900'}`}>
                {closingBalance !== null
                  ? getPref('hideValues')
                    ? '••••••'
                    : <>{closingBalance < 0 ? '−' : ''}{Math.abs(closingBalance).toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</>
                  : '—'}
              </p>
              <p className="text-xs text-gray-400 mt-0.5">{statement.currency}</p>
            </div>
            <div className="bg-white border border-gray-200 rounded-xl p-4">
              <p className="text-xs text-gray-500 mb-1">Total Credits</p>
              <p className="text-xl font-bold font-mono text-emerald-600">
                {getPref('hideValues') ? '••••••' : totalCredits.toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
              </p>
            </div>
            <div className="bg-white border border-gray-200 rounded-xl p-4">
              <p className="text-xs text-gray-500 mb-1">Total Debits</p>
              <p className="text-xl font-bold font-mono text-red-600">
                {getPref('hideValues') ? '••••••' : Math.abs(totalDebits).toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
              </p>
            </div>
          </div>

          {allRows.length === 0
            ? <div className="text-center py-20 text-gray-400">No cash transactions found for the selected account(s).</div>
            : (
              <div className="space-y-2">
                {/* Top pagination */}
                <PaginationBar
                  page={page} totalPages={totalPages} pageSize={pageSize}
                  totalRows={allRows.length} setPage={setPage} setPageSize={n => { setPageSize(n); setPage(1) }}
                />

                <div className="bg-white border border-gray-200 rounded-xl overflow-x-auto">
                  <table className="w-full text-sm min-w-[640px]">
                    <thead>
                      <tr className="border-b border-gray-200 bg-gray-50 text-xs font-semibold text-gray-500 uppercase tracking-wide">
                        <th className="px-4 py-3 text-left">Date</th>
                        {!isSingle && <th className="px-4 py-3 text-left">Account</th>}
                        <th className="px-4 py-3 text-left">Type</th>
                        <th className="px-4 py-3 text-left">Description</th>
                        <th className="px-4 py-3 text-right">Debit</th>
                        <th className="px-4 py-3 text-right">Credit</th>
                        {isSingle && <th className="px-4 py-3 text-right">Balance</th>}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-50">
                      {pagedRows.map(row => {
                        const isOpening = row.transaction_type === 'CASH_OPENING'
                        const label = CASH_TYPE_LABELS[row.transaction_type] ?? row.transaction_type
                        const badgeColor = CASH_TYPE_COLORS[row.transaction_type] ?? 'bg-gray-100 text-gray-600'
                        const bal = parseFloat(row.balance ?? '0')
                        return (
                          <tr key={row.id} className={`hover:bg-gray-50 transition-colors ${isOpening ? 'bg-gray-50/60' : ''}`}>
                            <td className="px-4 py-2.5 whitespace-nowrap">
                              <span className="text-gray-800 font-medium">{row.date}</span>
                              {row.settlement_date && row.settlement_date !== row.date && (
                                <span className="block text-xs text-gray-400">Settles {row.settlement_date}</span>
                              )}
                            </td>
                            {!isSingle && (
                              <td className="px-4 py-2.5 text-xs text-gray-500 whitespace-nowrap max-w-[10rem] truncate" title={row.account_name ?? ''}>
                                {row.account_name}
                              </td>
                            )}
                            <td className="px-4 py-2.5 whitespace-nowrap">
                              <span className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${badgeColor}`}>{label}</span>
                            </td>
                            <td className="px-4 py-2.5 text-gray-600 max-w-xs truncate">
                              {row.ticker && <span className="mr-1.5"><TickerLink ticker={row.ticker} className="font-mono font-medium text-gray-800" /></span>}
                              {row.description}
                            </td>
                            <ImpactCells row={row} />
                            {isSingle && (
                              <td className="px-4 py-2.5 text-right">
                                <span className={`font-mono font-medium ${bal < 0 ? 'text-red-600' : 'text-gray-900'}`}>
                                  {fmtAmt(row.balance ?? '0')}
                                </span>
                              </td>
                            )}
                          </tr>
                        )
                      })}
                    </tbody>
                    <tfoot>
                      <tr className="border-t-2 border-gray-300 bg-gray-50 font-semibold">
                        <td colSpan={isSingle ? 3 : 4} className="px-4 py-3 text-gray-700">Closing Balance</td>
                        <td className="px-4 py-3 text-right font-mono text-sm text-red-600">
                          {totalDebits !== 0 ? (getPref('hideValues') ? '••••••' : Math.abs(totalDebits).toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })) : '—'}
                        </td>
                        <td className="px-4 py-3 text-right font-mono text-sm text-emerald-600">
                          {totalCredits !== 0 ? (getPref('hideValues') ? '••••••' : totalCredits.toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })) : '—'}
                        </td>
                        {isSingle && (
                          <td className="px-4 py-3 text-right">
                            <span className={`font-mono font-medium ${closingBalance !== null && closingBalance < 0 ? 'text-red-600' : 'text-gray-900'}`}>
                              {fmtAmt(statement.closing_balance)}
                            </span>
                          </td>
                        )}
                      </tr>
                    </tfoot>
                  </table>
                </div>

                {/* Bottom pagination */}
                <PaginationBar
                  page={page} totalPages={totalPages} pageSize={pageSize}
                  totalRows={allRows.length} setPage={setPage} setPageSize={n => { setPageSize(n); setPage(1) }}
                />

                {/* Export buttons */}
                <div className="flex items-center justify-end gap-2 pt-1">
                  <span className="text-xs text-gray-400">Export:</span>
                  <button
                    onClick={() => cashExportCsv(allRows, statement.account_name, statement.currency, statement.closing_balance)}
                    className="flex items-center gap-1.5 px-3 py-2 rounded-lg border border-gray-300 text-sm text-gray-600 hover:bg-gray-50 transition-colors"
                  >
                    <Download className="h-4 w-4" /> CSV
                  </button>
                  <button
                    onClick={() => cashExportPdf(allRows, statement.account_name, statement.currency, statement.closing_balance)}
                    className="flex items-center gap-1.5 px-3 py-2 rounded-lg border border-gray-300 text-sm text-gray-600 hover:bg-gray-50 transition-colors"
                  >
                    <FileText className="h-4 w-4" /> PDF
                  </button>
                </div>
              </div>
            )}
        </>
      )}
    </div>
  )
}
