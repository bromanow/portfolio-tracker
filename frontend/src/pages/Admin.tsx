import { useState, useMemo, useEffect, useRef } from 'react'
import { useAuth } from '../context/AuthContext'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Trash2, AlertTriangle, X, Edit2, Check, ChevronUp, ChevronDown, ChevronsUpDown, RefreshCw, Sparkles, Plus, Pencil, Search, Power, RotateCcw, CheckCircle, WifiOff, Loader2, Database, Zap, KeyRound, UserPlus, ShieldCheck, ShieldOff, Eye, EyeOff } from 'lucide-react'
import {
  getAccounts, createAccount, updateAccount, deleteAccount, forceDeleteAccount,
  getSecurities, createSecurity, updateSecurity, deleteSecurity, deleteUnusedSecurities,
  fetchSecurityYahooInfo, searchYahooSecurities,
  getBrokerages, createBrokerage, updateBrokerage, deleteBrokerage,
  getTypeMappings, createTypeMapping, updateTypeMapping, deleteTypeMapping,
  getFxRates, refreshFxRates,
  getOpeningBalances, createOpeningBalance, updateOpeningBalance, deleteOpeningBalance,
  deleteAllTransactions, deleteAllImports,
  getPrices, refreshAllPrices, refreshOnePrice, deletePrice,
  getCashOpenings, createCashOpening, deleteCashOpening,
  getSystemHealth, restartBackend, getDbStats, optimizeDb,
  fetchPriceHistory, getPriceJob,
  getAccountCurrencySummary, splitCurrencyTransactions,
  changePassword,
  getClients, getUsers, createUser, updateUser, resetUserPassword,
  getMyFlexConfig, saveMyFlexConfig, deleteMyFlexConfig, syncMyFlexAccounts,
  getAllFlexConfigs, syncAllFlexAccounts,
} from '../api/client'
import type { Account, Security, TypeMapping, FXRate, OpeningBalance, MarketPrice, CashOpening, Brokerage, YahooSearchResult, DbStats, CurrencySummary, Client, AppUser, IBKRFlexConfig } from '../api/client'

type TabId = 'system' | 'accounts' | 'securities' | 'brokerages' | 'type-mappings' | 'fx-rates' | 'opening-balances' | 'currency-split' | 'users' | 'danger' | 'my-account' | 'ibkr-flex'

const ALL_TABS: { id: TabId; label: string; adminOnly?: boolean }[] = [
  { id: 'system',           label: 'System',           adminOnly: true },
  { id: 'my-account',       label: 'My Account' },
  { id: 'accounts',         label: 'Accounts' },
  { id: 'opening-balances', label: 'Opening Balances' },
  { id: 'ibkr-flex',        label: 'IBKR Flex',        adminOnly: true },
  { id: 'securities',       label: 'Securities',       adminOnly: true },
  { id: 'brokerages',       label: 'Brokerages',       adminOnly: true },
  { id: 'type-mappings',    label: 'Type Mappings',    adminOnly: true },
  { id: 'fx-rates',         label: 'FX Rates',         adminOnly: true },
  { id: 'currency-split',   label: 'Currency Split',   adminOnly: true },
  { id: 'users',            label: 'Users',            adminOnly: true },
  { id: 'danger',           label: '⚠ Bulk Delete',   adminOnly: true },
]

// ─── Confirmation Dialog ──────────────────────────────────────────────────────
function ConfirmDialog({
  title, message, confirmLabel = 'Delete', onConfirm, onCancel, danger = true,
  requireTyping,
}: {
  title: string
  message: string
  confirmLabel?: string
  onConfirm: () => void
  onCancel: () => void
  danger?: boolean
  requireTyping?: string
}) {
  const [typed, setTyped] = useState('')
  const canConfirm = !requireTyping || typed === requireTyping
  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-xl shadow-xl max-w-md w-full p-6 space-y-4">
        <div className="flex items-start gap-3">
          <AlertTriangle className={`h-6 w-6 flex-shrink-0 mt-0.5 ${danger ? 'text-red-500' : 'text-yellow-500'}`} />
          <div>
            <h3 className="font-semibold text-gray-900">{title}</h3>
            <p className="text-sm text-gray-600 mt-1">{message}</p>
          </div>
        </div>
        {requireTyping && (
          <div>
            <p className="text-xs text-gray-500 mb-1">Type <strong>{requireTyping}</strong> to confirm:</p>
            <input
              className="border rounded px-3 py-1.5 text-sm w-full"
              value={typed}
              onChange={e => setTyped(e.target.value)}
              placeholder={requireTyping}
            />
          </div>
        )}
        <div className="flex justify-end gap-3">
          <button onClick={onCancel} className="px-4 py-2 text-sm border border-gray-300 rounded hover:bg-gray-50">
            Cancel
          </button>
          <button
            onClick={onConfirm}
            disabled={!canConfirm}
            className={`px-4 py-2 text-sm rounded text-white disabled:opacity-40 ${danger ? 'bg-red-600 hover:bg-red-700' : 'bg-blue-600 hover:bg-blue-700'}`}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}

// ─── Sort Helpers ─────────────────────────────────────────────────────────────
type SortDir = 'asc' | 'desc'
type SortState = { col: string; dir: SortDir }

function useSortState(defaultCol: string, defaultDir: SortDir = 'asc') {
  const [sort, setSort] = useState<SortState>({ col: defaultCol, dir: defaultDir })
  const toggle = (col: string) =>
    setSort(s => ({ col, dir: s.col === col && s.dir === 'asc' ? 'desc' : 'asc' }))
  return { sort, toggle }
}

function sortRows<T>(rows: T[], col: string, dir: SortDir): T[] {
  return [...rows].sort((a, b) => {
    const va = String((a as Record<string, unknown>)[col] ?? '')
    const vb = String((b as Record<string, unknown>)[col] ?? '')
    const cmp = va.localeCompare(vb, undefined, { numeric: true, sensitivity: 'base' })
    return dir === 'asc' ? cmp : -cmp
  })
}

function SortTh({ label, col, sort, toggle, className = '' }: {
  label: string; col: string; sort: SortState; toggle: (col: string) => void; className?: string
}) {
  const active = sort.col === col
  return (
    <th className={`cursor-pointer select-none hover:bg-gray-100 ${className}`} onClick={() => toggle(col)}>
      <div className="flex items-center gap-1">
        {label}
        {active
          ? sort.dir === 'asc'
            ? <ChevronUp className="h-3 w-3 text-blue-600" />
            : <ChevronDown className="h-3 w-3 text-blue-600" />
          : <ChevronsUpDown className="h-3 w-3 opacity-30" />}
      </div>
    </th>
  )
}

