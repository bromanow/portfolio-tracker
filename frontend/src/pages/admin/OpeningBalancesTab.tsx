import { useState, useMemo } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Trash2, Check, X, Edit2 } from 'lucide-react'
import DatePicker from '../../components/DatePicker'
import {
  getOpeningBalances, createOpeningBalance, updateOpeningBalance, deleteOpeningBalance,
  getAccounts, getSecurities,
  getCashOpenings, createCashOpening, deleteCashOpening,
} from '../../api/client'
import type { Account, Security, OpeningBalance, CashOpening } from '../../api/client'
import { ConfirmDialog, useSortState, SortTh, sortRows } from './shared'

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

export default function OpeningBalancesTab() {
  const qc = useQueryClient()
  const { data: allBalances = [], isLoading } = useQuery({ queryKey: ['opening-balances'], queryFn: getOpeningBalances })
  const { data: accounts = [] } = useQuery({ queryKey: ['accounts', 'admin'], queryFn: () => getAccounts(true) })
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
                <DatePicker className="w-full" max={new Date().toISOString().slice(0, 10)}
                  value={editing.balance_date || ''}
                  onChange={v => setEditing(p => p && ({ ...p, balance_date: v }))} />
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
            <DatePicker className="w-full" max={new Date().toISOString().slice(0, 10)} value={form.balance_date || ''}
              onChange={v => setForm(f => ({ ...f, balance_date: v }))} />
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
  const { data: accounts = [] } = useQuery({ queryKey: ['accounts', 'admin'], queryFn: () => getAccounts(true) })
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
            <DatePicker max={new Date().toISOString().slice(0, 10)} value={form.balance_date || ''}
              onChange={v => setForm(f => ({ ...f, balance_date: v }))} />
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
