import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Check, X, Edit2, Trash2 } from 'lucide-react'
import { getTypeMappings, createTypeMapping, updateTypeMapping, deleteTypeMapping, getBrokerages } from '../../api/client'
import type { TypeMapping } from '../../api/client'
import { useSortState, SortTh, sortRows } from './shared'

// ─── Type Mappings Tab ────────────────────────────────────────────────────────
export default function TypeMappingsTab() {
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