// ─── Accounts Tab ────────────────────────────────────────────────────────────
function AccountsTab() {
  const qc = useQueryClient()
  const { data: accounts = [] } = useQuery({ queryKey: ['accounts'], queryFn: getAccounts })
  const { data: brokerages = [] } = useQuery({ queryKey: ['brokerages'], queryFn: getBrokerages })
  const [form, setForm] = useState({ brokerage_id: '', name: '', account_type: 'RRSP', base_currency: 'CAD', owner: '', account_number: '', ibkr_alias: '' })
  const [editing, setEditing] = useState<number | null>(null)
  const [editData, setEditData] = useState<Partial<Account>>({})
  const [deleteConfirm, setDeleteConfirm] = useState<{ id: number; name: string; txnCount?: number } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const { sort, toggle } = useSortState('name')
  const [filterBrokerage, setFilterBrokerage] = useState('')
  const [filterType, setFilterType] = useState('')

  const brokerageOptions = useMemo(() =>
    [...new Set((accounts as Account[]).map(a => a.brokerage_name).filter(Boolean))].sort()
  , [accounts])

  const visibleAccounts = useMemo(() =>
    (accounts as Account[]).filter(a =>
      (!filterBrokerage || a.brokerage_name === filterBrokerage) &&
      (!filterType || a.account_type === filterType)
    )
  , [accounts, filterBrokerage, filterType])

  const createMut = useMutation({
    mutationFn: () => createAccount({
      brokerage_id: Number(form.brokerage_id), name: form.name,
      account_type: form.account_type, base_currency: form.base_currency,
      owner: form.owner, account_number: form.account_number || undefined,
      ibkr_alias: form.ibkr_alias || undefined,
    }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['accounts'] }); setForm({ brokerage_id: '', name: '', account_type: 'RRSP', base_currency: 'CAD', owner: '', account_number: '', ibkr_alias: '' }) },
  })

  const updateMut = useMutation({
    mutationFn: ({ id, data }: { id: number; data: Partial<Account> }) => updateAccount(id, data),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['accounts'] }); setEditing(null) },
  })

  const deleteMut = useMutation({
    mutationFn: ({ id, force }: { id: number; force: boolean }) =>
      force ? forceDeleteAccount(id) : deleteAccount(id),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['accounts'] }); setDeleteConfirm(null); setError(null) },
    onError: (err: { response?: { data?: { detail?: string } } }) => {
      const detail = err?.response?.data?.detail || 'Error deleting account'
      setError(detail)
    },
  })

  return (
    <div className="space-y-6">
      {deleteConfirm && (
        <ConfirmDialog
          title={`Delete Account: ${deleteConfirm.name}`}
          message={deleteConfirm.txnCount
            ? `This account has transactions. Deleting will permanently remove the account AND all ${deleteConfirm.txnCount} of its transactions. This cannot be undone.`
            : `Are you sure you want to delete "${deleteConfirm.name}"? This cannot be undone.`}
          confirmLabel={deleteConfirm.txnCount ? 'Delete Account + Transactions' : 'Delete Account'}
          onConfirm={() => deleteMut.mutate({ id: deleteConfirm.id, force: !!deleteConfirm.txnCount })}
          onCancel={() => { setDeleteConfirm(null); setError(null) }}
        />
      )}

      {error && (
        <div className="bg-red-50 border border-red-200 rounded p-3 text-sm text-red-700 flex items-start gap-2">
          <AlertTriangle className="h-4 w-4 flex-shrink-0 mt-0.5" />
          <div>
            <span>{error}</span>
            {error.includes('transactions') && deleteConfirm && (
              <button
                onClick={() => deleteMut.mutate({ id: deleteConfirm.id, force: true })}
                className="ml-2 underline font-medium"
              >Force delete with all transactions</button>
            )}
          </div>
          <button onClick={() => setError(null)} className="ml-auto"><X className="h-4 w-4" /></button>
        </div>
      )}

      <div className="bg-gray-50 rounded-lg p-4 border border-gray-200">
        <h3 className="font-medium text-gray-700 mb-3">Add Account</h3>
        <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
          <select className="border rounded px-3 py-1.5 text-sm" value={form.brokerage_id}
            onChange={e => setForm(f => ({ ...f, brokerage_id: e.target.value }))}>
            <option value="">Select brokerage</option>
            {brokerages.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select>
          <input className="border rounded px-3 py-1.5 text-sm" placeholder="Name" value={form.name}
            onChange={e => setForm(f => ({ ...f, name: e.target.value }))} />
          <select className="border rounded px-3 py-1.5 text-sm" value={form.account_type}
            onChange={e => setForm(f => ({ ...f, account_type: e.target.value }))}>
            {['RRSP', 'TFSA', 'RESP', 'NON_REG'].map(t => <option key={t}>{t}</option>)}
          </select>
          <select className="border rounded px-3 py-1.5 text-sm" value={form.base_currency}
            onChange={e => setForm(f => ({ ...f, base_currency: e.target.value }))}>
            <option>CAD</option><option>USD</option>
          </select>
          <input className="border rounded px-3 py-1.5 text-sm" placeholder="Owner" value={form.owner}
            onChange={e => setForm(f => ({ ...f, owner: e.target.value }))} />
          <input className="border rounded px-3 py-1.5 text-sm" placeholder="Account # (optional)" value={form.account_number}
            onChange={e => setForm(f => ({ ...f, account_number: e.target.value }))} />
          <input className="border rounded px-3 py-1.5 text-sm" placeholder="IB Alias (e.g. Brian TFSA)" value={form.ibkr_alias}
            onChange={e => setForm(f => ({ ...f, ibkr_alias: e.target.value }))} />
        </div>
        <button onClick={() => createMut.mutate()} disabled={!form.brokerage_id || !form.name || !form.owner}
          className="mt-3 bg-blue-600 text-white text-sm px-4 py-1.5 rounded disabled:opacity-40">
          Add Account
        </button>
      </div>

      <div className="flex flex-wrap gap-3 mb-3">
        <select className="border rounded px-3 py-1.5 text-sm" value={filterBrokerage} onChange={e => setFilterBrokerage(e.target.value)}>
          <option value="">All Brokerages</option>
          {brokerageOptions.map(b => <option key={b} value={b}>{b}</option>)}
        </select>
        <select className="border rounded px-3 py-1.5 text-sm" value={filterType} onChange={e => setFilterType(e.target.value)}>
          <option value="">All Types</option>
          {['RRSP', 'TFSA', 'RESP', 'NON_REG'].map(t => <option key={t}>{t}</option>)}
        </select>
        {(filterBrokerage || filterType) && (
          <button onClick={() => { setFilterBrokerage(''); setFilterType('') }} className="text-xs text-gray-500 hover:text-gray-700">Clear filters</button>
        )}
      </div>

      <div className="overflow-x-auto rounded-lg border border-gray-200">
        <table className="min-w-full text-sm divide-y divide-gray-100">
          <thead className="bg-gray-50">
            <tr className="text-xs text-gray-500 uppercase">
              <SortTh label="Brokerage" col="brokerage_name" sort={sort} toggle={toggle} className="px-3 py-3 text-left" />
              <SortTh label="Name" col="name" sort={sort} toggle={toggle} className="px-3 py-3 text-left" />
              <SortTh label="Type" col="account_type" sort={sort} toggle={toggle} className="px-3 py-3 text-left" />
              <SortTh label="Currency" col="base_currency" sort={sort} toggle={toggle} className="px-3 py-3 text-left" />
              <SortTh label="Owner" col="owner" sort={sort} toggle={toggle} className="px-3 py-3 text-left" />
              <SortTh label="Acct #" col="account_number" sort={sort} toggle={toggle} className="px-3 py-3 text-left" />
              <th className="px-3 py-3 text-left text-xs text-gray-500 uppercase">IB Alias</th>
              <SortTh label="Active" col="active" sort={sort} toggle={toggle} className="px-3 py-3 text-left" />
              <th className="px-3 py-3 text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-50">
            {sortRows(visibleAccounts, sort.col, sort.dir).map(a => (
              <tr key={a.id} className="hover:bg-gray-50">
                <td className="px-3 py-2.5 text-xs text-gray-500">{a.brokerage_name}</td>
                {editing === a.id ? (
                  <>
                    <td className="px-3 py-2"><input className="border rounded px-2 py-1 text-xs w-36"
                      value={editData.name ?? a.name} onChange={e => setEditData(d => ({ ...d, name: e.target.value }))} /></td>
                    <td className="px-3 py-2"><select className="border rounded px-2 py-1 text-xs" value={editData.account_type ?? a.account_type}
                      onChange={e => setEditData(d => ({ ...d, account_type: e.target.value }))}>
                      {['RRSP', 'TFSA', 'RESP', 'NON_REG'].map(t => <option key={t}>{t}</option>)}
                    </select></td>
                    <td className="px-3 py-2"><select className="border rounded px-2 py-1 text-xs" value={editData.base_currency ?? a.base_currency}
                      onChange={e => setEditData(d => ({ ...d, base_currency: e.target.value }))}>
                      <option>CAD</option><option>USD</option>
                    </select></td>
                    <td className="px-3 py-2"><input className="border rounded px-2 py-1 text-xs w-20"
                      value={editData.owner ?? a.owner} onChange={e => setEditData(d => ({ ...d, owner: e.target.value }))} /></td>
                    <td className="px-3 py-2"><input className="border rounded px-2 py-1 text-xs w-28"
                      value={editData.account_number ?? (a.account_number || '')} onChange={e => setEditData(d => ({ ...d, account_number: e.target.value }))} /></td>
                    <td className="px-3 py-2"><input className="border rounded px-2 py-1 text-xs w-28"
                      placeholder="IB alias"
                      value={editData.ibkr_alias ?? (a.ibkr_alias || '')} onChange={e => setEditData(d => ({ ...d, ibkr_alias: e.target.value }))} /></td>
                    <td className="px-3 py-2">—</td>
                    <td className="px-3 py-2 text-right flex gap-2 justify-end">
                      <button onClick={() => updateMut.mutate({ id: a.id, data: editData })}
                        className="text-green-600 hover:text-green-800"><Check className="h-4 w-4" /></button>
                      <button onClick={() => setEditing(null)} className="text-gray-400 hover:text-gray-600"><X className="h-4 w-4" /></button>
                    </td>
                  </>
                ) : (
                  <>
                    <td className="px-3 py-2.5 font-medium">{a.name}</td>
                    <td className="px-3 py-2.5"><span className="px-1.5 py-0.5 bg-blue-50 text-blue-700 rounded text-xs">{a.account_type}</span></td>
                    <td className="px-3 py-2.5 text-xs text-gray-500">{a.base_currency}</td>
                    <td className="px-3 py-2.5 text-xs">{a.owner}</td>
                    <td className="px-3 py-2.5 text-xs text-gray-400 font-mono">{a.account_number || '—'}</td>
                    <td className="px-3 py-2.5 text-xs text-blue-600 font-mono">{a.ibkr_alias || '—'}</td>
                    <td className="px-3 py-2.5"><span className={`text-xs ${a.active ? 'text-green-600' : 'text-red-400'}`}>{a.active ? 'Yes' : 'No'}</span></td>
                    <td className="px-3 py-2.5 text-right">
                      <div className="flex gap-2 justify-end">
                        <button onClick={() => { setEditing(a.id); setEditData({}) }}
                          className="text-blue-500 hover:text-blue-700"><Edit2 className="h-3.5 w-3.5" /></button>
                        <button onClick={() => setDeleteConfirm({ id: a.id, name: a.name })}
                          className="text-red-400 hover:text-red-600"><Trash2 className="h-3.5 w-3.5" /></button>
                      </div>
                    </td>
                  </>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ─── Opening Balances Tab ─────────────────────────────────────────────────────
type OBEditState = {
  id: number
  account_id: string
  balance_date: string
  ticker: string
  quantity: string
  acb_per_share_cad: string
  currency: string
  notes: string
}

function OpeningBalancesTab() {
  const qc = useQueryClient()
  const { data: allBalances = [], isLoading } = useQuery({ queryKey: ['opening-balances'], queryFn: getOpeningBalances })
  const { data: accounts = [] } = useQuery({ queryKey: ['accounts'], queryFn: getAccounts })
  // Only show balances for accounts this user can access
  const accessibleIds = useMemo(() => new Set((accounts as Account[]).map(a => a.id)), [accounts])
  const balances = useMemo(
    () => (allBalances as OpeningBalance[]).filter(b => accessibleIds.has(b.account_id)),
    [allBalances, accessibleIds],
  )
  // Use dedicated 'all-securities' key so it's never stale from a filtered Securities-tab query
  const { data: securities = [] } = useQuery({ queryKey: ['securities', 'all'], queryFn: () => getSecurities() })
  const [form, setForm] = useState({
    account_id: '', balance_date: '', ticker: '', quantity: '', acb_per_share_cad: '', total_acb: '', acbMode: 'per_share' as 'per_share' | 'total', currency: 'CAD', notes: ''
  })
  const [editing, setEditing] = useState<OBEditState | null>(null)
  const [editError, setEditError] = useState<string | null>(null)
  const [deleteId, setDeleteId] = useState<number | null>(null)
  const { sort: obSort, toggle: obToggle } = useSortState('account_name')

  const startEdit = (b: OpeningBalance) => {
    setEditError(null)
    setEditing({
      id: b.id,
      account_id: String(b.account_id),
      balance_date: b.balance_date || '',
      ticker: b.ticker || '',
      quantity: b.quantity || '',
      acb_per_share_cad: b.acb_per_share_cad || '',
      currency: b.currency || 'CAD',
      notes: b.notes || '',
    })
  }

  // Compute ACB per share from form regardless of input mode
  const computedAcbPerShare = (): number => {
    const qty = parseFloat(form.quantity)
    if (form.acbMode === 'per_share') return parseFloat(form.acb_per_share_cad)
    if (form.acbMode === 'total' && qty > 0) return parseFloat(form.total_acb) / qty
    return 0
  }
  const computedTotalAcb = (): number => {
    const qty = parseFloat(form.quantity)
    if (form.acbMode === 'per_share') return qty * parseFloat(form.acb_per_share_cad)
    return parseFloat(form.total_acb)
  }

  const createMut = useMutation({
    mutationFn: () => createOpeningBalance({
      account_id: Number(form.account_id),
      balance_date: form.balance_date,
      ticker: form.ticker.toUpperCase(),
      quantity: parseFloat(form.quantity),
      acb_per_share_cad: computedAcbPerShare(),
      currency: form.currency,
      notes: form.notes || undefined,
    }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['opening-balances'] })
      qc.invalidateQueries({ queryKey: ['positions'] })
      qc.invalidateQueries({ queryKey: ['consolidated-positions'] })
      setForm({ account_id: '', balance_date: '', ticker: '', quantity: '', acb_per_share_cad: '', total_acb: '', acbMode: 'per_share', currency: 'CAD', notes: '' })
    },
  })

  const updateMut = useMutation({
    mutationFn: (e: OBEditState) => updateOpeningBalance(e.id, {
      account_id: Number(e.account_id),
      balance_date: e.balance_date,
      ticker: e.ticker.toUpperCase(),
      quantity: parseFloat(e.quantity),
      acb_per_share_cad: parseFloat(e.acb_per_share_cad),
      currency: e.currency,
      notes: e.notes || undefined,
    }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['opening-balances'] })
      qc.invalidateQueries({ queryKey: ['positions'] })
      qc.invalidateQueries({ queryKey: ['consolidated-positions'] })
      setEditing(null)
      setEditError(null)
    },
    onError: (err: { response?: { data?: { detail?: string } }; message?: string }) => {
      setEditError(err?.response?.data?.detail || err?.message || 'Save failed')
    },
  })

  const deleteMut = useMutation({
    mutationFn: (id: number) => deleteOpeningBalance(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['opening-balances'] })
      qc.invalidateQueries({ queryKey: ['positions'] })
      qc.invalidateQueries({ queryKey: ['consolidated-positions'] })
      setDeleteId(null)
    },
  })

  const fmtCAD = (v: string | null | undefined) => {
    if (!v) return '—'
    return parseFloat(v).toLocaleString('en-CA', { style: 'currency', currency: 'CAD' })
  }

  const totalACB = (balances as OpeningBalance[]).reduce((sum, b) => sum + parseFloat(b.total_acb_cad || '0'), 0)

  return (
    <div className="space-y-6">
      {deleteId && (
        <ConfirmDialog
          title="Delete Opening Balance"
          message="This will remove this opening balance entry. Positions calculated from it will be affected."
          onConfirm={() => deleteMut.mutate(deleteId)}
          onCancel={() => setDeleteId(null)}
        />
      )}

      {/* ── Edit Modal ── */}
      {editing && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-xl shadow-xl max-w-lg w-full p-6 space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="font-semibold text-gray-900">Edit Opening Balance</h3>
              <button onClick={() => setEditing(null)} className="text-gray-400 hover:text-gray-600">
                <X className="h-5 w-5" />
              </button>
            </div>
            <div className="grid grid-cols-2 gap-3 text-sm">
              <div>
                <label className="block text-xs text-gray-500 mb-1">Balance Date</label>
                <input type="date" className="border rounded px-3 py-1.5 text-sm w-full"
                  value={editing.balance_date}
                  onChange={e => setEditing(v => v && ({ ...v, balance_date: e.target.value }))} />
              </div>
              <div>
                <label className="block text-xs text-gray-500 mb-1">Ticker</label>
                <input list="ob-edit-tickers" className="border rounded px-3 py-1.5 text-sm w-full uppercase"
                  value={editing.ticker}
                  onChange={e => setEditing(v => v && ({ ...v, ticker: e.target.value.toUpperCase() }))} />
                <datalist id="ob-edit-tickers">
                  {(securities as Security[]).filter(s => !s.is_option).map(s => (
                    <option key={s.id} value={s.ticker}>{s.name || s.ticker}</option>
                  ))}
                </datalist>
              </div>
              <div>
                <label className="block text-xs text-gray-500 mb-1">Quantity</label>
                <input type="number" step="0.0001" className="border rounded px-3 py-1.5 text-sm w-full"
                  value={editing.quantity}
                  onChange={e => setEditing(v => v && ({ ...v, quantity: e.target.value }))} />
              </div>
              <div>
                <label className="block text-xs text-gray-500 mb-1">ACB per Share (CAD)</label>
                <input type="number" step="0.0001" className="border rounded px-3 py-1.5 text-sm w-full"
                  value={editing.acb_per_share_cad}
                  onChange={e => setEditing(v => v && ({ ...v, acb_per_share_cad: e.target.value }))} />
              </div>
              <div>
                <label className="block text-xs text-gray-500 mb-1">Currency</label>
                <select className="border rounded px-3 py-1.5 text-sm w-full"
                  value={editing.currency}
                  onChange={e => setEditing(v => v && ({ ...v, currency: e.target.value }))}>
                  <option>CAD</option><option>USD</option>
                </select>
              </div>
              <div>
                <label className="block text-xs text-gray-500 mb-1">Account</label>
                <select className="border rounded px-3 py-1.5 text-sm w-full"
                  value={editing.account_id}
                  onChange={e => setEditing(v => v && ({ ...v, account_id: e.target.value }))}>
                  {(accounts as Account[]).map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
                </select>
              </div>
              <div className="col-span-2">
                <label className="block text-xs text-gray-500 mb-1">Notes</label>
                <input className="border rounded px-3 py-1.5 text-sm w-full"
                  value={editing.notes}
                  onChange={e => setEditing(v => v && ({ ...v, notes: e.target.value }))} />
              </div>
            </div>
            {editing.quantity && editing.acb_per_share_cad && (
              <p className="text-xs text-gray-500">
                Total ACB: <strong>{fmtCAD(String(parseFloat(editing.quantity) * parseFloat(editing.acb_per_share_cad)))}</strong>
              </p>
            )}
            {editError && (
              <p className="text-xs text-red-600 bg-red-50 border border-red-200 rounded p-2">Error: {editError}</p>
            )}
            <div className="flex justify-end gap-3 pt-1 border-t border-gray-100">
              <button onClick={() => { setEditing(null); setEditError(null) }}
                className="px-4 py-2 text-sm border border-gray-300 rounded-lg hover:bg-gray-50">
                Cancel
              </button>
              <button
                onClick={() => updateMut.mutate(editing)}
                disabled={updateMut.isPending || !editing.balance_date || !editing.ticker || !editing.quantity || !editing.acb_per_share_cad}
                className="flex items-center gap-2 px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50">
                <Check className="h-4 w-4" />
                {updateMut.isPending ? 'Saving…' : 'Save Changes'}
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 text-sm text-blue-800">
        <strong>Opening Balances</strong> let you enter existing holdings without importing all historical transactions.
        Enter each security you hold with its current quantity and average cost per share (in CAD).
        These are treated as BUY transactions dated on the balance date.
      </div>

      <div className="bg-gray-50 rounded-lg p-4 border border-gray-200">
        <h3 className="font-medium text-gray-700 mb-3">Add Opening Balance</h3>
        <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
          <div>
            <label className="block text-xs text-gray-500 mb-1">Account</label>
            <select className="border rounded px-3 py-1.5 text-sm w-full" value={form.account_id}
              onChange={e => setForm(f => ({ ...f, account_id: e.target.value }))}>
              <option value="">Select account</option>
              {(accounts as Account[]).map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">Balance Date</label>
            <input type="date" className="border rounded px-3 py-1.5 text-sm w-full" value={form.balance_date}
              onChange={e => setForm(f => ({ ...f, balance_date: e.target.value }))} />
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">Ticker</label>
            <input list="ob-add-tickers" className="border rounded px-3 py-1.5 text-sm w-full uppercase" placeholder="e.g. ENB" value={form.ticker}
              onChange={e => setForm(f => ({ ...f, ticker: e.target.value.toUpperCase() }))} />
            <datalist id="ob-add-tickers">
              {(securities as Security[]).filter(s => !s.is_option).map(s => (
                <option key={s.id} value={s.ticker}>{s.name || s.ticker}</option>
              ))}
            </datalist>
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">Quantity (shares)</label>
            <input type="number" step="0.0001" className="border rounded px-3 py-1.5 text-sm w-full" placeholder="100" value={form.quantity}
              onChange={e => setForm(f => ({ ...f, quantity: e.target.value }))} />
          </div>
          {/* ACB mode toggle + input */}
          <div>
            <div className="flex items-center gap-2 mb-1">
              <label className="text-xs text-gray-500">ACB</label>
              <div className="flex rounded border border-gray-300 text-xs overflow-hidden">
                <button type="button"
                  className={`px-2 py-0.5 ${form.acbMode === 'per_share' ? 'bg-blue-600 text-white' : 'bg-white text-gray-600 hover:bg-gray-50'}`}
                  onClick={() => setForm(f => ({ ...f, acbMode: 'per_share' }))}>
                  Per Share
                </button>
                <button type="button"
                  className={`px-2 py-0.5 ${form.acbMode === 'total' ? 'bg-blue-600 text-white' : 'bg-white text-gray-600 hover:bg-gray-50'}`}
                  onClick={() => setForm(f => ({ ...f, acbMode: 'total' }))}>
                  Total
                </button>
              </div>
            </div>
            {form.acbMode === 'per_share' ? (
              <input type="number" step="0.0001" className="border rounded px-3 py-1.5 text-sm w-full" placeholder="45.00" value={form.acb_per_share_cad}
                onChange={e => setForm(f => ({ ...f, acb_per_share_cad: e.target.value }))} />
            ) : (
              <input type="number" step="0.01" className="border rounded px-3 py-1.5 text-sm w-full" placeholder="4500.00" value={form.total_acb}
                onChange={e => setForm(f => ({ ...f, total_acb: e.target.value }))} />
            )}
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">Currency</label>
            <select className="border rounded px-3 py-1.5 text-sm w-full" value={form.currency}
              onChange={e => setForm(f => ({ ...f, currency: e.target.value }))}>
              <option>CAD</option><option>USD</option>
            </select>
          </div>
          <div className="md:col-span-3">
            <label className="block text-xs text-gray-500 mb-1">Notes (optional)</label>
            <input className="border rounded px-3 py-1.5 text-sm w-full" placeholder="e.g. Opening balance as of Jan 1 2024" value={form.notes}
              onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} />
          </div>
        </div>
        {form.quantity && (form.acb_per_share_cad || form.total_acb) && (
          <p className="text-xs text-gray-500 mt-2">
            {form.acbMode === 'per_share'
              ? <>Per-share ACB: <strong>{fmtCAD(form.acb_per_share_cad)}</strong> · Total ACB: <strong>{fmtCAD(String(computedTotalAcb()))}</strong></>
              : <>Total ACB: <strong>{fmtCAD(form.total_acb)}</strong> · Per-share: <strong>{fmtCAD(String(computedAcbPerShare()))}</strong></>
            }
          </p>
        )}
        <button
          onClick={() => createMut.mutate()}
          disabled={!form.account_id || !form.balance_date || !form.ticker || !form.quantity ||
            (form.acbMode === 'per_share' ? !form.acb_per_share_cad : !form.total_acb)}
          className="mt-3 bg-blue-600 text-white text-sm px-4 py-1.5 rounded disabled:opacity-40"
        >
          {createMut.isPending ? 'Saving...' : 'Add Opening Balance'}
        </button>
        {createMut.isError && (
          <p className="text-red-600 text-xs mt-2">Error saving — check all fields and try again</p>
        )}
      </div>

      <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
        <div className="px-4 py-3 bg-gray-50 border-b flex justify-between items-center">
          <span className="text-sm font-medium text-gray-700">{(balances as OpeningBalance[]).length} opening balance entries</span>
          <span className="text-sm font-semibold text-gray-700">Total: {fmtCAD(String(totalACB))}</span>
        </div>
        {isLoading ? (
          <div className="p-8 text-center text-gray-400">Loading...</div>
        ) : (balances as OpeningBalance[]).length === 0 ? (
          <div className="p-8 text-center text-gray-400 text-sm">No opening balances entered yet</div>
        ) : (
          <table className="min-w-full text-sm divide-y divide-gray-100">
            <thead className="bg-gray-50">
              <tr className="text-xs text-gray-500 uppercase">
                <SortTh label="Account" col="account_name" sort={obSort} toggle={obToggle} className="px-3 py-3 text-left" />
                <SortTh label="Date" col="balance_date" sort={obSort} toggle={obToggle} className="px-3 py-3 text-left" />
                <SortTh label="Ticker" col="ticker" sort={obSort} toggle={obToggle} className="px-3 py-3 text-left" />
                <SortTh label="Quantity" col="quantity" sort={obSort} toggle={obToggle} className="px-3 py-3 text-right" />
                <SortTh label="ACB/Share" col="acb_per_share_cad" sort={obSort} toggle={obToggle} className="px-3 py-3 text-right" />
                <SortTh label="Total ACB" col="total_acb_cad" sort={obSort} toggle={obToggle} className="px-3 py-3 text-right" />
                <SortTh label="CCY" col="currency" sort={obSort} toggle={obToggle} className="px-3 py-3 text-left" />
                <th className="px-3 py-3 text-left">Notes</th>
                <th className="px-3 py-3"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {sortRows(balances as OpeningBalance[], obSort.col, obSort.dir).map(b => (
                <tr key={b.id} className="hover:bg-gray-50">
                  <td className="px-3 py-2.5 text-xs text-gray-500">{b.account_name}</td>
                  <td className="px-3 py-2.5 text-xs">{b.balance_date}</td>
                  <td className="px-3 py-2.5 font-mono font-semibold text-blue-700">{b.ticker}</td>
                  <td className="px-3 py-2.5 text-right">{parseFloat(b.quantity || '0').toLocaleString('en-CA', { maximumFractionDigits: 4 })}</td>
                  <td className="px-3 py-2.5 text-right">{fmtCAD(b.acb_per_share_cad)}</td>
                  <td className="px-3 py-2.5 text-right font-semibold">{fmtCAD(b.total_acb_cad)}</td>
                  <td className="px-3 py-2.5 text-xs text-gray-500">{b.currency}</td>
                  <td className="px-3 py-2.5 text-xs text-gray-400 max-w-xs truncate">{b.notes || '—'}</td>
                  <td className="px-3 py-2.5">
                    <div className="flex items-center gap-2">
                      <button onClick={() => startEdit(b)} className="text-gray-400 hover:text-blue-600" title="Edit">
                        <Edit2 className="h-3.5 w-3.5" />
                      </button>
                      <button onClick={() => setDeleteId(b.id)} className="text-gray-400 hover:text-red-600" title="Delete">
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {/* ── Cash Opening Balances ── */}
      <CashOpeningsSection />
    </div>
  )
}

// ─── Cash Opening Balances (sub-section of Opening Balances tab) ─────────────
function CashOpeningsSection() {
  const qc = useQueryClient()
  const { data: accounts = [] } = useQuery({ queryKey: ['accounts'], queryFn: getAccounts })
  const { data: cashOpenings = [] } = useQuery({ queryKey: ['cash-openings'], queryFn: getCashOpenings })
  const [form, setForm] = useState({ account_id: '', balance_date: new Date().toISOString().slice(0, 10), amount: '', currency: 'CAD', notes: '' })

  const createMut = useMutation({
    mutationFn: () => createCashOpening({
      account_id: Number(form.account_id),
      balance_date: form.balance_date,
      amount: parseFloat(form.amount),
      currency: form.currency,
      notes: form.notes || undefined,
    }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['cash-openings'] })
      qc.invalidateQueries({ queryKey: ['cash-balances'] })
      setForm(f => ({ ...f, amount: '', notes: '' }))
    },
  })
  const deleteMut = useMutation({
    mutationFn: deleteCashOpening,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['cash-openings'] })
      qc.invalidateQueries({ queryKey: ['cash-balances'] })
    },
  })

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 pt-2 border-t border-gray-200">
        <h3 className="font-semibold text-gray-700">Opening Cash Balances</h3>
        <span className="text-xs text-gray-400">Enter the starting cash balance for each account. This anchors the cash calculation in Positions.</span>
      </div>

      <div className="bg-gray-50 rounded-lg p-4 border border-gray-200">
        <div className="flex flex-wrap gap-3 items-end">
          <div>
            <label className="block text-xs text-gray-500 mb-1">Account</label>
            <select className="border rounded px-3 py-1.5 text-sm" value={form.account_id}
              onChange={e => setForm(f => ({ ...f, account_id: e.target.value }))}>
              <option value="">Select account</option>
              {(accounts as Account[]).map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">Date</label>
            <input type="date" className="border rounded px-3 py-1.5 text-sm" value={form.balance_date}
              onChange={e => setForm(f => ({ ...f, balance_date: e.target.value }))} />
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">Opening Cash Balance</label>
            <input type="number" step="0.01" className="border rounded px-3 py-1.5 text-sm w-32" placeholder="0.00" value={form.amount}
              onChange={e => setForm(f => ({ ...f, amount: e.target.value }))} />
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">Currency</label>
            <select className="border rounded px-3 py-1.5 text-sm" value={form.currency}
              onChange={e => setForm(f => ({ ...f, currency: e.target.value }))}>
              <option>CAD</option><option>USD</option>
            </select>
          </div>
          <div>
            <label className="block text-xs text-gray-500 mb-1">Notes</label>
            <input className="border rounded px-3 py-1.5 text-sm w-40" placeholder="Optional" value={form.notes}
              onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} />
          </div>
          <button onClick={() => createMut.mutate()}
            disabled={!form.account_id || !form.amount || createMut.isPending}
            className="bg-green-600 text-white text-sm px-4 py-1.5 rounded disabled:opacity-40 hover:bg-green-700">
            Add Cash Opening
          </button>
        </div>
      </div>

      {(cashOpenings as CashOpening[]).length > 0 && (
        <div className="overflow-x-auto rounded-lg border border-gray-200">
          <table className="min-w-full text-sm divide-y divide-gray-100">
            <thead className="bg-gray-50">
              <tr className="text-xs text-gray-500 uppercase">
                <th className="px-3 py-2.5 text-left">Account</th>
                <th className="px-3 py-2.5 text-left">Date</th>
                <th className="px-3 py-2.5 text-right">Amount</th>
                <th className="px-3 py-2.5 text-left">Currency</th>
                <th className="px-3 py-2.5 text-left">Notes</th>
                <th className="px-3 py-2.5"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {(cashOpenings as CashOpening[]).map(c => (
                <tr key={c.id} className="hover:bg-gray-50">
                  <td className="px-3 py-2 text-gray-700">{c.account_name}</td>
                  <td className="px-3 py-2 text-gray-500 text-xs">{c.balance_date}</td>
                  <td className="px-3 py-2 text-right font-semibold font-mono text-green-700">
                    {parseFloat(c.amount).toLocaleString('en-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                  </td>
                  <td className="px-3 py-2 text-xs text-gray-500">{c.currency}</td>
                  <td className="px-3 py-2 text-xs text-gray-400">{c.notes || '—'}</td>
                  <td className="px-3 py-2 text-right">
                    <button onClick={() => deleteMut.mutate(c.id)} className="text-red-400 hover:text-red-600">
                      <Trash2 className="h-3.5 w-3.5" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

// ─── Option ticker parser (mirrors price_service.py parse_option_ticker) ──────
function parseOptionTicker(ticker: string): { underlying: string; optionType: 'CALL' | 'PUT'; expiry: string; strike: number } | null {
  // Legacy format: "CALL AMD 09/19/25 125" or "PUT AAPL 11/20/20 415"
  const leg = ticker.match(/^(CALL|PUT)\s+([A-Z.]+)\s+(\d{2})\/(\d{2})\/(\d{2,4})\s+([\d.]+)$/i)
  if (leg) {
    const [, t, u, mm, dd, yy, sk] = leg
    const yr = yy.length === 4 ? parseInt(yy) : 2000 + parseInt(yy)
    return { underlying: u, optionType: t.toUpperCase() as 'CALL' | 'PUT', expiry: `${yr}-${mm}-${dd}`, strike: parseFloat(sk) }
  }
  // IB/OCC format: "CRWD 260717C00400000" or "CRWD260717C00400000"
  const ib = ticker.match(/^([A-Z. ]+?)\s*(\d{2})(\d{2})(\d{2})([CP])(\d{8})$/)
  if (ib) {
    const [, u, yy, mm, dd, t, sk] = ib
    return { underlying: u.trim(), optionType: t === 'C' ? 'CALL' : 'PUT', expiry: `${2000 + parseInt(yy)}-${mm}-${dd}`, strike: parseInt(sk) / 1000 }
  }
  return null
}

// ─── Securities Tab ───────────────────────────────────────────────────────────
function SecuritiesTab() {
  const qc = useQueryClient()
  const [search, setSearch] = useState('')
  const { data: securities = [] } = useQuery({
    queryKey: ['securities', search],
    queryFn: () => getSecurities({ search: search || undefined }),
  })
  const [form, setForm] = useState({ ticker: '', name: '', asset_class: 'EQUITY', currency: 'CAD', exchange: '' })
  const [editing, setEditing] = useState<number | null>(null)
  const [editData, setEditData] = useState<Partial<Security>>({})
  const [deleteId, setDeleteId] = useState<number | null>(null)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const [updateError, setUpdateError] = useState<string | null>(null)
  const { sort, toggle } = useSortState('ticker')
  const [assetClassFilter, setAssetClassFilter] = useState('')
  const [underlyingFilter, setUnderlyingFilter] = useState('')
  const [optionTypeFilter, setOptionTypeFilter] = useState<'ALL' | 'CALL' | 'PUT'>('ALL')
  const [hideExpired, setHideExpired] = useState(false)
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(50)

  const createMut = useMutation({
    mutationFn: () => createSecurity(form),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['securities'] }); setForm({ ticker: '', name: '', asset_class: 'EQUITY', currency: 'CAD', exchange: '' }) },
  })
  const updateMut = useMutation({
    mutationFn: ({ id, data }: { id: number; data: Partial<Security> }) => updateSecurity(id, data),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['securities'] }); setEditing(null); setUpdateError(null) },
    onError: (err: { response?: { data?: { detail?: string } } }) => {
      setUpdateError(err?.response?.data?.detail || 'Could not save security')
    },
  })
  const deleteMut = useMutation({
    mutationFn: deleteSecurity,
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['securities'] }); setDeleteId(null); setDeleteError(null) },
    onError: (err: { response?: { data?: { detail?: string } } }) => {
      setDeleteError(err?.response?.data?.detail || 'Cannot delete security')
      setDeleteId(null)
    },
  })
  const cleanupMut = useMutation({
    mutationFn: deleteUnusedSecurities,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['securities'] }),
  })
  // ── Yahoo picker state ──────────────────────────────────────────────────────
  interface YahooPicker {
    secId: number
    query: string
    results: YahooSearchResult[]
    loading: boolean
    error: string | null
    applyMsg: string | null
  }
  const [yahooPicker, setYahooPicker] = useState<YahooPicker | null>(null)
  const yahooInputRef = useRef<HTMLInputElement>(null)

  // Focus the search input when picker opens
  useEffect(() => {
    if (yahooPicker && yahooInputRef.current) yahooInputRef.current.focus()
  }, [yahooPicker?.secId])

  const openYahooPicker = (sec: Security) => {
    const picker: YahooPicker = { secId: sec.id, query: sec.ticker, results: [], loading: true, error: null, applyMsg: null }
    setYahooPicker(picker)
    searchYahooSecurities(sec.ticker)
      .then(r => setYahooPicker(p => p && p.secId === sec.id ? { ...p, results: r, loading: false } : p))
      .catch(() => setYahooPicker(p => p && p.secId === sec.id ? { ...p, loading: false, error: 'Search failed' } : p))
  }

  const runYahooSearch = (query: string) => {
    if (!yahooPicker || !query.trim()) return
    setYahooPicker(p => p ? { ...p, query, results: [], loading: true, error: null } : p)
    searchYahooSecurities(query.trim())
      .then(r => setYahooPicker(p => p ? { ...p, results: r, loading: false } : p))
      .catch(() => setYahooPicker(p => p ? { ...p, loading: false, error: 'Search failed' } : p))
  }

  const fetchYahooMut = useMutation({
    mutationFn: ({ id, symbol }: { id: number; symbol?: string }) => fetchSecurityYahooInfo(id, symbol),
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ['securities'] })
      const fields = Object.keys(data.updated || {}).join(', ')
      const msg = data.success ? `✓ Updated: ${fields || 'nothing new'}` : (data.message || 'Failed')
      setYahooPicker(p => p ? { ...p, applyMsg: msg, loading: false } : p)
    },
    onError: () => setYahooPicker(p => p ? { ...p, applyMsg: 'Error applying info', loading: false } : p),
  })

  const [histFetchStatus, setHistFetchStatus] = useState<Record<number, 'pending' | 'ok' | 'err'>>({})
  const [activeHistJobs, setActiveHistJobs] = useState<Record<number, string>>({})
  const fetchHistMut = useMutation({
    mutationFn: (secId: number) => fetchPriceHistory({ security_ids: [secId] }),
    onMutate: (secId) => setHistFetchStatus(s => ({ ...s, [secId]: 'pending' })),
    onSuccess: (data, secId) => {
      const jobId = data.job_id ?? data.id
      if (jobId) setActiveHistJobs(j => ({ ...j, [secId]: jobId }))
      else setHistFetchStatus(s => ({ ...s, [secId]: 'ok' }))
    },
    onError: (_err, secId) => setHistFetchStatus(s => ({ ...s, [secId]: 'err' })),
  })

  // Poll active per-security history jobs
  useEffect(() => {
    if (Object.keys(activeHistJobs).length === 0) return
    const interval = setInterval(async () => {
      for (const [secIdStr, jobId] of Object.entries(activeHistJobs)) {
        const secId = Number(secIdStr)
        try {
          const job = await getPriceJob(jobId)
          if (job.status === 'done') {
            setHistFetchStatus(s => ({ ...s, [secId]: 'ok' }))
            setActiveHistJobs(j => { const n = { ...j }; delete n[secId]; return n })
          } else if (job.status === 'error') {
            setHistFetchStatus(s => ({ ...s, [secId]: 'err' }))
            setActiveHistJobs(j => { const n = { ...j }; delete n[secId]; return n })
          }
        } catch { /* network error — keep polling */ }
      }
    }, 2000)
    return () => clearInterval(interval)
  }, [activeHistJobs])

  return (
    <div className="space-y-4">
      {deleteId && (
        <ConfirmDialog
          title="Delete Security"
          message="Are you sure? Securities with transactions cannot be deleted."
          onConfirm={() => deleteMut.mutate(deleteId)}
          onCancel={() => setDeleteId(null)}
        />
      )}
      {deleteError && (
        <div className="bg-red-50 border border-red-200 rounded p-3 text-sm text-red-700 flex justify-between">
          <span>{deleteError}</span>
          <button onClick={() => setDeleteError(null)}><X className="h-4 w-4" /></button>
        </div>
      )}

      <div className="flex gap-3 items-end flex-wrap">
        <div>
          <label className="block text-xs text-gray-500 mb-1">Ticker Search</label>
          <input className="border rounded px-3 py-1.5 text-sm w-36" placeholder="Ticker..." value={search}
            onChange={e => { setSearch(e.target.value.toUpperCase()); setPage(1) }} />
        </div>
        <div>
          <label className="block text-xs text-gray-500 mb-1">Asset Class</label>
          <select className="border rounded px-3 py-1.5 text-sm" value={assetClassFilter}
            onChange={e => { setAssetClassFilter(e.target.value); setPage(1) }}>
            <option value="">All</option>
            {['EQUITY', 'ETF', 'MUTUAL_FUND', 'OPTION', 'CURRENCY', 'MORTGAGE', 'FIXED_INCOME'].map(t => <option key={t} value={t}>{t}</option>)}
          </select>
        </div>
        {(assetClassFilter === 'OPTION' || assetClassFilter === '') && (
          <>
            <div>
              <label className="block text-xs text-gray-500 mb-1">Underlying</label>
              <input className="border rounded px-3 py-1.5 text-sm w-28" placeholder="e.g. AAPL" value={underlyingFilter}
                onChange={e => { setUnderlyingFilter(e.target.value.toUpperCase()); setPage(1) }} />
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1">Option Type</label>
              <select className="border rounded px-3 py-1.5 text-sm" value={optionTypeFilter}
                onChange={e => { setOptionTypeFilter(e.target.value as 'ALL' | 'CALL' | 'PUT'); setPage(1) }}>
                <option value="ALL">All</option>
                <option value="CALL">Call</option>
                <option value="PUT">Put</option>
              </select>
            </div>
            <div className="flex items-end pb-1.5">
              <label className="flex items-center gap-1.5 text-sm text-gray-600 cursor-pointer select-none">
                <input type="checkbox" checked={hideExpired} onChange={e => { setHideExpired(e.target.checked); setPage(1) }} />
                Hide expired
              </label>
            </div>
          </>
        )}
        <button
          onClick={() => cleanupMut.mutate()}
          disabled={cleanupMut.isPending}
          className="text-sm border border-orange-300 text-orange-700 rounded px-3 py-1.5 hover:bg-orange-50"
        >
          Delete Unused Securities
        </button>
        {cleanupMut.isSuccess && (
          <span className="text-xs text-green-600">
            Deleted {(cleanupMut.data as { deleted_count: number })?.deleted_count ?? 0} unused
          </span>
        )}
      </div>

      <div className="bg-gray-50 rounded-lg p-4 border border-gray-200">
        <h3 className="font-medium text-gray-700 mb-3">Add Security</h3>
        <div className="flex flex-wrap gap-3">
          <input className="border rounded px-3 py-1.5 text-sm w-24" placeholder="Ticker" value={form.ticker}
            onChange={e => setForm(f => ({ ...f, ticker: e.target.value.toUpperCase() }))} />
          <input className="border rounded px-3 py-1.5 text-sm w-48" placeholder="Name" value={form.name}
            onChange={e => setForm(f => ({ ...f, name: e.target.value }))} />
          <select className="border rounded px-3 py-1.5 text-sm" value={form.asset_class}
            onChange={e => setForm(f => ({ ...f, asset_class: e.target.value }))}>
            {['EQUITY', 'ETF', 'MUTUAL_FUND', 'OPTION', 'CURRENCY', 'MORTGAGE', 'FIXED_INCOME'].map(t => <option key={t}>{t}</option>)}
          </select>
          <select className="border rounded px-3 py-1.5 text-sm" value={form.currency}
            onChange={e => setForm(f => ({ ...f, currency: e.target.value }))}>
            <option>CAD</option><option>USD</option>
          </select>
          <input className="border rounded px-3 py-1.5 text-sm w-28" placeholder="Exchange" value={form.exchange}
            list="exchange-options"
            onChange={e => setForm(f => ({ ...f, exchange: e.target.value.toUpperCase() }))} />
          <button onClick={() => createMut.mutate()} disabled={!form.ticker}
            className="bg-blue-600 text-white text-sm px-4 py-1.5 rounded disabled:opacity-40">Add</button>
        </div>
      </div>

      <div className="overflow-x-auto rounded-lg border border-gray-200">
        <table className="min-w-full text-sm divide-y divide-gray-100">
          <thead className="bg-gray-50">
            <tr className="text-xs text-gray-500 uppercase">
              <SortTh label="Ticker" col="ticker" sort={sort} toggle={toggle} className="px-3 py-3 text-left" />
              <SortTh label="Name" col="name" sort={sort} toggle={toggle} className="px-3 py-3 text-left" />
              <SortTh label="Asset Class" col="asset_class" sort={sort} toggle={toggle} className="px-3 py-3 text-left" />
              <SortTh label="Exchange" col="exchange" sort={sort} toggle={toggle} className="px-3 py-3 text-left" />
              <SortTh label="Currency" col="currency" sort={sort} toggle={toggle} className="px-3 py-3 text-left" />
              <SortTh label="Txns" col="transaction_count" sort={sort} toggle={toggle} className="px-3 py-3 text-right" />
              <th className="px-3 py-3 text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-50">
            {(() => {
              const today = new Date().toISOString().slice(0, 10)
              // Client-side filtering on top of server search
              let filtered = (securities as Security[]).filter(s => {
                if (assetClassFilter && s.asset_class !== assetClassFilter) return false
                const opt = s.asset_class === 'OPTION' ? parseOptionTicker(s.ticker) : null
                if (underlyingFilter) {
                  if (!opt || opt.underlying !== underlyingFilter) return false
                }
                if (optionTypeFilter !== 'ALL') {
                  if (!opt || opt.optionType !== optionTypeFilter) return false
                }
                if (hideExpired && opt && opt.expiry < today) return false
                return true
              })
              const sorted = sortRows(filtered, sort.col, sort.dir)
              const totalFiltered = sorted.length
              const totalPages = Math.max(1, Math.ceil(totalFiltered / pageSize))
              const safePage = Math.min(page, totalPages)
              const pageRows = sorted.slice((safePage - 1) * pageSize, safePage * pageSize)

              // Detect duplicate tickers in page
              const tickerCounts: Record<string, number> = {}
              for (const s of pageRows) tickerCounts[s.ticker] = (tickerCounts[s.ticker] || 0) + 1

              return (
                <>
                  {pageRows.map(s => {
                    const isDup = tickerCounts[s.ticker] > 1
                    const opt = s.asset_class === 'OPTION' ? parseOptionTicker(s.ticker) : null
                    return (
                      <tr key={s.id} className={`hover:bg-gray-50 ${isDup ? 'bg-amber-50' : ''}`}>
                        {editing === s.id ? (
                          <>
                            <td className="px-3 py-2"><input className="border rounded px-2 py-1 text-xs w-28"
                              value={editData.ticker ?? s.ticker} onChange={e => setEditData(d => ({ ...d, ticker: e.target.value.toUpperCase() }))} /></td>
                            <td className="px-3 py-2">
                              <input className="border rounded px-2 py-1 text-xs w-40"
                                value={editData.name ?? (s.name || '')} onChange={e => setEditData(d => ({ ...d, name: e.target.value }))} />
                              <div className="mt-1">
                                <input className="border rounded px-2 py-1 text-xs w-40 border-purple-200 bg-purple-50"
                                  placeholder="Yahoo ticker override"
                                  title="Yahoo fetch override — use this symbol to fetch prices/history instead of the ticker above. Use this for ticker renames (e.g. old ticker SQ renamed to XYZ: set override to XYZ). Also accepts .TO suffix for TSX securities."
                                  value={editData.fetch_ticker_override ?? (s.fetch_ticker_override || '')}
                                  onChange={e => setEditData(d => ({ ...d, fetch_ticker_override: e.target.value || null }))} />
                              </div>
                              {updateError && <p className="mt-1 text-xs text-red-600">{updateError}</p>}
                            </td>
                            <td className="px-3 py-2"><select className="border rounded px-2 py-1 text-xs" value={editData.asset_class ?? s.asset_class}
                              onChange={e => setEditData(d => ({ ...d, asset_class: e.target.value }))}>
                              {['EQUITY', 'ETF', 'MUTUAL_FUND', 'OPTION', 'CURRENCY', 'MORTGAGE', 'FIXED_INCOME'].map(t => <option key={t}>{t}</option>)}
                            </select></td>
                            <td className="px-3 py-2"><input className="border rounded px-2 py-1 text-xs w-24"
                              list="exchange-options"
                              value={editData.exchange ?? (s.exchange || '')} onChange={e => setEditData(d => ({ ...d, exchange: e.target.value.toUpperCase() }))} /></td>
                            <td className="px-3 py-2"><select className="border rounded px-2 py-1 text-xs" value={editData.currency ?? (s.currency || 'CAD')}
                              onChange={e => setEditData(d => ({ ...d, currency: e.target.value }))}>
                              <option>CAD</option><option>USD</option>
                            </select></td>
                            <td className="px-3 py-2 text-right text-xs text-gray-400">{s.transaction_count}</td>
                            <td className="px-3 py-2 text-right">
                              <div className="flex gap-2 justify-end">
                                <button onClick={() => updateMut.mutate({ id: s.id, data: editData })} disabled={updateMut.isPending} className="text-green-600 disabled:opacity-40"><Check className="h-4 w-4" /></button>
                                <button onClick={() => { setEditing(null); setUpdateError(null) }} className="text-gray-400"><X className="h-4 w-4" /></button>
                              </div>
                            </td>
                          </>
                        ) : (
                          <>
                            <td className="px-3 py-2.5 font-mono font-semibold text-blue-700 text-xs leading-snug">
                              <div>{s.ticker}{isDup && <span className="ml-1.5 text-amber-600 font-normal">⚠ dup</span>}</div>
                            </td>
                            {opt ? (
                              <td className="px-3 py-2.5 leading-snug">
                                <div className="flex flex-wrap gap-x-2 gap-y-0.5 items-baseline">
                                  <span className={`text-xs font-bold ${opt.optionType === 'CALL' ? 'text-green-700' : 'text-red-700'}`}>{opt.optionType}</span>
                                  <button
                                    onClick={() => { setUnderlyingFilter(u => u === opt.underlying ? '' : opt.underlying); setAssetClassFilter('OPTION'); setPage(1) }}
                                    title="Filter by this underlying"
                                    className="text-xs font-mono font-semibold text-blue-600 hover:underline"
                                  >{opt.underlying}</button>
                                  <span className="text-xs text-gray-600">K={opt.strike}</span>
                                  <span className={`text-xs ${opt.expiry < today ? 'text-red-400' : 'text-gray-500'}`}>{opt.expiry}</span>
                                </div>
                                {s.name && <div className="text-xs text-gray-400 mt-0.5">{s.name}</div>}
                                {s.fetch_ticker_override && (
                                  <span className="text-xs text-purple-500 font-mono">↗{s.fetch_ticker_override}</span>
                                )}
                              </td>
                            ) : (
                              <td className="px-3 py-2.5 text-gray-600 text-sm">
                                {s.name || '—'}
                                {s.fetch_ticker_override && (
                                  <span className="ml-1.5 text-xs text-purple-500 font-mono">↗{s.fetch_ticker_override}</span>
                                )}
                              </td>
                            )}
                            <td className="px-3 py-2.5 text-xs text-gray-500">{s.asset_class}</td>
                            <td className="px-3 py-2.5 text-xs text-gray-500">{s.exchange || '—'}</td>
                            <td className="px-3 py-2.5 text-xs">{s.currency || '—'}</td>
                            <td className="px-3 py-2.5 text-right">
                              <span className={`text-xs font-medium px-1.5 py-0.5 rounded ${
                                s.transaction_count === 0 ? 'text-gray-400 bg-gray-100' :
                                s.transaction_count >= 10 ? 'text-blue-700 bg-blue-50' : 'text-gray-700'
                              }`}>
                                {s.transaction_count}
                              </span>
                            </td>
                            <td className="px-3 py-2.5 text-right">
                              <div className="flex gap-2 justify-end items-center">
                                <button onClick={() => { setEditing(s.id); setEditData({}); setUpdateError(null) }} className="text-blue-500 hover:text-blue-700"><Edit2 className="h-3.5 w-3.5" /></button>
                                <button
                                  onClick={() => openYahooPicker(s)}
                                  title="Search Yahoo Finance to pick the correct security"
                                  className="text-purple-400 hover:text-purple-600"
                                >
                                  <Sparkles className="h-3.5 w-3.5" />
                                </button>
                                <button
                                  onClick={() => fetchHistMut.mutate(s.id)}
                                  disabled={histFetchStatus[s.id] === 'pending'}
                                  title="Re-download price history for this security from Yahoo Finance"
                                  className={`transition-colors disabled:opacity-40 ${
                                    histFetchStatus[s.id] === 'ok' ? 'text-green-500' :
                                    histFetchStatus[s.id] === 'err' ? 'text-red-500' :
                                    'text-gray-400 hover:text-blue-500'
                                  }`}
                                >
                                  <RefreshCw className={`h-3.5 w-3.5 ${histFetchStatus[s.id] === 'pending' ? 'animate-spin' : ''}`} />
                                </button>
                                <button onClick={() => setDeleteId(s.id)} className="text-red-400 hover:text-red-600"><Trash2 className="h-3.5 w-3.5" /></button>
                              </div>
                            </td>
                          </>
                        )}
                      </tr>
                    )
                  })}
                  {pageRows.length === 0 && (
                    <tr><td colSpan={7} className="px-3 py-8 text-center text-sm text-gray-400">No securities match the current filters.</td></tr>
                  )}
                  <tr>
                    <td colSpan={7} className="px-3 py-2 border-t border-gray-200 bg-gray-50">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2 text-xs text-gray-500">
                          <span>Rows per page:</span>
                          <select className="border rounded px-2 py-0.5 text-xs" value={pageSize}
                            onChange={e => { setPageSize(Number(e.target.value)); setPage(1) }}>
                            <option value={25}>25</option>
                            <option value={50}>50</option>
                            <option value={100}>100</option>
                          </select>
                        </div>
                        <div className="flex items-center gap-3 text-xs text-gray-500">
                          <span>
                            {totalFiltered === 0 ? '0' : `${(safePage - 1) * pageSize + 1}–${Math.min(safePage * pageSize, totalFiltered)}`} of {totalFiltered}
                          </span>
                          <button
                            disabled={safePage <= 1}
                            onClick={() => setPage(p => Math.max(1, p - 1))}
                            className="px-2 py-0.5 border rounded text-xs disabled:opacity-40 hover:bg-gray-100"
                          >Prev</button>
                          <span>Page {safePage} of {totalPages}</span>
                          <button
                            disabled={safePage >= totalPages}
                            onClick={() => setPage(p => p + 1)}
                            className="px-2 py-0.5 border rounded text-xs disabled:opacity-40 hover:bg-gray-100"
                          >Next</button>
                        </div>
                      </div>
                    </td>
                  </tr>
                </>
              )
            })()}
          </tbody>
        </table>
      </div>

      {/* Shared datalist for exchange autocomplete */}
      <datalist id="exchange-options">
        <option value="NYSE" />
        <option value="NASDAQ" />
        <option value="TSX" />
        <option value="TSX-V" />
        <option value="AMEX" />
        <option value="ARCA" />
        <option value="OTC" />
        <option value="CBOE" />
      </datalist>

      {/* Yahoo Finance Picker Modal */}
      {yahooPicker && (() => {
        const pickerSec = (securities as Security[]).find(s => s.id === yahooPicker.secId)
        return (
          <div className="fixed inset-0 z-50 flex items-start justify-center pt-24 bg-black/30" onClick={() => setYahooPicker(null)}>
            <div className="bg-white rounded-xl shadow-2xl w-[520px] max-h-[480px] flex flex-col" onClick={e => e.stopPropagation()}>
              {/* Header */}
              <div className="flex items-center justify-between px-4 py-3 border-b">
                <div className="flex items-center gap-2">
                  <Sparkles className="h-4 w-4 text-purple-500" />
                  <span className="font-semibold text-sm text-gray-800">
                    Yahoo Finance — {pickerSec?.ticker}
                  </span>
                </div>
                <button onClick={() => setYahooPicker(null)} className="text-gray-400 hover:text-gray-600"><X className="h-4 w-4" /></button>
              </div>

              {/* Search box */}
              <div className="px-4 py-2 border-b flex gap-2 items-center">
                <Search className="h-4 w-4 text-gray-400 shrink-0" />
                <input
                  ref={yahooInputRef}
                  className="flex-1 text-sm outline-none"
                  placeholder="Search ticker or company name…"
                  value={yahooPicker.query}
                  onChange={e => setYahooPicker(p => p ? { ...p, query: e.target.value } : p)}
                  onKeyDown={e => { if (e.key === 'Enter') runYahooSearch(yahooPicker.query) }}
                />
                <button
                  onClick={() => runYahooSearch(yahooPicker.query)}
                  disabled={yahooPicker.loading}
                  className="text-xs bg-purple-100 text-purple-700 px-2 py-1 rounded hover:bg-purple-200 disabled:opacity-50"
                >
                  {yahooPicker.loading ? '…' : 'Search'}
                </button>
              </div>

              {/* Results */}
              <div className="overflow-y-auto flex-1">
                {yahooPicker.loading && (
                  <div className="text-center text-gray-400 text-sm py-6">Searching Yahoo Finance…</div>
                )}
                {yahooPicker.error && (
                  <div className="text-center text-red-500 text-sm py-6">{yahooPicker.error}</div>
                )}
                {!yahooPicker.loading && !yahooPicker.error && yahooPicker.results.length === 0 && (
                  <div className="text-center text-gray-400 text-sm py-6">No results</div>
                )}
                {yahooPicker.results.map(r => (
                  <button
                    key={r.symbol}
                    onClick={() => {
                      setYahooPicker(p => p ? { ...p, loading: true, applyMsg: null } : p)
                      fetchYahooMut.mutate({ id: yahooPicker.secId, symbol: r.symbol })
                    }}
                    className="w-full text-left px-4 py-2.5 hover:bg-purple-50 border-b border-gray-50 flex items-center gap-3"
                  >
                    <div className="w-20 shrink-0">
                      <span className="font-mono font-semibold text-sm text-blue-700">{r.symbol}</span>
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="text-sm text-gray-800 truncate">{r.name || '—'}</div>
                      <div className="text-xs text-gray-400">{r.quote_type}</div>
                    </div>
                    <div className="text-right shrink-0">
                      <div className="text-xs font-medium text-gray-600">{r.exchange || '—'}</div>
                      <div className="text-xs text-gray-400">{r.currency}</div>
                    </div>
                  </button>
                ))}
              </div>

              {/* Apply result feedback */}
              {yahooPicker.applyMsg && (
                <div className={`px-4 py-2 text-xs border-t ${
                  yahooPicker.applyMsg.startsWith('✓') ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-600'
                } flex justify-between items-center`}>
                  <span>{yahooPicker.applyMsg}</span>
                  <button onClick={() => setYahooPicker(null)} className="text-xs underline ml-4">Close</button>
                </div>
              )}
            </div>
          </div>
        )
      })()}
    </div>
  )
}

