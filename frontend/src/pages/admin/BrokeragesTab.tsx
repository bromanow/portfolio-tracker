import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Trash2, X, Pencil, Check, Plus } from 'lucide-react'
import { getBrokerages, createBrokerage, updateBrokerage, deleteBrokerage } from '../../api/client'
import type { Brokerage } from '../../api/client'
import { ConfirmDialog, useSortState, SortTh, sortRows } from './shared'

// ─── Brokerages Tab ────────────────────────────────────────────────────────────
const EMPTY_BROKERAGE = { name: '', code: '', active: true, advisor: '' }

export default function BrokeragesTab() {
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
        <div className="bg-primary/10 border border-primary/20 rounded-lg p-4 space-y-3">
          <h3 className="font-semibold text-sm text-primary">New Brokerage</h3>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <div>
              <label className="block text-xs text-muted-foreground mb-1">Name *</label>
              <input className="bg-background text-foreground w-full border border-border rounded px-2 py-1.5 text-sm" placeholder="e.g. TD Direct Investing"
                value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} />
            </div>
            <div>
              <label className="block text-xs text-muted-foreground mb-1">Code * <span className="text-muted-foreground">(unique short id)</span></label>
              <input className="bg-background text-foreground w-full border border-border rounded px-2 py-1.5 text-sm font-mono" placeholder="e.g. TDDI"
                value={form.code} onChange={e => setForm(f => ({ ...f, code: e.target.value.toUpperCase() }))} />
            </div>
            <div>
              <label className="block text-xs text-muted-foreground mb-1">Advisor</label>
              <input className="bg-background text-foreground w-full border border-border rounded px-2 py-1.5 text-sm" placeholder="e.g. John Smith"
                value={form.advisor} onChange={e => setForm(f => ({ ...f, advisor: e.target.value }))} />
            </div>
            <div>
              <label className="block text-xs text-muted-foreground mb-1">Active</label>
              <select className="bg-background text-foreground w-full border border-border rounded px-2 py-1.5 text-sm"
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
              className="px-4 py-1.5 bg-primary text-white rounded text-sm hover:bg-primary/90 disabled:opacity-50">
              {createMut.isPending ? 'Saving…' : 'Save'}
            </button>
            <button onClick={() => { setShowForm(false); setForm(EMPTY_BROKERAGE); setError(null) }}
              className="px-4 py-1.5 border border-border rounded text-sm hover:bg-muted/50">Cancel</button>
          </div>
        </div>
      ) : (
        <button onClick={() => setShowForm(true)}
          className="flex items-center gap-2 px-4 py-2 bg-primary text-white rounded-lg text-sm hover:bg-primary/90">
          <Plus className="h-4 w-4" /> New Brokerage
        </button>
      )}

      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="min-w-full text-sm divide-y divide-border">
          <thead className="bg-muted/50">
            <tr className="text-xs text-muted-foreground uppercase">
              <SortTh label="Name" col="name" sort={sort} toggle={toggle} className="px-3 py-3 text-left" />
              <SortTh label="Code" col="code" sort={sort} toggle={toggle} className="px-3 py-3 text-left" />
              <SortTh label="Advisor" col="advisor" sort={sort} toggle={toggle} className="px-3 py-3 text-left" />
              <SortTh label="Active" col="active" sort={sort} toggle={toggle} className="px-3 py-3 text-left" />
              <th className="px-3 py-3 text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border/60">
            {sortRows(brokerages, sort.col, sort.dir).map(b => (
              editingId === b.id ? (
                <tr key={b.id} className="bg-yellow-50">
                  <td className="px-3 py-2">
                    <input className="bg-background text-foreground w-full border border-border rounded px-2 py-1 text-sm"
                      value={editData.name} onChange={e => setEditData(d => ({ ...d, name: e.target.value }))} />
                  </td>
                  <td className="px-3 py-2">
                    <input className="bg-background text-foreground w-28 border border-border rounded px-2 py-1 text-sm font-mono"
                      value={editData.code} onChange={e => setEditData(d => ({ ...d, code: e.target.value.toUpperCase() }))} />
                  </td>
                  <td className="px-3 py-2">
                    <input className="bg-background text-foreground w-full border border-border rounded px-2 py-1 text-sm"
                      value={editData.advisor} onChange={e => setEditData(d => ({ ...d, advisor: e.target.value }))} />
                  </td>
                  <td className="px-3 py-2">
                    <select className="bg-background text-foreground border border-border rounded px-2 py-1 text-sm"
                      value={editData.active ? 'true' : 'false'} onChange={e => setEditData(d => ({ ...d, active: e.target.value === 'true' }))}>
                      <option value="true">Yes</option>
                      <option value="false">No</option>
                    </select>
                  </td>
                  <td className="px-3 py-2 text-right">
                    <div className="flex items-center justify-end gap-2">
                      <button onClick={() => updateMut.mutate({ id: b.id, data: { ...editData, advisor: editData.advisor || null } })}
                        disabled={updateMut.isPending}
                        className="text-xs px-2 py-1 bg-primary text-white rounded hover:bg-primary/90 disabled:opacity-50">
                        {updateMut.isPending ? '…' : 'Save'}
                      </button>
                      <button onClick={() => setEditingId(null)} className="text-xs px-2 py-1 border rounded hover:bg-muted/50">Cancel</button>
                    </div>
                  </td>
                </tr>
              ) : (
                <tr key={b.id} className="hover:bg-muted/50">
                  <td className="px-3 py-2.5 font-medium">{b.name}</td>
                  <td className="px-3 py-2.5 font-mono text-xs text-muted-foreground">{b.code}</td>
                  <td className="px-3 py-2.5 text-xs text-muted-foreground">{b.advisor || <span className="text-muted-foreground/50">—</span>}</td>
                  <td className="px-3 py-2.5">
                    <span className={`text-xs font-medium ${b.active ? 'text-green-600' : 'text-muted-foreground'}`}>{b.active ? 'Yes' : 'No'}</span>
                  </td>
                  <td className="px-3 py-2.5 text-right">
                    <div className="flex items-center justify-end gap-2">
                      <button onClick={() => startEdit(b)} className="text-primary/60 hover:text-primary">
                        <Pencil className="h-3.5 w-3.5" />
                      </button>
                      <button onClick={() => setDeleteId(b.id)} className="text-red-400 hover:text-red-600 dark:text-red-400">
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
