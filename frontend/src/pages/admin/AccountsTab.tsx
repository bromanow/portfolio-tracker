import { useState, useMemo } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Trash2, AlertTriangle, X, Edit2, Check } from 'lucide-react'
import { getAccounts, createAccount, updateAccount, deleteAccount, forceDeleteAccount, getBrokerages } from '../../api/client'
import type { Account } from '../../api/client'
import { ConfirmDialog, useSortState, SortTh, sortRows } from './shared'

// ─── Accounts Tab ────────────────────────────────────────────────────────────
export default function AccountsTab() {
  const qc = useQueryClient()
  const { data: accounts = [] } = useQuery({ queryKey: ['accounts', 'admin'], queryFn: () => getAccounts(true) })
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

      <div className="bg-muted/50 rounded-lg p-4 border border-border">
        <h3 className="font-medium text-foreground mb-3">Add Account</h3>
        <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
          <select className="bg-background text-foreground border rounded px-3 py-1.5 text-sm" value={form.brokerage_id}
            onChange={e => setForm(f => ({ ...f, brokerage_id: e.target.value }))}>
            <option value="">Select brokerage</option>
            {brokerages.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
          </select>
          <input className="bg-background text-foreground border rounded px-3 py-1.5 text-sm" placeholder="Name" value={form.name}
            onChange={e => setForm(f => ({ ...f, name: e.target.value }))} />
          <select className="bg-background text-foreground border rounded px-3 py-1.5 text-sm" value={form.account_type}
            onChange={e => setForm(f => ({ ...f, account_type: e.target.value }))}>
            {['RRSP', 'TFSA', 'RESP', 'NON_REG', '401K', 'IRA', 'ROTH', 'OTHER'].map(t => <option key={t}>{t}</option>)}
          </select>
          <select className="bg-background text-foreground border rounded px-3 py-1.5 text-sm" value={form.base_currency}
            onChange={e => setForm(f => ({ ...f, base_currency: e.target.value }))}>
            <option>CAD</option><option>USD</option>
          </select>
          <input className="bg-background text-foreground border rounded px-3 py-1.5 text-sm" placeholder="Owner" value={form.owner}
            onChange={e => setForm(f => ({ ...f, owner: e.target.value }))} />
          <input className="bg-background text-foreground border rounded px-3 py-1.5 text-sm" placeholder="Account # (optional)" value={form.account_number}
            onChange={e => setForm(f => ({ ...f, account_number: e.target.value }))} />
          <input className="bg-background text-foreground border rounded px-3 py-1.5 text-sm" placeholder="IB Alias (e.g. Brian TFSA)" value={form.ibkr_alias}
            onChange={e => setForm(f => ({ ...f, ibkr_alias: e.target.value }))} />
        </div>
        <button onClick={() => createMut.mutate()} disabled={!form.brokerage_id || !form.name || !form.owner}
          className="mt-3 bg-primary text-white text-sm px-4 py-1.5 rounded disabled:opacity-40">
          Add Account
        </button>
      </div>

      <div className="flex flex-wrap gap-3 mb-3">
        <select className="bg-background text-foreground border rounded px-3 py-1.5 text-sm" value={filterBrokerage} onChange={e => setFilterBrokerage(e.target.value)}>
          <option value="">All Brokerages</option>
          {brokerageOptions.map(b => <option key={b} value={b}>{b}</option>)}
        </select>
        <select className="bg-background text-foreground border rounded px-3 py-1.5 text-sm" value={filterType} onChange={e => setFilterType(e.target.value)}>
          <option value="">All Types</option>
          {['RRSP', 'TFSA', 'RESP', 'NON_REG', '401K', 'IRA', 'ROTH', 'OTHER'].map(t => <option key={t}>{t}</option>)}
        </select>
        {(filterBrokerage || filterType) && (
          <button onClick={() => { setFilterBrokerage(''); setFilterType('') }} className="text-xs text-muted-foreground hover:text-foreground">Clear filters</button>
        )}
      </div>

      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="min-w-full text-sm divide-y divide-border">
          <thead className="bg-muted/50">
            <tr className="text-xs text-muted-foreground uppercase">
              <SortTh label="Brokerage" col="brokerage_name" sort={sort} toggle={toggle} className="px-3 py-3 text-left" />
              <SortTh label="Name" col="name" sort={sort} toggle={toggle} className="px-3 py-3 text-left" />
              <SortTh label="Type" col="account_type" sort={sort} toggle={toggle} className="px-3 py-3 text-left" />
              <SortTh label="Currency" col="base_currency" sort={sort} toggle={toggle} className="px-3 py-3 text-left" />
              <SortTh label="Owner" col="owner" sort={sort} toggle={toggle} className="px-3 py-3 text-left" />
              <SortTh label="Acct #" col="account_number" sort={sort} toggle={toggle} className="px-3 py-3 text-left" />
              <th className="px-3 py-3 text-left text-xs text-muted-foreground uppercase">IB Alias</th>
              <SortTh label="Active" col="active" sort={sort} toggle={toggle} className="px-3 py-3 text-left" />
              <th className="px-3 py-3 text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border/60">
            {sortRows(visibleAccounts, sort.col, sort.dir).map(a => (
              <tr key={a.id} className="hover:bg-muted/50">
                <td className="px-3 py-2.5 text-xs text-muted-foreground">{a.brokerage_name}</td>
                {editing === a.id ? (
                  <>
                    <td className="px-3 py-2"><input className="bg-background text-foreground border rounded px-2 py-1 text-xs w-36"
                      value={editData.name ?? a.name} onChange={e => setEditData(d => ({ ...d, name: e.target.value }))} /></td>
                    <td className="px-3 py-2"><select className="bg-background text-foreground border rounded px-2 py-1 text-xs" value={editData.account_type ?? a.account_type}
                      onChange={e => setEditData(d => ({ ...d, account_type: e.target.value }))}>
                      {['RRSP', 'TFSA', 'RESP', 'NON_REG', '401K', 'IRA', 'ROTH', 'OTHER'].map(t => <option key={t}>{t}</option>)}
                    </select></td>
                    <td className="px-3 py-2"><select className="bg-background text-foreground border rounded px-2 py-1 text-xs" value={editData.base_currency ?? a.base_currency}
                      onChange={e => setEditData(d => ({ ...d, base_currency: e.target.value }))}>
                      <option>CAD</option><option>USD</option>
                    </select></td>
                    <td className="px-3 py-2"><input className="bg-background text-foreground border rounded px-2 py-1 text-xs w-20"
                      value={editData.owner ?? a.owner} onChange={e => setEditData(d => ({ ...d, owner: e.target.value }))} /></td>
                    <td className="px-3 py-2"><input className="bg-background text-foreground border rounded px-2 py-1 text-xs w-28"
                      value={editData.account_number ?? (a.account_number || '')} onChange={e => setEditData(d => ({ ...d, account_number: e.target.value }))} /></td>
                    <td className="px-3 py-2"><input className="bg-background text-foreground border rounded px-2 py-1 text-xs w-28"
                      placeholder="IB alias"
                      value={editData.ibkr_alias ?? (a.ibkr_alias || '')} onChange={e => setEditData(d => ({ ...d, ibkr_alias: e.target.value }))} /></td>
                    <td className="px-3 py-2"><select className="bg-background text-foreground border rounded px-2 py-1 text-xs"
                      value={(editData.active ?? a.active) ? 'true' : 'false'}
                      onChange={e => setEditData(d => ({ ...d, active: e.target.value === 'true' }))}>
                      <option value="true">Yes</option><option value="false">No</option>
                    </select></td>
                    <td className="px-3 py-2 text-right flex gap-2 justify-end">
                      <button onClick={() => updateMut.mutate({ id: a.id, data: editData })}
                        className="text-green-600 hover:text-green-800"><Check className="h-4 w-4" /></button>
                      <button onClick={() => setEditing(null)} className="text-muted-foreground hover:text-muted-foreground"><X className="h-4 w-4" /></button>
                    </td>
                  </>
                ) : (
                  <>
                    <td className="px-3 py-2.5 font-medium">{a.name}</td>
                    <td className="px-3 py-2.5"><span className="px-1.5 py-0.5 bg-primary/10 text-primary rounded text-xs">{a.account_type}</span></td>
                    <td className="px-3 py-2.5 text-xs text-muted-foreground">{a.base_currency}</td>
                    <td className="px-3 py-2.5 text-xs">{a.owner}</td>
                    <td className="px-3 py-2.5 text-xs text-muted-foreground font-mono">{a.account_number || '—'}</td>
                    <td className="px-3 py-2.5 text-xs text-primary font-mono">{a.ibkr_alias || '—'}</td>
                    <td className="px-3 py-2.5"><span className={`text-xs ${a.active ? 'text-green-600' : 'text-red-400'}`}>{a.active ? 'Yes' : 'No'}</span></td>
                    <td className="px-3 py-2.5 text-right">
                      <div className="flex gap-2 justify-end">
                        <button onClick={() => { setEditing(a.id); setEditData({}) }}
                          className="text-primary/70 hover:text-primary"><Edit2 className="h-3.5 w-3.5" /></button>
                        <button onClick={() => setDeleteConfirm({ id: a.id, name: a.name })}
                          className="text-red-400 hover:text-red-600 dark:text-red-400"><Trash2 className="h-3.5 w-3.5" /></button>
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