// ─── Brokerages Tab ────────────────────────────────────────────────────────────
const EMPTY_BROKERAGE = { name: '', code: '', active: true, advisor: '' }

function BrokeragesTab() {
  const qc = useQueryClient()
  const { data: brokerages = [] } = useQuery({ queryKey: ['brokerages'], queryFn: getBrokerages })
  const [deleteId, setDeleteId] = useState<number | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [showForm, setShowForm] = useState(false)
  const [form, setForm] = useState(EMPTY_BROKERAGE)
  const [editingId, setEditingId] = useState<number | null>(null)
  const [editData, setEditData] = useState(EMPTY_BROKERAGE)
  const { sort, toggle } = useSortState('name')

  const invalidate = () => qc.invalidateQueries({ queryKey: ['brokerages'] })

  const createMut = useMutation({
    mutationFn: createBrokerage,
    onSuccess: () => { invalidate(); setShowForm(false); setForm(EMPTY_BROKERAGE); setError(null) },
    onError: (err: { response?: { data?: { detail?: string } } }) =>
      setError(err?.response?.data?.detail || 'Cannot create brokerage'),
  })

  const updateMut = useMutation({
    mutationFn: ({ id, data }: { id: number; data: Partial<Brokerage> }) => updateBrokerage(id, data),
    onSuccess: () => { invalidate(); setEditingId(null); setError(null) },
    onError: (err: { response?: { data?: { detail?: string } } }) =>
      setError(err?.response?.data?.detail || 'Cannot update brokerage'),
  })

  const deleteMut = useMutation({
    mutationFn: deleteBrokerage,
    onSuccess: () => { invalidate(); setDeleteId(null) },
    onError: (err: { response?: { data?: { detail?: string } } }) => {
      setError(err?.response?.data?.detail || 'Cannot delete brokerage')
      setDeleteId(null)
    },
  })

  const startEdit = (b: Brokerage) => {
    setEditingId(b.id)
    setEditData({ name: b.name, code: b.code, active: b.active, advisor: b.advisor || '' })
    setError(null)
  }

  return (
    <div className="space-y-4">
      {deleteId && (
        <ConfirmDialog
          title="Delete Brokerage"
          message="Delete this brokerage? Brokerages with accounts cannot be deleted — delete accounts first."
          onConfirm={() => deleteMut.mutate(deleteId)}
          onCancel={() => setDeleteId(null)}
        />
      )}
      {error && (
        <div className="bg-red-50 border border-red-200 rounded p-3 text-sm text-red-700 flex justify-between">
          <span>{error}</span>
          <button onClick={() => setError(null)}><X className="h-4 w-4" /></button>
        </div>
      )}

      {/* New brokerage form */}
      {showForm ? (
        <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 space-y-3">
          <h3 className="font-semibold text-sm text-blue-800">New Brokerage</h3>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <div>
              <label className="block text-xs text-gray-500 mb-1">Name *</label>
              <input className="w-full border border-gray-300 rounded px-2 py-1.5 text-sm" placeholder="e.g. TD Direct Investing"
                value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} />
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1">Code * <span className="text-gray-400">(unique short id)</span></label>
              <input className="w-full border border-gray-300 rounded px-2 py-1.5 text-sm font-mono" placeholder="e.g. TDDI"
                value={form.code} onChange={e => setForm(f => ({ ...f, code: e.target.value.toUpperCase() }))} />
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1">Advisor</label>
              <input className="w-full border border-gray-300 rounded px-2 py-1.5 text-sm" placeholder="e.g. John Smith"
                value={form.advisor} onChange={e => setForm(f => ({ ...f, advisor: e.target.value }))} />
            </div>
            <div>
              <label className="block text-xs text-gray-500 mb-1">Active</label>
              <select className="w-full border border-gray-300 rounded px-2 py-1.5 text-sm"
                value={form.active ? 'true' : 'false'} onChange={e => setForm(f => ({ ...f, active: e.target.value === 'true' }))}>
                <option value="true">Yes</option>
                <option value="false">No</option>
              </select>
            </div>
          </div>
          <div className="flex gap-2">
            <button
              onClick={() => createMut.mutate({ ...form, advisor: form.advisor || null })}
              disabled={!form.name.trim() || !form.code.trim() || createMut.isPending}
              className="px-4 py-1.5 bg-blue-600 text-white rounded text-sm hover:bg-blue-700 disabled:opacity-50">
              {createMut.isPending ? 'Saving…' : 'Save'}
            </button>
            <button onClick={() => { setShowForm(false); setForm(EMPTY_BROKERAGE); setError(null) }}
              className="px-4 py-1.5 border border-gray-300 rounded text-sm hover:bg-gray-50">Cancel</button>
          </div>
        </div>
      ) : (
        <button onClick={() => setShowForm(true)}
          className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg text-sm hover:bg-blue-700">
          <Plus className="h-4 w-4" /> New Brokerage
        </button>
      )}

      <div className="overflow-x-auto rounded-lg border border-gray-200">
        <table className="min-w-full text-sm divide-y divide-gray-100">
          <thead className="bg-gray-50">
            <tr className="text-xs text-gray-500 uppercase">
              <SortTh label="Name" col="name" sort={sort} toggle={toggle} className="px-3 py-3 text-left" />
              <SortTh label="Code" col="code" sort={sort} toggle={toggle} className="px-3 py-3 text-left" />
              <SortTh label="Advisor" col="advisor" sort={sort} toggle={toggle} className="px-3 py-3 text-left" />
              <SortTh label="Active" col="active" sort={sort} toggle={toggle} className="px-3 py-3 text-left" />
              <th className="px-3 py-3 text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-50">
            {sortRows(brokerages, sort.col, sort.dir).map(b => (
              editingId === b.id ? (
                <tr key={b.id} className="bg-yellow-50">
                  <td className="px-3 py-2">
                    <input className="w-full border border-gray-300 rounded px-2 py-1 text-sm"
                      value={editData.name} onChange={e => setEditData(d => ({ ...d, name: e.target.value }))} />
                  </td>
                  <td className="px-3 py-2">
                    <input className="w-28 border border-gray-300 rounded px-2 py-1 text-sm font-mono"
                      value={editData.code} onChange={e => setEditData(d => ({ ...d, code: e.target.value.toUpperCase() }))} />
                  </td>
                  <td className="px-3 py-2">
                    <input className="w-full border border-gray-300 rounded px-2 py-1 text-sm"
                      value={editData.advisor} onChange={e => setEditData(d => ({ ...d, advisor: e.target.value }))} />
                  </td>
                  <td className="px-3 py-2">
                    <select className="border border-gray-300 rounded px-2 py-1 text-sm"
                      value={editData.active ? 'true' : 'false'} onChange={e => setEditData(d => ({ ...d, active: e.target.value === 'true' }))}>
                      <option value="true">Yes</option>
                      <option value="false">No</option>
                    </select>
                  </td>
                  <td className="px-3 py-2 text-right">
                    <div className="flex items-center justify-end gap-2">
                      <button onClick={() => updateMut.mutate({ id: b.id, data: { ...editData, advisor: editData.advisor || null } })}
                        disabled={updateMut.isPending}
                        className="text-xs px-2 py-1 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50">
                        {updateMut.isPending ? '…' : 'Save'}
                      </button>
                      <button onClick={() => setEditingId(null)} className="text-xs px-2 py-1 border rounded hover:bg-gray-50">Cancel</button>
                    </div>
                  </td>
                </tr>
              ) : (
                <tr key={b.id} className="hover:bg-gray-50">
                  <td className="px-3 py-2.5 font-medium">{b.name}</td>
                  <td className="px-3 py-2.5 font-mono text-xs text-gray-500">{b.code}</td>
                  <td className="px-3 py-2.5 text-xs text-gray-600">{b.advisor || <span className="text-gray-300">—</span>}</td>
                  <td className="px-3 py-2.5">
                    <span className={`text-xs font-medium ${b.active ? 'text-green-600' : 'text-gray-400'}`}>{b.active ? 'Yes' : 'No'}</span>
                  </td>
                  <td className="px-3 py-2.5 text-right">
                    <div className="flex items-center justify-end gap-2">
                      <button onClick={() => startEdit(b)} className="text-blue-400 hover:text-blue-600">
                        <Pencil className="h-3.5 w-3.5" />
                      </button>
                      <button onClick={() => setDeleteId(b.id)} className="text-red-400 hover:text-red-600">
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </td>
                </tr>
              )
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ─── Type Mappings Tab ────────────────────────────────────────────────────────
function TypeMappingsTab() {
  const qc = useQueryClient()
  const { data: mappings = [] } = useQuery({ queryKey: ['type-mappings'], queryFn: getTypeMappings })
  const { data: brokerages = [] } = useQuery({ queryKey: ['brokerages'], queryFn: getBrokerages })
  const [form, setForm] = useState({ brokerage_id: '', raw_type: '', canonical_type: 'BUY' })
  const [editingMapping, setEditingMapping] = useState<{ id: number; canonical_type: string } | null>(null)
  const { sort, toggle } = useSortState('raw_type')

  const CANONICAL_TYPES = [
    'BUY', 'SELL', 'DIVIDEND', 'DRIP', 'RETURN_OF_CAPITAL',
    'OPTION_BUY', 'OPTION_SELL', 'OPTION_EXPIRY', 'OPTION_ASSIGNMENT', 'OPTION_EXERCISE',
    'TRANSFER_IN', 'TRANSFER_OUT', 'JOURNAL', 'FX_CONVERSION', 'FX_ADJUSTMENT',
    'SPLIT', 'REVERSE_SPLIT', 'MERGER', 'SPINOFF', 'INTEREST', 'FEE', 'WITHHOLDING_TAX',
    'DEPOSIT', 'WITHDRAWAL', 'OPENING_BALANCE', 'ADJUSTMENT', 'OTHER',
  ]

  const createMut = useMutation({
    mutationFn: () => createTypeMapping({ brokerage_id: Number(form.brokerage_id), raw_type: form.raw_type, canonical_type: form.canonical_type }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['type-mappings'] }); setForm(f => ({ ...f, raw_type: '' })) },
  })
  const updateMappingMut = useMutation({
    mutationFn: ({ id, canonical_type }: { id: number; canonical_type: string }) =>
      updateTypeMapping(id, { canonical_type } as Partial<TypeMapping>),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['type-mappings'] }); setEditingMapping(null) },
  })
  const deleteMut = useMutation({
    mutationFn: deleteTypeMapping,
    onSuccess: () => qc.invalidateQueries({ queryKey: ['type-mappings'] }),
  })

  const grouped = (mappings as TypeMapping[]).reduce<Record<string, TypeMapping[]>>((acc, m) => {
    const key = m.brokerage_name || 'Unknown'
    if (!acc[key]) acc[key] = []
    acc[key].push(m)
    return acc
  }, {})

  return (
    <div className="space-y-4">
      <div className="bg-gray-50 rounded-lg p-4 border border-gray-200">
        <h3 className="font-medium text-gray-700 mb-3">Add Mapping</h3>
        <div className="flex flex-wrap gap-3">
          <select className="border rounded px-3 py-1.5 text-sm" value={form.brokerage_id}
            onChange={e => setForm(f => ({ ...f, brokerage_id: e.target.value }))}>
            <option value="">Select brokerage</option>
            {brokerages.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select>
          <input className="border rounded px-3 py-1.5 text-sm w-40" placeholder="Raw type (e.g. BUY)" value={form.raw_type}
            onChange={e => setForm(f => ({ ...f, raw_type: e.target.value }))} />
          <select className="border rounded px-3 py-1.5 text-sm" value={form.canonical_type}
            onChange={e => setForm(f => ({ ...f, canonical_type: e.target.value }))}>
            {CANONICAL_TYPES.map(t => <option key={t}>{t}</option>)}
          </select>
          <button onClick={() => createMut.mutate()} disabled={!form.brokerage_id || !form.raw_type}
            className="bg-blue-600 text-white text-sm px-4 py-1.5 rounded disabled:opacity-40">Add</button>
        </div>
      </div>
      {Object.entries(grouped).map(([brokerageName, bMappings]) => (
        <div key={brokerageName} className="overflow-x-auto rounded-lg border border-gray-200">
          <div className="px-3 py-2 bg-gray-50 text-xs font-semibold text-gray-600 uppercase border-b">{brokerageName}</div>
          <table className="min-w-full text-sm divide-y divide-gray-100">
            <thead className="bg-gray-50">
              <tr className="text-xs text-gray-500 uppercase">
                <SortTh label="Raw Type" col="raw_type" sort={sort} toggle={toggle} className="px-3 py-2 text-left" />
                <SortTh label="→ Canonical Type" col="canonical_type" sort={sort} toggle={toggle} className="px-3 py-2 text-left" />
                <th className="px-3 py-2 text-right w-20">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {sortRows(bMappings, sort.col, sort.dir).map(m => (
                <tr key={m.id} className="hover:bg-gray-50">
                  <td className="px-3 py-2 font-mono text-xs">{m.raw_type}</td>
                  <td className="px-3 py-2">
                    {editingMapping?.id === m.id ? (
                      <div className="flex items-center gap-1">
                        <select
                          autoFocus
                          className="border rounded px-2 py-0.5 text-xs"
                          value={editingMapping.canonical_type}
                          onChange={e => setEditingMapping({ id: m.id, canonical_type: e.target.value })}
                        >
                          {CANONICAL_TYPES.map(t => <option key={t}>{t}</option>)}
                        </select>
                        <button onClick={() => updateMappingMut.mutate({ id: m.id, canonical_type: editingMapping.canonical_type })}
                          className="text-green-600 hover:text-green-700"><Check className="h-3.5 w-3.5" /></button>
                        <button onClick={() => setEditingMapping(null)}
                          className="text-gray-400 hover:text-gray-600"><X className="h-3.5 w-3.5" /></button>
                      </div>
                    ) : (
                      <span className="px-1.5 py-0.5 bg-blue-50 text-blue-700 rounded text-xs">{m.canonical_type}</span>
                    )}
                  </td>
                  <td className="px-3 py-2 text-right">
                    <div className="flex gap-2 justify-end">
                      {editingMapping?.id !== m.id && (
                        <button onClick={() => setEditingMapping({ id: m.id, canonical_type: m.canonical_type })}
                          className="text-blue-400 hover:text-blue-600"><Edit2 className="h-3.5 w-3.5" /></button>
                      )}
                      <button onClick={() => deleteMut.mutate(m.id)} className="text-red-400 hover:text-red-600">
                        <Trash2 className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
    </div>
  )
}

// ─── FX Rates Tab ─────────────────────────────────────────────────────────────
function FxRatesTab() {
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
          className="bg-blue-600 text-white text-sm px-4 py-2 rounded disabled:opacity-40 flex items-center gap-2"
        >
          {refreshMut.isPending && <span className="animate-spin rounded-full h-3.5 w-3.5 border-b-2 border-white" />}
          Refresh from Bank of Canada
        </button>
        {refreshMut.isSuccess && (
          <span className="text-sm text-green-600">
            Added {(refreshMut.data as { added?: number })?.added ?? 0} new rates
          </span>
        )}
        <select className="border rounded px-3 py-1.5 text-sm ml-auto" value={limit}
          onChange={e => setLimit(Number(e.target.value))}>
          <option value={50}>50 rates</option>
          <option value={100}>100 rates</option>
          <option value={500}>500 rates</option>
        </select>
      </div>
      <div className="overflow-x-auto rounded-lg border border-gray-200">
        <table className="min-w-full text-sm divide-y divide-gray-100">
          <thead className="bg-gray-50">
            <tr className="text-xs text-gray-500 uppercase">
              <SortTh label="Date" col="rate_date" sort={sort} toggle={toggle} className="px-3 py-3 text-left" />
              <SortTh label="Pair" col="from_currency" sort={sort} toggle={toggle} className="px-3 py-3 text-left" />
              <SortTh label="Rate" col="rate" sort={sort} toggle={toggle} className="px-3 py-3 text-right" />
              <SortTh label="Source" col="source" sort={sort} toggle={toggle} className="px-3 py-3 text-left" />
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-50">
            {isLoading ? (
              <tr><td colSpan={4} className="px-3 py-8 text-center text-gray-400">Loading...</td></tr>
            ) : sortRows(rates as FXRate[], sort.col, sort.dir).map(r => (
              <tr key={r.id}>
                <td className="px-3 py-2.5">{r.rate_date}</td>
                <td className="px-3 py-2.5 font-mono text-xs">{r.from_currency}/{r.to_currency}</td>
                <td className="px-3 py-2.5 text-right font-mono">{parseFloat(r.rate).toFixed(6)}</td>
                <td className="px-3 py-2.5 text-xs text-gray-400">{r.source}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

// ─── Danger Zone Tab ──────────────────────────────────────────────────────────
function DangerZoneTab() {
  const qc = useQueryClient()
  const { data: accounts = [] } = useQuery({ queryKey: ['accounts'], queryFn: getAccounts })
  const [confirm, setConfirm] = useState<{
    type: 'all-transactions' | 'account-transactions' | 'all-imports'
    accountId?: number
    accountName?: string
  } | null>(null)
  const [result, setResult] = useState<string | null>(null)

  const deleteAllTxnsMut = useMutation({
    mutationFn: () => deleteAllTransactions(confirm?.accountId),
    onSuccess: (data: { deleted_count: number }) => {
      qc.invalidateQueries({ queryKey: ['transactions'] })
      qc.invalidateQueries({ queryKey: ['positions'] })
      qc.invalidateQueries({ queryKey: ['portfolio-summary'] })
      setResult(`✅ Deleted ${data.deleted_count} transactions`)
      setConfirm(null)
    },
  })

  const deleteAllImportsMut = useMutation({
    mutationFn: deleteAllImports,
    onSuccess: (data: { batches_deleted: number; rows_deleted: number }) => {
      qc.invalidateQueries({ queryKey: ['imports'] })
      setResult(`✅ Deleted ${data.batches_deleted} import batches and ${data.rows_deleted} raw rows`)
      setConfirm(null)
    },
  })

  return (
    <div className="space-y-6">
      {confirm && (
        <ConfirmDialog
          title={
            confirm.type === 'all-transactions' ? 'Delete ALL Transactions' :
            confirm.type === 'account-transactions' ? `Delete All Transactions for ${confirm.accountName}` :
            'Delete All Import History'
          }
          message={
            confirm.type === 'all-transactions'
              ? 'This will permanently delete EVERY transaction across all accounts. All positions, P&L, and import history references will be lost. This cannot be undone.'
              : confirm.type === 'account-transactions'
              ? `This will delete all transactions for account "${confirm.accountName}". This cannot be undone.`
              : 'This will delete all import batches and raw transaction rows. Committed transactions are NOT affected — only the import log is cleared.'
          }
          confirmLabel={confirm.type === 'all-transactions' ? 'Delete Everything' : 'Confirm Delete'}
          requireTyping={confirm.type === 'all-transactions' ? 'DELETE ALL' : undefined}
          onConfirm={() => {
            if (confirm.type === 'all-imports') deleteAllImportsMut.mutate()
            else deleteAllTxnsMut.mutate()
          }}
          onCancel={() => setConfirm(null)}
        />
      )}

      <div className="bg-red-50 border border-red-200 rounded-lg p-4">
        <div className="flex items-start gap-2 mb-3">
          <AlertTriangle className="h-5 w-5 text-red-600 flex-shrink-0 mt-0.5" />
          <div>
            <h3 className="font-semibold text-red-800">Danger Zone</h3>
            <p className="text-sm text-red-700 mt-1">These actions are irreversible. Use them to reset test data before loading real data.</p>
          </div>
        </div>
      </div>

      {result && (
        <div className="bg-green-50 border border-green-200 rounded p-3 text-sm text-green-700 flex justify-between">
          <span>{result}</span>
          <button onClick={() => setResult(null)}><X className="h-4 w-4" /></button>
        </div>
      )}

      <div className="space-y-4">
        {/* Delete all transactions */}
        <div className="border border-red-200 rounded-lg p-4 bg-white">
          <h4 className="font-medium text-gray-800 mb-1">Delete All Transactions</h4>
          <p className="text-sm text-gray-500 mb-3">Removes every transaction from every account. Use to reset before loading real data.</p>
          <button
            onClick={() => setConfirm({ type: 'all-transactions' })}
            className="bg-red-600 text-white text-sm px-4 py-2 rounded hover:bg-red-700 flex items-center gap-2"
          >
            <Trash2 className="h-4 w-4" /> Delete All Transactions
          </button>
        </div>

        {/* Delete transactions by account */}
        <div className="border border-orange-200 rounded-lg p-4 bg-white">
          <h4 className="font-medium text-gray-800 mb-1">Delete Transactions for One Account</h4>
          <p className="text-sm text-gray-500 mb-3">Removes all transactions for a specific account only.</p>
          <div className="flex gap-3 items-center">
            <select className="border rounded px-3 py-1.5 text-sm flex-1 max-w-xs" id="danger-account">
              <option value="">Select account…</option>
              {(accounts as Account[]).map(a => <option key={a.id} value={`${a.id}|${a.name}`}>{a.name}</option>)}
            </select>
            <button
              onClick={() => {
                const sel = (document.getElementById('danger-account') as HTMLSelectElement).value
                if (!sel) return
                const [id, name] = sel.split('|')
                setConfirm({ type: 'account-transactions', accountId: Number(id), accountName: name })
              }}
              className="bg-orange-600 text-white text-sm px-4 py-2 rounded hover:bg-orange-700 flex items-center gap-2"
            >
              <Trash2 className="h-4 w-4" /> Delete Account Transactions
            </button>
          </div>
        </div>

        {/* Delete all imports */}
        <div className="border border-yellow-200 rounded-lg p-4 bg-white">
          <h4 className="font-medium text-gray-800 mb-1">Clear Import History</h4>
          <p className="text-sm text-gray-500 mb-3">Deletes all import batches and raw rows. Does NOT delete committed transactions.</p>
          <button
            onClick={() => setConfirm({ type: 'all-imports' })}
            className="bg-yellow-600 text-white text-sm px-4 py-2 rounded hover:bg-yellow-700 flex items-center gap-2"
          >
            <Trash2 className="h-4 w-4" /> Clear Import History
          </button>
        </div>
      </div>
    </div>
  )
}


// ─── System Tab ───────────────────────────────────────────────────────────────
type RestartStatus = 'idle' | 'restarting' | 'online' | 'error'

function SystemTab() {
  const queryClient = useQueryClient()
  const [restartStatus, setRestartStatus] = useState<RestartStatus>('idle')
  const [lastChecked, setLastChecked] = useState<string | null>(null)
  const [optimizing, setOptimizing] = useState(false)
  const [optimizeMsg, setOptimizeMsg] = useState<string | null>(null)

  // Change password state
  const [pwCurrent,  setPwCurrent]  = useState('')
  const [pwNew,      setPwNew]      = useState('')
  const [pwConfirm,  setPwConfirm]  = useState('')
  const [pwLoading,  setPwLoading]  = useState(false)
  const [pwError,    setPwError]    = useState<string | null>(null)
  const [pwSuccess,  setPwSuccess]  = useState(false)

  const handleChangePassword = async (e: React.FormEvent) => {
    e.preventDefault()
    setPwError(null)
    setPwSuccess(false)
    if (pwNew.length < 8) { setPwError('New password must be at least 8 characters.'); return }
    if (pwNew !== pwConfirm) { setPwError('New passwords do not match.'); return }
    setPwLoading(true)
    try {
      await changePassword({ current_password: pwCurrent, new_password: pwNew })
      setPwSuccess(true)
      setPwCurrent(''); setPwNew(''); setPwConfirm('')
    } catch (err: any) {
      setPwError(err.response?.data?.detail ?? 'Password change failed.')
    } finally {
      setPwLoading(false)
    }
  }

  const { data: health, refetch: recheckHealth } = useQuery({
    queryKey: ['system-health'],
    queryFn: getSystemHealth,
    refetchInterval: 30_000,
  })

  const handleRestart = async () => {
    setRestartStatus('restarting')
    try {
      await restartBackend()
    } catch {
      // Connection drop is expected as the server restarts
    }
    // Poll /api/system/health until the backend comes back up
    for (let i = 0; i < 30; i++) {
      await new Promise(r => setTimeout(r, 1000))
      try {
        await getSystemHealth()
        setRestartStatus('online')
        setLastChecked(new Date().toLocaleTimeString())
        queryClient.invalidateQueries()
        return
      } catch {
        // Still restarting — keep polling
      }
    }
    setRestartStatus('error')
  }

  const handleReload = () => window.location.reload()

  const { data: dbStats, refetch: refetchDbStats } = useQuery<DbStats>({
    queryKey: ['db-stats'],
    queryFn: getDbStats,
    staleTime: 60_000,
  })

  const handleOptimize = async () => {
    setOptimizing(true)
    setOptimizeMsg(null)
    try {
      const result = await optimizeDb()
      setOptimizeMsg(result.message)
      refetchDbStats()
    } catch {
      setOptimizeMsg('Optimize failed — check backend logs.')
    } finally {
      setOptimizing(false)
    }
  }

  return (
    <div className="p-6 space-y-6 max-w-2xl">
      <div>
        <h2 className="text-lg font-semibold text-gray-800">System Controls</h2>
        <p className="text-sm text-gray-500 mt-1">Restart the backend server after updates, or reload the page to clear cached data.</p>
      </div>

      {/* Status card */}
      <div className="bg-white border border-gray-200 rounded-xl p-5 flex items-center gap-4">
        <div className={`h-3 w-3 rounded-full flex-shrink-0 ${
          restartStatus === 'restarting' ? 'bg-yellow-400 animate-pulse' :
          restartStatus === 'error'      ? 'bg-red-500' :
          health                         ? 'bg-emerald-500' : 'bg-gray-300'
        }`} />
        <div>
          <p className="font-medium text-gray-800">
            {restartStatus === 'restarting' ? 'Restarting backend…' :
             restartStatus === 'error'      ? 'Backend did not come back — check the terminal' :
             restartStatus === 'online'     ? `Backend restarted successfully` :
             health                         ? 'Backend is running' : 'Checking…'}
          </p>
          {restartStatus === 'online' && lastChecked && (
            <p className="text-xs text-gray-400">Came back online at {lastChecked}</p>
          )}
          {health && restartStatus === 'idle' && (
            <p className="text-xs text-gray-400">Last checked {new Date(health.timestamp).toLocaleTimeString()}</p>
          )}
        </div>
        <button
          onClick={() => { recheckHealth(); setRestartStatus('idle') }}
          className="ml-auto text-xs text-gray-400 hover:text-gray-600 flex items-center gap-1"
        >
          <RefreshCw className="h-3.5 w-3.5" /> Refresh status
        </button>
      </div>

      {/* Action cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">

        {/* Restart backend */}
        <div className="bg-white border border-gray-200 rounded-xl p-5 space-y-3">
          <div className="flex items-center gap-2">
            <Power className="h-5 w-5 text-gray-400" />
            <h3 className="font-semibold text-gray-800">Restart Backend</h3>
          </div>
          <p className="text-sm text-gray-500">
            Use the <strong>Render dashboard</strong> to restart or redeploy the backend service. In-process restarts are not supported in cloud deployments.
          </p>
          <a
            href="https://dashboard.render.com"
            target="_blank"
            rel="noopener noreferrer"
            className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg bg-gray-100 text-gray-700 text-sm font-medium hover:bg-gray-200 transition-colors"
          >
            <Power className="h-4 w-4" /> Open Render Dashboard
          </a>
        </div>

        {/* Reload page */}
        <div className="bg-white border border-gray-200 rounded-xl p-5 space-y-3">
          <div className="flex items-center gap-2">
            <RotateCcw className="h-5 w-5 text-gray-600" />
            <h3 className="font-semibold text-gray-800">Reload Page</h3>
          </div>
          <p className="text-sm text-gray-500">
            Clear all cached data and reload the app — useful if charts or tables look out of date.
          </p>
          <button
            onClick={handleReload}
            className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg bg-gray-700 text-white text-sm font-medium hover:bg-gray-800 transition-colors"
          >
            <RotateCcw className="h-4 w-4" /> Reload Page
          </button>
        </div>

        {/* Change password */}
        <div className="bg-white border border-gray-200 rounded-xl p-5 space-y-3 sm:col-span-2">
          <div className="flex items-center gap-2">
            <KeyRound className="h-5 w-5 text-blue-600" />
            <h3 className="font-semibold text-gray-800">Change Password</h3>
          </div>
          <form onSubmit={handleChangePassword} className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Current password</label>
              <input
                type="password"
                value={pwCurrent}
                onChange={e => setPwCurrent(e.target.value)}
                required
                className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                placeholder="••••••••"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">New password</label>
              <input
                type="password"
                value={pwNew}
                onChange={e => setPwNew(e.target.value)}
                required
                minLength={8}
                className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                placeholder="Min 8 characters"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Confirm new password</label>
              <input
                type="password"
                value={pwConfirm}
                onChange={e => setPwConfirm(e.target.value)}
                required
                className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                placeholder="••••••••"
              />
            </div>
            {pwError && (
              <p className="sm:col-span-3 text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
                {pwError}
              </p>
            )}
            {pwSuccess && (
              <p className="sm:col-span-3 text-xs text-green-700 bg-green-50 border border-green-200 rounded-lg px-3 py-2 flex items-center gap-1.5">
                <CheckCircle className="h-3.5 w-3.5" /> Password changed successfully.
              </p>
            )}
            <div className="sm:col-span-3 flex justify-end">
              <button
                type="submit"
                disabled={pwLoading}
                className="flex items-center gap-2 px-4 py-2 rounded-lg bg-blue-600 text-white text-sm font-medium hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              >
                {pwLoading ? <><Loader2 className="h-4 w-4 animate-spin" /> Saving…</> : 'Update Password'}
              </button>
            </div>
          </form>
        </div>

      </div>

      {/* Database section */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Database className="h-4 w-4 text-gray-500" />
            <h3 className="font-semibold text-gray-800">Database</h3>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => refetchDbStats()}
              className="text-xs text-gray-400 hover:text-gray-600 flex items-center gap-1"
            >
              <RefreshCw className="h-3.5 w-3.5" /> Refresh
            </button>
            <button
              onClick={handleOptimize}
              disabled={optimizing}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-amber-500 text-white text-xs font-medium hover:bg-amber-600 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {optimizing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Zap className="h-3.5 w-3.5" />}
              {optimizing ? 'Optimizing…' : 'Optimize DB'}
            </button>
          </div>
        </div>

        {optimizeMsg && (
          <div className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
            {optimizeMsg}
          </div>
        )}

        {dbStats && (
          <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
            {/* Row counts */}
            <div className="px-4 py-2.5 border-b border-gray-100 bg-gray-50">
              <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Table Row Counts</p>
            </div>
            <div className="divide-y divide-gray-50">
              {Object.entries(dbStats.row_counts).map(([table, count]) => (
                <div key={table} className="flex items-center justify-between px-4 py-2 text-sm">
                  <span className="text-gray-600 font-mono text-xs">{table}</span>
                  <span className="font-medium text-gray-800">{count?.toLocaleString() ?? '—'}</span>
                </div>
              ))}
            </div>

            {/* DB size */}
            <div className="px-4 py-2.5 border-t border-gray-100 bg-gray-50 flex items-center justify-between text-xs text-gray-500">
              <span>DB size: <strong className="text-gray-700">{dbStats.db_size_mb} MB</strong></span>
              <span>Page: <strong className="text-gray-700">{(dbStats.page_size / 1024).toFixed(0)} KB</strong></span>
              <span>Freelist: <strong className="text-gray-700">{dbStats.freelist_count}</strong></span>
            </div>

            {/* Index status */}
            <div className="px-4 py-2.5 border-t border-gray-200 bg-gray-50">
              <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Index Status</p>
            </div>
            <div className="divide-y divide-gray-50">
              {dbStats.index_status.map(idx => (
                <div key={idx.name} className="flex items-center gap-2 px-4 py-2 text-sm">
                  <span className={`h-2 w-2 rounded-full flex-shrink-0 ${idx.present ? 'bg-emerald-500' : 'bg-red-400'}`} />
                  <span className="font-mono text-xs text-gray-600 flex-1">{idx.name}</span>
                  <span className={`text-xs font-medium ${idx.present ? 'text-emerald-600' : 'text-red-500'}`}>
                    {idx.present ? 'OK' : 'Missing'}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

// ─── Main Admin Page ──────────────────────────────────────────────────────────
// ─── Currency Split Tab ───────────────────────────────────────────────────────
function CurrencySplitTab() {
  const qc = useQueryClient()
  const { data: rawAccounts = [] } = useQuery({ queryKey: ['accounts'], queryFn: getAccounts })
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
        <h2 className="text-lg font-semibold text-gray-900">Currency Sub-Account Split</h2>
        <p className="text-sm text-gray-500 mt-1">
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

      <div className="bg-white border border-gray-200 rounded-xl p-5 space-y-4">
        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="block text-xs font-medium text-gray-500 mb-1">Source account (mixed CAD+USD)</label>
            <select
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
              value={sourceId}
              onChange={e => { setSourceId(e.target.value ? Number(e.target.value) : ''); setResult(null); setError(null) }}
            >
              <option value="">— select —</option>
              {accounts.map(a => <option key={a.id} value={a.id}>{a.name} ({a.base_currency})</option>)}
            </select>
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-500 mb-1">Target account (USD sub-account)</label>
            <select
              className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm"
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
            <label className="block text-xs font-medium text-gray-500 mb-1">Currency to move</label>
            <input
              className="border border-gray-300 rounded-lg px-3 py-2 text-sm w-28 font-mono uppercase"
              value={currency}
              onChange={e => { setCurrency(e.target.value.toUpperCase()); setResult(null); setError(null) }}
              placeholder="USD"
              maxLength={3}
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-500 mb-1">From date <span className="text-gray-400 font-normal">(optional)</span></label>
            <input
              type="date"
              className="border border-gray-300 rounded-lg px-3 py-2 text-sm"
              value={fromDate}
              onChange={e => { setFromDate(e.target.value); setResult(null); setError(null) }}
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-500 mb-1">To date <span className="text-gray-400 font-normal">(optional)</span></label>
            <input
              type="date"
              className="border border-gray-300 rounded-lg px-3 py-2 text-sm"
              value={toDate}
              onChange={e => { setToDate(e.target.value); setResult(null); setError(null) }}
            />
          </div>
        </div>

        {/* Preview */}
        {summaryLoading && <p className="text-sm text-gray-400">Loading summary…</p>}
        {summary && (
          <div className="rounded-lg border border-gray-200 overflow-hidden">
            <div className="px-4 py-2 bg-gray-50 border-b border-gray-200 text-xs font-semibold text-gray-500 uppercase tracking-wide">
              Transaction breakdown for {summary.account_name}
            </div>
            <table className="w-full text-sm">
              <thead>
                <tr className="text-xs text-gray-500 border-b border-gray-100">
                  <th className="px-4 py-2 text-left">Currency</th>
                  <th className="px-4 py-2 text-right">Count</th>
                  <th className="px-4 py-2 text-right">Earliest</th>
                  <th className="px-4 py-2 text-right">Latest</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {summary.by_currency.map(r => (
                  <tr key={r.currency} className={r.currency === currency ? 'bg-amber-50' : ''}>
                    <td className="px-4 py-2 font-mono font-medium">{r.currency}</td>
                    <td className="px-4 py-2 text-right">{r.count}</td>
                    <td className="px-4 py-2 text-right text-gray-500">{r.earliest ?? '—'}</td>
                    <td className="px-4 py-2 text-right text-gray-500">{r.latest ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {foreignCurrencies.length === 0 && (
              <p className="px-4 py-3 text-sm text-gray-400">No foreign-currency transactions found — this account may already be single-currency.</p>
            )}
          </div>
        )}

        {previewRow && (
          <div className="rounded-lg bg-blue-50 border border-blue-200 px-4 py-3 text-sm text-blue-800">
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

        {error && <p className="text-sm text-red-600">{error}</p>}
        {result && (
          <div className="rounded-lg bg-emerald-50 border border-emerald-200 px-4 py-3 text-sm text-emerald-800">
            ✓ Moved <strong>{result.moved}</strong> {currency} transactions from <em>{result.from_account}</em> to <em>{result.to_account}</em>
            {(result.from_date || result.to_date) && (
              <span className="text-emerald-600">
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
              <span className="text-sm text-gray-600">Move {previewRow?.count} transactions?</span>
              <button
                onClick={() => splitMut.mutate()}
                disabled={splitMut.isPending}
                className="px-4 py-2 bg-red-600 text-white rounded-lg text-sm font-medium hover:bg-red-700 disabled:opacity-50"
              >
                {splitMut.isPending ? 'Moving…' : 'Yes, move them'}
              </button>
              <button onClick={() => setConfirmed(false)} className="text-sm text-gray-500 hover:text-gray-700">Cancel</button>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

// ─── My Account Tab ──────────────────────────────────────────────────────────
function MyAccountTab() {
  const { user } = useAuth()
  const [pwCurrent, setPwCurrent] = useState('')
  const [pwNew,     setPwNew]     = useState('')
  const [pwConfirm, setPwConfirm] = useState('')
  const [pwLoading, setPwLoading] = useState(false)
  const [pwError,   setPwError]   = useState<string | null>(null)
  const [pwSuccess, setPwSuccess] = useState(false)
  const [showCurrent, setShowCurrent] = useState(false)
  const [showNew,     setShowNew]     = useState(false)

  const handleChangePassword = async (e: React.FormEvent) => {
    e.preventDefault()
    setPwError(null)
    setPwSuccess(false)
    if (pwNew.length < 8) { setPwError('New password must be at least 8 characters.'); return }
    if (pwNew !== pwConfirm) { setPwError('New passwords do not match.'); return }
    setPwLoading(true)
    try {
      await changePassword({ current_password: pwCurrent, new_password: pwNew })
      setPwSuccess(true)
      setPwCurrent(''); setPwNew(''); setPwConfirm('')
    } catch (err: any) {
      setPwError(err.response?.data?.detail ?? 'Password change failed.')
    } finally {
      setPwLoading(false)
    }
  }

  return (
    <div className="space-y-6 max-w-md">
      {/* User info */}
      <div className="bg-white border border-gray-200 rounded-xl p-5 space-y-2">
        <h2 className="text-sm font-semibold text-gray-700 mb-3">Account Info</h2>
        <div className="flex justify-between text-sm">
          <span className="text-gray-500">Name</span>
          <span className="font-medium text-gray-900">{user?.name}</span>
        </div>
        <div className="flex justify-between text-sm">
          <span className="text-gray-500">Email</span>
          <span className="font-medium text-gray-900">{user?.email}</span>
        </div>
        <div className="flex justify-between text-sm">
          <span className="text-gray-500">Role</span>
          <span className="font-medium text-gray-900 capitalize">{user?.role}</span>
        </div>
      </div>

      {/* Change password */}
      <div className="bg-white border border-gray-200 rounded-xl p-5">
        <h2 className="text-sm font-semibold text-gray-700 mb-4">Change Password</h2>
        <form onSubmit={handleChangePassword} className="space-y-3">
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Current Password</label>
            <div className="relative">
              <input
                type={showCurrent ? 'text' : 'password'}
                value={pwCurrent}
                onChange={e => setPwCurrent(e.target.value)}
                required
                className="w-full border rounded px-3 py-2 text-sm pr-9 focus:outline-none focus:border-blue-400"
                placeholder="Enter current password"
              />
              <button type="button" onClick={() => setShowCurrent(v => !v)}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600">
                {showCurrent ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
              </button>
            </div>
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">New Password</label>
            <div className="relative">
              <input
                type={showNew ? 'text' : 'password'}
                value={pwNew}
                onChange={e => setPwNew(e.target.value)}
                required
                className="w-full border rounded px-3 py-2 text-sm pr-9 focus:outline-none focus:border-blue-400"
                placeholder="Min 8 characters"
              />
              <button type="button" onClick={() => setShowNew(v => !v)}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600">
                {showNew ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
              </button>
            </div>
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Confirm New Password</label>
            <input
              type="password"
              value={pwConfirm}
              onChange={e => setPwConfirm(e.target.value)}
              required
              className="w-full border rounded px-3 py-2 text-sm focus:outline-none focus:border-blue-400"
              placeholder="Repeat new password"
            />
          </div>
          {pwError   && <p className="text-xs text-red-600 bg-red-50 rounded px-3 py-2">{pwError}</p>}
          {pwSuccess && <p className="text-xs text-emerald-600 bg-emerald-50 rounded px-3 py-2">✓ Password changed successfully.</p>}
          <button
            type="submit"
            disabled={pwLoading}
            className="w-full py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 font-medium"
          >
            {pwLoading ? 'Saving…' : 'Change Password'}
          </button>
        </form>
      </div>
    </div>
  )
}


// ─── Users Tab ───────────────────────────────────────────────────────────────
function UsersTab() {
  const qc = useQueryClient()
  const { data: users = [] } = useQuery({ queryKey: ['users'], queryFn: getUsers })
  const { data: clients = [] } = useQuery({ queryKey: ['clients'], queryFn: getClients })

  const [showCreate, setShowCreate] = useState(false)
  const [newEmail, setNewEmail]     = useState('')
  const [newName,  setNewName]      = useState('')
  const [newPass,  setNewPass]      = useState('')
  const [newRole,  setNewRole]      = useState('user')
  const [newClients, setNewClients] = useState<number[]>([])
  const [createErr, setCreateErr]   = useState<string | null>(null)

  // Reset password state
  const [resetUserId, setResetUserId] = useState<number | null>(null)
  const [resetPass,   setResetPass]   = useState('')
  const [resetErr,    setResetErr]    = useState<string | null>(null)

  // Edit client access state
  const [editUserId,      setEditUserId]      = useState<number | null>(null)
  const [editClientIds,   setEditClientIds]   = useState<number[]>([])

  const createMut = useMutation({
    mutationFn: createUser,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['users'] })
      setShowCreate(false)
      setNewEmail(''); setNewName(''); setNewPass(''); setNewRole('user'); setNewClients([])
      setCreateErr(null)
    },
    onError: (e: any) => setCreateErr(e.response?.data?.detail ?? 'Failed to create user'),
  })

  const toggleActiveMut = useMutation({
    mutationFn: ({ id, is_active }: { id: number; is_active: boolean }) =>
      updateUser(id, { is_active }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['users'] }),
  })

  const resetMut = useMutation({
    mutationFn: ({ id, pw }: { id: number; pw: string }) => resetUserPassword(id, pw),
    onSuccess: () => { setResetUserId(null); setResetPass(''); setResetErr(null) },
    onError: (e: any) => setResetErr(e.response?.data?.detail ?? 'Reset failed'),
  })

  const updateClientsMut = useMutation({
    mutationFn: ({ id, client_ids }: { id: number; client_ids: number[] }) =>
      updateUser(id, { client_ids }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['users'] }); setEditUserId(null) },
  })

  const toggleClientId = (arr: number[], id: number) =>
    arr.includes(id) ? arr.filter(x => x !== id) : [...arr, id]

  return (
    <div className="space-y-6 max-w-3xl">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-base font-semibold text-gray-900">User Management</h2>
          <p className="text-xs text-gray-500 mt-0.5">Create users and control which clients they can access.</p>
        </div>
        <button
          onClick={() => { setShowCreate(true); setCreateErr(null) }}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-blue-600 text-white rounded-lg hover:bg-blue-700 font-medium"
        >
          <UserPlus className="h-3.5 w-3.5" />
          New User
        </button>
      </div>

      {/* Create form */}
      {showCreate && (
        <div className="border border-blue-200 bg-blue-50 rounded-xl p-4 space-y-3">
          <h3 className="text-sm font-semibold text-blue-900">Create New User</h3>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Name</label>
              <input value={newName} onChange={e => setNewName(e.target.value)}
                className="w-full border rounded px-2.5 py-1.5 text-sm focus:outline-none focus:border-blue-400"
                placeholder="Full Name" />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Email</label>
              <input value={newEmail} onChange={e => setNewEmail(e.target.value)}
                className="w-full border rounded px-2.5 py-1.5 text-sm focus:outline-none focus:border-blue-400"
                placeholder="email@example.com" type="email" />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Password</label>
              <input value={newPass} onChange={e => setNewPass(e.target.value)}
                className="w-full border rounded px-2.5 py-1.5 text-sm focus:outline-none focus:border-blue-400"
                placeholder="Min 8 characters" type="password" />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Role</label>
              <select value={newRole} onChange={e => setNewRole(e.target.value)}
                className="w-full border rounded px-2.5 py-1.5 text-sm focus:outline-none focus:border-blue-400 bg-white"
              >
                <option value="user">User</option>
                <option value="admin">Admin</option>
              </select>
            </div>
          </div>
          {newRole !== 'admin' && clients.length > 0 && (
            <div>
              <label className="block text-xs font-medium text-gray-600 mb-1">Client Access</label>
              <div className="flex flex-wrap gap-2">
                {clients.map(c => (
                  <label key={c.id} className="flex items-center gap-1.5 text-xs cursor-pointer">
                    <input
                      type="checkbox"
                      checked={newClients.includes(c.id)}
                      onChange={() => setNewClients(prev => toggleClientId(prev, c.id))}
                      className="rounded"
                    />
                    {c.name}
                  </label>
                ))}
              </div>
            </div>
          )}
          {createErr && <p className="text-xs text-red-600">{createErr}</p>}
          <div className="flex gap-2 pt-1">
            <button
              onClick={() => createMut.mutate({ email: newEmail, name: newName, password: newPass, role: newRole, client_ids: newClients })}
              disabled={createMut.isPending}
              className="px-3 py-1.5 text-xs bg-blue-600 text-white rounded hover:bg-blue-700 disabled:opacity-50 font-medium"
            >
              {createMut.isPending ? 'Creating…' : 'Create User'}
            </button>
            <button onClick={() => setShowCreate(false)} className="px-3 py-1.5 text-xs text-gray-600 hover:text-gray-900">
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* User list */}
      <div className="border border-gray-200 rounded-xl overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 text-xs text-gray-500 uppercase">
            <tr>
              <th className="text-left px-4 py-2.5 font-medium">Name / Email</th>
              <th className="text-left px-4 py-2.5 font-medium">Role</th>
              <th className="text-left px-4 py-2.5 font-medium">Clients</th>
              <th className="text-left px-4 py-2.5 font-medium">Last Login</th>
              <th className="text-right px-4 py-2.5 font-medium">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {users.map(u => (
              <tr key={u.id} className={u.is_active ? '' : 'opacity-50'}>
                <td className="px-4 py-3">
                  <div className="font-medium text-gray-900">{u.name}</div>
                  <div className="text-xs text-gray-500">{u.email}</div>
                </td>
                <td className="px-4 py-3">
                  {u.role === 'admin'
                    ? <span className="inline-flex items-center gap-1 text-xs font-medium text-blue-700 bg-blue-50 px-2 py-0.5 rounded-full">
                        <ShieldCheck className="h-3 w-3" /> admin
                      </span>
                    : <span className="text-xs text-gray-500">user</span>
                  }
                </td>
                <td className="px-4 py-3">
                  {u.role === 'admin' ? (
                    <span className="text-xs text-gray-400 italic">all</span>
                  ) : editUserId === u.id ? (
                    <div className="flex flex-col gap-2">
                      <div className="flex flex-wrap gap-2">
                        {clients.map(c => (
                          <label key={c.id} className="flex items-center gap-1 text-xs cursor-pointer">
                            <input
                              type="checkbox"
                              checked={editClientIds.includes(c.id)}
                              onChange={() => setEditClientIds(prev => toggleClientId(prev, c.id))}
                              className="rounded"
                            />
                            {c.name.split(' ')[0]}
                          </label>
                        ))}
                      </div>
                      <div className="flex gap-2">
                        <button
                          onClick={() => updateClientsMut.mutate({ id: u.id, client_ids: editClientIds })}
                          className="text-xs text-blue-600 hover:text-blue-800 font-medium"
                        >Save</button>
                        <button onClick={() => setEditUserId(null)} className="text-xs text-gray-400">Cancel</button>
                      </div>
                    </div>
                  ) : (
                    <button
                      onClick={() => { setEditUserId(u.id); setEditClientIds(u.client_ids) }}
                      className="text-xs text-gray-600 hover:text-blue-600 flex items-center gap-1"
                    >
                      {u.client_ids.length === 0
                        ? <span className="text-gray-400 italic">None — click to set</span>
                        : clients.filter(c => u.client_ids.includes(c.id)).map(c => c.name.split(' ')[0]).join(', ')
                      }
                      <Pencil className="h-3 w-3 opacity-50" />
                    </button>
                  )}
                </td>
                <td className="px-4 py-3 text-xs text-gray-500">
                  {u.last_login ? new Date(u.last_login).toLocaleDateString() : '—'}
                </td>
                <td className="px-4 py-3 text-right">
                  <div className="flex items-center gap-2 justify-end">
                    {/* Reset password */}
                    {resetUserId === u.id ? (
                      <div className="flex items-center gap-1.5">
                        <input
                          type="password"
                          value={resetPass}
                          onChange={e => setResetPass(e.target.value)}
                          placeholder="New password"
                          className="border rounded px-2 py-1 text-xs w-32 focus:outline-none focus:border-blue-400"
                        />
                        <button
                          onClick={() => resetMut.mutate({ id: u.id, pw: resetPass })}
                          disabled={resetPass.length < 8 || resetMut.isPending}
                          className="text-xs text-blue-600 hover:text-blue-800 font-medium disabled:opacity-40"
                        >Set</button>
                        <button onClick={() => { setResetUserId(null); setResetPass(''); setResetErr(null) }}
                          className="text-xs text-gray-400">✕</button>
                        {resetErr && <span className="text-xs text-red-600">{resetErr}</span>}
                      </div>
                    ) : (
                      <button
                        onClick={() => { setResetUserId(u.id); setResetPass('') }}
                        title="Reset password"
                        className="p-1 text-gray-400 hover:text-blue-600"
                      >
                        <KeyRound className="h-3.5 w-3.5" />
                      </button>
                    )}
                    {/* Toggle active */}
                    <button
                      onClick={() => toggleActiveMut.mutate({ id: u.id, is_active: !u.is_active })}
                      title={u.is_active ? 'Deactivate user' : 'Activate user'}
                      className={`p-1 ${u.is_active ? 'text-gray-400 hover:text-red-500' : 'text-gray-400 hover:text-emerald-600'}`}
                    >
                      {u.is_active ? <ShieldOff className="h-3.5 w-3.5" /> : <ShieldCheck className="h-3.5 w-3.5" />}
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}


// ─── IBKR Flex Query Tab ──────────────────────────────────────────────────────
function IBKRFlexTab() {
  const { user } = useAuth()
  const isAdmin = user?.role === 'admin'
  const qc = useQueryClient()

  const SYNC_TS_KEY = 'ibkr_sync_started'

  // My config — auto-polls every 3 s while running or shortly after sync triggered
  const { data: myConfig, isLoading: myLoading } = useQuery({
    queryKey: ['ibkr-flex-my-config'],
    queryFn: getMyFlexConfig,
    refetchInterval: (query) => {
      const data = query.state.data as IBKRFlexConfig | null | undefined
      // Keep polling if DB says running
      if (data?.last_sync_status === 'running') return 3000
      // Also keep polling for up to 5 min after a sync was triggered
      // (handles navigation away and back)
      const ts = localStorage.getItem(SYNC_TS_KEY)
      if (ts && Date.now() - Number(ts) < 5 * 60 * 1000) return 3000
      return false
    },
    refetchIntervalInBackground: true,
  })

  // Clear the "waiting" flag once the DB reflects a terminal status
  const prevStatus = myConfig?.last_sync_status
  if (prevStatus === 'ok' || prevStatus === 'error') {
    localStorage.removeItem(SYNC_TS_KEY)
  }

  const [form, setForm] = useState({ query_id: '', token: '', enabled: true })
  const [editing, setEditing] = useState(false)
  const [showToken, setShowToken] = useState(false)
  const [syncError, setSyncError] = useState<string | null>(null)

  // Derive syncing from DB status + localStorage timestamp (survives navigation)
  const syncPending = (() => {
    if (myConfig?.last_sync_status === 'running') return true
    const ts = localStorage.getItem(SYNC_TS_KEY)
    return !!ts && Date.now() - Number(ts) < 5 * 60 * 1000
  })()

  // Populate form when editing
  const startEdit = () => {
    setForm({ query_id: myConfig?.query_id ?? '', token: '', enabled: myConfig?.enabled ?? true })
    setEditing(true)
  }

  const saveMut = useMutation({
    mutationFn: (data: { query_id: string; token: string; enabled: boolean }) =>
      saveMyFlexConfig(data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['ibkr-flex-my-config'] })
      if (isAdmin) qc.invalidateQueries({ queryKey: ['ibkr-flex-configs'] })
      setEditing(false)
    },
  })

  const deleteMut = useMutation({
    mutationFn: deleteMyFlexConfig,
    onSuccess: () => {
      localStorage.removeItem(SYNC_TS_KEY)
      qc.invalidateQueries({ queryKey: ['ibkr-flex-my-config'] })
      if (isAdmin) qc.invalidateQueries({ queryKey: ['ibkr-flex-configs'] })
    },
  })

  const handleSync = async () => {
    setSyncError(null)
    try {
      localStorage.setItem(SYNC_TS_KEY, String(Date.now()))
      await syncMyFlexAccounts()
      qc.invalidateQueries({ queryKey: ['ibkr-flex-my-config'] })
    } catch (e: unknown) {
      localStorage.removeItem(SYNC_TS_KEY)
      setSyncError((e as Error).message ?? 'Sync failed — check your Query ID and token')
    }
  }

  // Admin: all configs
  const { data: allConfigs = [] } = useQuery({
    queryKey: ['ibkr-flex-configs'],
    queryFn: getAllFlexConfigs,
    enabled: isAdmin,
  })
  const [adminSyncAll, setAdminSyncAll] = useState(false)

  const handleSyncAll = async () => {
    setAdminSyncAll(true)
    try {
      await syncAllFlexAccounts()
      setTimeout(() => {
        qc.invalidateQueries({ queryKey: ['ibkr-flex-configs'] })
        setAdminSyncAll(false)
      }, 8000)
    } catch (e: unknown) {
      alert((e as Error).message ?? 'Sync all failed')
      setAdminSyncAll(false)
    }
  }

  const cfg = myConfig as IBKRFlexConfig | null | undefined
  const hasConfig = cfg != null

  return (
    <div className="space-y-6">
      {/* ── My Flex Config ── */}
      <div className="bg-white rounded-xl border border-gray-200 p-5">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h3 className="font-semibold text-gray-800">My IBKR Flex Query</h3>
            <p className="text-xs text-gray-500 mt-0.5">
              One query covers all your IBKR accounts. Accounts are matched by IBKR account number (set in Admin → Accounts → Acct #).
            </p>
          </div>
          {hasConfig && !editing && (
            <div className="flex flex-col gap-2 items-start">
              <div className="flex gap-2">
                <button
                  onClick={handleSync}
                  disabled={syncPending}
                  className="flex items-center gap-1.5 text-sm bg-blue-600 text-white rounded-lg px-3 py-1.5 hover:bg-blue-700 disabled:opacity-50"
                >
                  {syncPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
                  {syncPending ? 'Syncing…' : 'Sync Now'}
                </button>
                <button onClick={startEdit} className="flex items-center gap-1.5 text-sm border border-gray-300 rounded-lg px-3 py-1.5 hover:bg-gray-50">
                  <Pencil className="h-3.5 w-3.5" /> Edit
                </button>
                <button onClick={() => deleteMut.mutate()} className="flex items-center gap-1.5 text-sm border border-red-200 text-red-600 rounded-lg px-3 py-1.5 hover:bg-red-50">
                  <Trash2 className="h-3.5 w-3.5" /> Remove
                </button>
              </div>
              {syncError && (
                <p className="text-sm text-red-600 max-w-md">
                  {syncError.includes('429')
                    ? 'IBKR limits syncs to once every 10 minutes. The last sync status is shown below — check if it already completed successfully.'
                    : syncError}
                </p>
              )}
            </div>
          )}
        </div>

        {myLoading ? (
          <div className="text-sm text-gray-400">Loading…</div>
        ) : !hasConfig && !editing ? (
          <div className="space-y-3">
            <p className="text-sm text-gray-500">No Flex Query configured yet.</p>
            <button
              onClick={() => { setForm({ query_id: '', token: '', enabled: true }); setEditing(true) }}
              className="flex items-center gap-2 text-sm bg-blue-600 text-white rounded-lg px-4 py-2 hover:bg-blue-700"
            >
              <Plus className="h-4 w-4" /> Add Flex Query
            </button>
          </div>
        ) : editing ? (
          <div className="space-y-3">
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div>
                <label className="block text-xs text-gray-500 mb-1">Query ID</label>
                <input
                  className="border border-gray-300 rounded-lg px-3 py-2 text-sm w-full"
                  placeholder="e.g. 1403268"
                  value={form.query_id}
                  onChange={e => setForm(f => ({ ...f, query_id: e.target.value }))}
                />
              </div>
              <div>
                <label className="block text-xs text-gray-500 mb-1">
                  Token {hasConfig && <span className="text-gray-400">(leave blank to keep existing)</span>}
                </label>
                <div className="relative">
                  <input
                    className="border border-gray-300 rounded-lg px-3 py-2 text-sm w-full pr-9"
                    placeholder={hasConfig ? '(unchanged)' : 'Flex token'}
                    type={showToken ? 'text' : 'password'}
                    value={form.token}
                    onChange={e => setForm(f => ({ ...f, token: e.target.value }))}
                  />
                  <button type="button" onClick={() => setShowToken(v => !v)}
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600">
                    {showToken ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </div>
              </div>
              <div className="flex items-end gap-2">
                <button
                  onClick={() => saveMut.mutate({ query_id: form.query_id, token: form.token, enabled: form.enabled })}
                  disabled={saveMut.isPending || !form.query_id || (!form.token && !hasConfig)}
                  className="flex-1 bg-blue-600 text-white rounded-lg px-4 py-2 text-sm font-medium hover:bg-blue-700 disabled:opacity-50"
                >
                  Save
                </button>
                {hasConfig && (
                  <button onClick={() => setEditing(false)}
                    className="px-3 py-2 text-sm border border-gray-300 rounded-lg hover:bg-gray-50">
                    Cancel
                  </button>
                )}
              </div>
            </div>
          </div>
        ) : cfg ? (
          // Config summary card
          <div className="space-y-3">
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 text-sm">
              <div>
                <div className="text-xs text-gray-500 mb-0.5">Query ID</div>
                <div className="font-mono text-gray-800">{cfg.query_id}</div>
              </div>
              <div>
                <div className="text-xs text-gray-500 mb-0.5">Token</div>
                <div className="font-mono text-gray-400">{cfg.token_hint}</div>
              </div>
              <div>
                <div className="text-xs text-gray-500 mb-0.5">Last Sync</div>
                <div className="text-gray-700">
                  {cfg.last_sync_at
                    ? new Date(cfg.last_sync_at).toLocaleString('en-CA', { dateStyle: 'short', timeStyle: 'short' })
                    : '—'}
                </div>
              </div>
              <div>
                <div className="text-xs text-gray-500 mb-0.5">Status</div>
                {cfg.last_sync_status === 'ok' ? (
                  <span className="text-emerald-600 text-xs">{cfg.last_sync_message}</span>
                ) : cfg.last_sync_status === 'error' ? (
                  <span className="text-red-600 text-xs" title={cfg.last_sync_message ?? ''}>{cfg.last_sync_message}</span>
                ) : cfg.last_sync_status === 'running' ? (
                  <span className="flex items-center gap-1 text-blue-600 text-xs"><Loader2 className="h-3 w-3 animate-spin" /> Running…</span>
                ) : (
                  <span className="text-gray-400 text-xs">Never synced</span>
                )}
              </div>
            </div>
          </div>
        ) : null}
      </div>

      {/* ── Admin: all users' configs ── */}
      {isAdmin && (
        <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
          <div className="flex items-center justify-between px-5 py-3 border-b border-gray-200">
            <h3 className="font-semibold text-gray-800">All Users' Flex Configs</h3>
            <button
              onClick={handleSyncAll}
              disabled={adminSyncAll}
              className="flex items-center gap-2 text-sm bg-blue-50 text-blue-700 border border-blue-200 rounded-lg px-3 py-1.5 hover:bg-blue-100 disabled:opacity-50"
            >
              {adminSyncAll ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
              Sync All Users
            </button>
          </div>
          {(allConfigs as IBKRFlexConfig[]).length === 0 ? (
            <div className="p-6 text-center text-gray-400 text-sm">No configs configured yet.</div>
          ) : (
            <table className="min-w-full text-sm">
              <thead className="bg-gray-50 text-xs text-gray-500 uppercase">
                <tr>
                  <th className="px-4 py-3 text-left">User</th>
                  <th className="px-4 py-3 text-left">Query ID</th>
                  <th className="px-4 py-3 text-left">Token</th>
                  <th className="px-4 py-3 text-left">Last Sync</th>
                  <th className="px-4 py-3 text-left">Result</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {(allConfigs as IBKRFlexConfig[]).map(c => (
                  <tr key={c.id} className="hover:bg-gray-50">
                    <td className="px-4 py-3 font-medium text-gray-900">
                      {c.user_name ?? `User ${c.user_id}`}
                      {!c.enabled && <span className="ml-2 text-xs text-gray-400">(disabled)</span>}
                    </td>
                    <td className="px-4 py-3 font-mono text-xs text-gray-600">{c.query_id}</td>
                    <td className="px-4 py-3 font-mono text-xs text-gray-400">{c.token_hint}</td>
                    <td className="px-4 py-3 text-xs text-gray-500">
                      {c.last_sync_at ? new Date(c.last_sync_at).toLocaleString('en-CA', { dateStyle: 'short', timeStyle: 'short' }) : '—'}
                    </td>
                    <td className="px-4 py-3 text-xs">
                      {c.last_sync_status === 'ok' && <span className="text-emerald-600">{c.last_sync_message}</span>}
                      {c.last_sync_status === 'error' && <span className="text-red-600">{c.last_sync_message}</span>}
                      {c.last_sync_status === 'running' && <span className="text-blue-600 flex items-center gap-1"><Loader2 className="h-3 w-3 animate-spin" />Running…</span>}
                      {!c.last_sync_status && <span className="text-gray-400">Never</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  )
}


export default function Admin() {
  const { user } = useAuth()
  const isAdmin = user?.role === 'admin'
  const tabs = ALL_TABS.filter(t => !t.adminOnly || isAdmin)
  const [tab, setTab] = useState<TabId>(() => isAdmin ? 'system' : 'my-account')

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-gray-900">Admin</h1>
      <div className="border-b border-gray-200 overflow-x-auto">
        <div className="flex gap-0 min-w-max">
          {tabs.map(t => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`px-5 py-3 text-sm font-medium border-b-2 transition-colors whitespace-nowrap ${
                tab === t.id ? 'border-blue-600 text-blue-700' : 'border-transparent text-gray-500 hover:text-gray-700'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>
      <div>
        {tab === 'system' && isAdmin && <SystemTab />}
        {tab === 'my-account' && <MyAccountTab />}
        {tab === 'accounts' && <AccountsTab />}
        {tab === 'opening-balances' && <OpeningBalancesTab />}
        {tab === 'currency-split' && isAdmin && <CurrencySplitTab />}
        {tab === 'securities' && <SecuritiesTab />}
        {tab === 'brokerages' && <BrokeragesTab />}
        {tab === 'type-mappings' && <TypeMappingsTab />}
        {tab === 'fx-rates' && <FxRatesTab />}
        {tab === 'ibkr-flex' && isAdmin && <IBKRFlexTab />}
        {tab === 'users' && isAdmin && <UsersTab />}
        {tab === 'danger' && isAdmin && <DangerZoneTab />}
      </div>
    </div>
  )
}
