import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  getPersonalAssets, createPersonalAsset, updatePersonalAsset,
  uploadPersonalAssetFile, openPersonalAssetFile, deletePersonalAssetFile,
  getPersonalAssetIncomeEntries, createPersonalAssetIncomeEntry, deletePersonalAssetIncomeEntry,
} from '../../api/client'
import type { PersonalAsset, PersonalAssetClass } from '../../api/client'
import { ChevronDown, ChevronRight, FileText, Trash2, Upload, Link2 } from 'lucide-react'

const CLASS_LABELS: Record<PersonalAssetClass, string> = {
  REAL_ESTATE: 'Real Estate',
  LIFE_INSURANCE: 'Life Insurance',
  OTHER_ASSET: 'Other Asset',
  LIABILITY: 'Liability',
}

const PROPERTY_TYPES = ['Primary Residence', 'Rental Property', 'Land']

function fmtCAD(v: string | null): string {
  if (v == null) return '—'
  const n = parseFloat(v)
  return n.toLocaleString('en-CA', { style: 'currency', currency: 'CAD', maximumFractionDigits: 0 })
}

// ─── Searchable picker for linking to an existing asset/liability ────────────
function LinkPicker({ assets, value, onChange, excludeId }: {
  assets: PersonalAsset[]; value: number | null; onChange: (id: number | null) => void; excludeId?: number
}) {
  const [q, setQ] = useState('')
  const [open, setOpen] = useState(false)
  const candidates = assets.filter(a => a.security_id !== excludeId)
  const selected = candidates.find(a => a.security_id === value) || null
  const matches = (q.trim()
    ? candidates.filter(a => (a.name || '').toLowerCase().includes(q.toLowerCase()))
    : candidates).slice(0, 20)
  return (
    <div className="relative">
      <input
        className="border border-gray-200 rounded px-2 py-1.5 text-sm w-full"
        placeholder="Search to link an asset/liability…"
        value={selected && !open ? selected.name || '' : q}
        onChange={e => { setQ(e.target.value); setOpen(true); if (value) onChange(null) }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
      />
      {open && matches.length > 0 && (
        <div className="absolute z-20 mt-1 max-h-56 overflow-auto bg-white border border-gray-200 rounded shadow-lg w-full">
          {matches.map(a => (
            <button key={a.security_id} type="button"
              onMouseDown={e => { e.preventDefault(); onChange(a.security_id); setQ(''); setOpen(false) }}
              className="block w-full text-left px-3 py-1.5 text-sm hover:bg-blue-50 truncate">
              {a.name} <span className="text-gray-400">— {CLASS_LABELS[a.asset_class]}</span>
            </button>
          ))}
        </div>
      )}
      {value != null && (
        <button type="button" onClick={() => onChange(null)} className="text-xs text-gray-400 hover:text-red-500 mt-1">
          Clear link
        </button>
      )}
    </div>
  )
}

// ─── Rental income/expense ledger (REAL_ESTATE rows only) ────────────────────
function IncomeLedger({ securityId }: { securityId: number }) {
  const qc = useQueryClient()
  const { data: entries = [] } = useQuery({
    queryKey: ['personal-asset-income', securityId],
    queryFn: () => getPersonalAssetIncomeEntries(securityId),
  })
  const [form, setForm] = useState({ entry_date: new Date().toISOString().slice(0, 10), category: 'RENT' as const, amount_cad: '', description: '' })

  const addMut = useMutation({
    mutationFn: () => createPersonalAssetIncomeEntry(securityId, {
      entry_date: form.entry_date, category: form.category,
      amount_cad: parseFloat(form.amount_cad || '0'), description: form.description || undefined,
    }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['personal-asset-income', securityId] })
      setForm(f => ({ ...f, amount_cad: '', description: '' }))
    },
  })
  const delMut = useMutation({
    mutationFn: (entryId: number) => deletePersonalAssetIncomeEntry(securityId, entryId),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['personal-asset-income', securityId] }),
  })

  const rent = entries.filter(e => e.category === 'RENT').reduce((s, e) => s + parseFloat(e.amount_cad), 0)
  const other = entries.filter(e => e.category === 'OTHER_INCOME').reduce((s, e) => s + parseFloat(e.amount_cad), 0)
  const expense = entries.filter(e => e.category === 'EXPENSE').reduce((s, e) => s + parseFloat(e.amount_cad), 0)
  const noi = rent + other - expense

  return (
    <div className="bg-gray-50 rounded-lg p-4 space-y-3">
      <div className="flex items-center gap-4 text-sm">
        <span className="font-semibold text-gray-700">Net Operating Income (all-time):</span>
        <span className={`font-bold ${noi >= 0 ? 'text-emerald-600' : 'text-red-500'}`}>
          {noi.toLocaleString('en-CA', { style: 'currency', currency: 'CAD', maximumFractionDigits: 0 })}
        </span>
        <span className="text-xs text-gray-400">rent {rent.toLocaleString()} + other {other.toLocaleString()} − expenses {expense.toLocaleString()}</span>
      </div>

      <div className="flex flex-wrap gap-2 items-end text-xs">
        <input type="date" className="border rounded px-2 py-1" value={form.entry_date}
          onChange={e => setForm(f => ({ ...f, entry_date: e.target.value }))} />
        <select className="border rounded px-2 py-1" value={form.category}
          onChange={e => setForm(f => ({ ...f, category: e.target.value as typeof f.category }))}>
          <option value="RENT">Rent</option>
          <option value="EXPENSE">Expense</option>
          <option value="OTHER_INCOME">Other Income</option>
        </select>
        <input className="border rounded px-2 py-1 w-24" placeholder="Amount" value={form.amount_cad}
          onChange={e => setForm(f => ({ ...f, amount_cad: e.target.value }))} />
        <input className="border rounded px-2 py-1 flex-1 min-w-[120px]" placeholder="Description" value={form.description}
          onChange={e => setForm(f => ({ ...f, description: e.target.value }))} />
        <button onClick={() => addMut.mutate()} disabled={!form.amount_cad || addMut.isPending}
          className="px-3 py-1 bg-blue-600 text-white rounded disabled:opacity-40">Add</button>
      </div>

      <div className="divide-y divide-gray-200 max-h-48 overflow-auto">
        {entries.map(e => (
          <div key={e.id} className="flex items-center justify-between py-1.5 text-xs">
            <div className="flex items-center gap-2">
              <span className="text-gray-400">{e.entry_date}</span>
              <span className={`px-1.5 py-0.5 rounded ${e.category === 'EXPENSE' ? 'bg-red-100 text-red-600' : 'bg-emerald-100 text-emerald-700'}`}>
                {e.category}
              </span>
              <span className="font-medium">{fmtCAD(e.amount_cad)}</span>
              {e.description && <span className="text-gray-400">{e.description}</span>}
            </div>
            <button onClick={() => delMut.mutate(e.id)} className="text-gray-300 hover:text-red-500">
              <Trash2 className="h-3 w-3" />
            </button>
          </div>
        ))}
        {entries.length === 0 && <p className="text-xs text-gray-400 py-2">No entries yet.</p>}
      </div>
    </div>
  )
}

// ─── Add/edit form ────────────────────────────────────────────────────────────
function AssetForm({ assets, onCreated }: { assets: PersonalAsset[]; onCreated: () => void }) {
  const [assetClass, setAssetClass] = useState<PersonalAssetClass>('REAL_ESTATE')
  const [name, setName] = useState('')
  const [owner, setOwner] = useState('')
  const [value, setValue] = useState('')
  const [interestRate, setInterestRate] = useState('')
  const [propertyType, setPropertyType] = useState(PROPERTY_TYPES[0])
  const [propertyAddress, setPropertyAddress] = useState('')
  const [policyNumber, setPolicyNumber] = useState('')
  const [insurerName, setInsurerName] = useState('')
  const [lenderName, setLenderName] = useState('')
  const [maturityDate, setMaturityDate] = useState('')
  const [isCorporate, setIsCorporate] = useState(false)
  const [entityName, setEntityName] = useState('')
  const [zillowEstimate, setZillowEstimate] = useState('')
  const [linkedId, setLinkedId] = useState<number | null>(null)
  const [notes, setNotes] = useState('')

  const createMut = useMutation({
    mutationFn: () => createPersonalAsset({
      asset_class: assetClass, name, owner, value: parseFloat(value || '0'),
      interest_rate: interestRate ? parseFloat(interestRate) : undefined,
      property_type: assetClass === 'REAL_ESTATE' ? propertyType : undefined,
      property_address: assetClass === 'REAL_ESTATE' ? propertyAddress || undefined : undefined,
      policy_number: assetClass === 'LIFE_INSURANCE' ? policyNumber || undefined : undefined,
      insurer_name: assetClass === 'LIFE_INSURANCE' ? insurerName || undefined : undefined,
      lender_name: assetClass === 'LIABILITY' ? lenderName || undefined : undefined,
      maturity_date: assetClass === 'LIABILITY' && maturityDate ? maturityDate : undefined,
      is_corporate: isCorporate,
      entity_name: isCorporate ? entityName || undefined : undefined,
      zillow_estimate_cad: assetClass === 'REAL_ESTATE' && zillowEstimate ? parseFloat(zillowEstimate) : undefined,
      linked_security_id: linkedId ?? undefined,
      notes: notes || undefined,
    }),
    onSuccess: () => {
      onCreated()
      setName(''); setValue(''); setInterestRate(''); setPropertyAddress('')
      setPolicyNumber(''); setInsurerName(''); setLenderName(''); setMaturityDate('')
      setIsCorporate(false); setEntityName(''); setZillowEstimate(''); setLinkedId(null); setNotes('')
    },
  })

  return (
    <div className="bg-white border border-gray-200 rounded-xl p-5 space-y-4">
      <h3 className="font-semibold text-gray-800">Add a personal asset or liability</h3>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <div>
          <label className="text-xs text-gray-500">Type</label>
          <select className="border rounded px-2 py-1.5 text-sm w-full" value={assetClass}
            onChange={e => setAssetClass(e.target.value as PersonalAssetClass)}>
            {(Object.keys(CLASS_LABELS) as PersonalAssetClass[]).map(c => (
              <option key={c} value={c}>{CLASS_LABELS[c]}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="text-xs text-gray-500">Name</label>
          <input className="border rounded px-2 py-1.5 text-sm w-full" value={name} onChange={e => setName(e.target.value)}
            placeholder={assetClass === 'LIABILITY' ? 'e.g. Mortgage - 123 Main St' : 'e.g. 123 Main St'} />
        </div>
        <div>
          <label className="text-xs text-gray-500">Owner</label>
          <input className="border rounded px-2 py-1.5 text-sm w-full" value={owner} onChange={e => setOwner(e.target.value)} placeholder="Brian" />
        </div>
        <div>
          <label className="text-xs text-gray-500">{assetClass === 'LIABILITY' ? 'Amount Owed' : 'Current Value'} (CAD)</label>
          <input className="border rounded px-2 py-1.5 text-sm w-full" value={value} onChange={e => setValue(e.target.value)} placeholder="650000" />
        </div>
        <div>
          <label className="text-xs text-gray-500">Interest Rate % (optional)</label>
          <input className="border rounded px-2 py-1.5 text-sm w-full" value={interestRate} onChange={e => setInterestRate(e.target.value)} placeholder="4.5" />
        </div>
        <div>
          <label className="text-xs text-gray-500 flex items-center gap-1"><Link2 className="h-3 w-3" /> Link to existing asset/liability</label>
          <LinkPicker assets={assets} value={linkedId} onChange={setLinkedId} />
        </div>

        {assetClass === 'REAL_ESTATE' && (
          <>
            <div>
              <label className="text-xs text-gray-500">Property Type</label>
              <select className="border rounded px-2 py-1.5 text-sm w-full" value={propertyType} onChange={e => setPropertyType(e.target.value)}>
                {PROPERTY_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
              </select>
            </div>
            <div>
              <label className="text-xs text-gray-500">Address</label>
              <input className="border rounded px-2 py-1.5 text-sm w-full" value={propertyAddress} onChange={e => setPropertyAddress(e.target.value)} />
            </div>
            <div>
              <label className="text-xs text-gray-500">Zillow Estimate (CAD, optional)</label>
              <input className="border rounded px-2 py-1.5 text-sm w-full" value={zillowEstimate} onChange={e => setZillowEstimate(e.target.value)}
                placeholder="Paste from Zillow" />
            </div>
          </>
        )}

        {assetClass === 'LIFE_INSURANCE' && (
          <>
            <div>
              <label className="text-xs text-gray-500">Policy Number</label>
              <input className="border rounded px-2 py-1.5 text-sm w-full" value={policyNumber} onChange={e => setPolicyNumber(e.target.value)} />
            </div>
            <div>
              <label className="text-xs text-gray-500">Insurer</label>
              <input className="border rounded px-2 py-1.5 text-sm w-full" value={insurerName} onChange={e => setInsurerName(e.target.value)} />
            </div>
          </>
        )}

        {assetClass === 'LIABILITY' && (
          <>
            <div>
              <label className="text-xs text-gray-500">Lender</label>
              <input className="border rounded px-2 py-1.5 text-sm w-full" value={lenderName} onChange={e => setLenderName(e.target.value)} />
            </div>
            <div>
              <label className="text-xs text-gray-500">Maturity Date</label>
              <input type="date" className="border rounded px-2 py-1.5 text-sm w-full" value={maturityDate} onChange={e => setMaturityDate(e.target.value)} />
            </div>
          </>
        )}

        <div className="flex items-end gap-2">
          <label className="flex items-center gap-2 text-xs text-gray-600">
            <input type="checkbox" checked={isCorporate} onChange={e => setIsCorporate(e.target.checked)} />
            Held via a corporation
          </label>
        </div>
        {isCorporate && (
          <div>
            <label className="text-xs text-gray-500">Entity Name</label>
            <input className="border rounded px-2 py-1.5 text-sm w-full" value={entityName} onChange={e => setEntityName(e.target.value)}
              placeholder="e.g. Romanow Holdings Inc." />
          </div>
        )}

        <div className="sm:col-span-3">
          <label className="text-xs text-gray-500">Notes</label>
          <input className="border rounded px-2 py-1.5 text-sm w-full" value={notes} onChange={e => setNotes(e.target.value)} />
        </div>
      </div>

      <button
        onClick={() => createMut.mutate()}
        disabled={!name || !owner || !value || createMut.isPending}
        className="px-4 py-2 bg-blue-600 text-white text-sm rounded disabled:opacity-40"
      >
        {createMut.isPending ? 'Adding…' : 'Add'}
      </button>
      {createMut.isError && <p className="text-xs text-red-500">Failed to add — check the name isn't already in use.</p>}
    </div>
  )
}

// ─── Row: value editor + PDF + expandable ledger ──────────────────────────────
function AssetRow({ asset }: { asset: PersonalAsset }) {
  const qc = useQueryClient()
  const [expanded, setExpanded] = useState(false)
  const [editingValue, setEditingValue] = useState(false)
  const [newValue, setNewValue] = useState('')

  const updateMut = useMutation({
    mutationFn: () => updatePersonalAsset(asset.security_id, { value: parseFloat(newValue || '0') }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['personal-assets'] }); setEditingValue(false) },
  })
  const uploadMut = useMutation({
    mutationFn: (file: File) => uploadPersonalAssetFile(asset.security_id, file),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['personal-assets'] }),
  })
  const deleteFileMut = useMutation({
    mutationFn: () => deletePersonalAssetFile(asset.security_id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['personal-assets'] }),
  })

  return (
    <div className="border-b border-gray-100 last:border-0">
      <div className="flex items-center gap-3 py-3">
        {asset.asset_class === 'REAL_ESTATE' ? (
          <button onClick={() => setExpanded(e => !e)} className="text-gray-400 hover:text-gray-600">
            {expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
          </button>
        ) : <span className="w-4" />}

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-medium text-gray-800">{asset.name}</span>
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-100 text-gray-500">{CLASS_LABELS[asset.asset_class]}</span>
            {asset.is_corporate && (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-purple-100 text-purple-700">
                Held via: {asset.entity_name || 'corporation'}
              </span>
            )}
            {asset.linked_name && (
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-50 text-blue-600 flex items-center gap-1">
                <Link2 className="h-2.5 w-2.5" /> {asset.linked_name}
              </span>
            )}
          </div>
          <div className="text-xs text-gray-400 mt-0.5">
            {asset.owner} · {asset.property_address || asset.insurer_name || asset.lender_name || ''}
            {asset.zillow_estimate_cad && <> · Zillow est. {fmtCAD(asset.zillow_estimate_cad)}</>}
          </div>
        </div>

        <div className="text-right">
          {editingValue ? (
            <div className="flex items-center gap-1">
              <input autoFocus className="border rounded px-2 py-1 text-sm w-28" value={newValue}
                onChange={e => setNewValue(e.target.value)} placeholder={asset.current_value_cad ?? ''} />
              <button onClick={() => updateMut.mutate()} className="text-xs text-blue-600 font-medium">Save</button>
              <button onClick={() => setEditingValue(false)} className="text-xs text-gray-400">Cancel</button>
            </div>
          ) : (
            <button onClick={() => { setEditingValue(true); setNewValue('') }} className="text-right hover:underline">
              <div className={`font-semibold ${asset.asset_class === 'LIABILITY' ? 'text-red-500' : 'text-gray-800'}`}>
                {asset.asset_class === 'LIABILITY' ? '-' : ''}{fmtCAD(asset.current_value_cad ? Math.abs(parseFloat(asset.current_value_cad)).toString() : null)}
              </div>
              <div className="text-[10px] text-gray-400">{asset.value_updated_at?.slice(0, 10)}</div>
            </button>
          )}
        </div>

        <div className="flex items-center gap-1">
          {asset.original_filename ? (
            <>
              <button onClick={() => openPersonalAssetFile(asset.security_id)} title={asset.original_filename}
                className="p-1.5 text-blue-600 hover:bg-blue-50 rounded"><FileText className="h-3.5 w-3.5" /></button>
              <button onClick={() => deleteFileMut.mutate()} className="p-1.5 text-gray-300 hover:text-red-500 rounded">
                <Trash2 className="h-3.5 w-3.5" /></button>
            </>
          ) : (
            <label className="p-1.5 text-gray-400 hover:text-blue-600 rounded cursor-pointer" title="Upload document">
              <Upload className="h-3.5 w-3.5" />
              <input type="file" accept="application/pdf" className="hidden"
                onChange={e => { const f = e.target.files?.[0]; if (f) uploadMut.mutate(f) }} />
            </label>
          )}
        </div>
      </div>
      {expanded && asset.asset_class === 'REAL_ESTATE' && (
        <div className="pb-3"><IncomeLedger securityId={asset.security_id} /></div>
      )}
    </div>
  )
}

export default function PersonalAssetsTab() {
  const { data: assets = [], refetch } = useQuery({
    queryKey: ['personal-assets'],
    queryFn: getPersonalAssets,
  })

  const totalAssets = assets.filter(a => a.asset_class !== 'LIABILITY')
    .reduce((s, a) => s + (a.current_value_cad ? parseFloat(a.current_value_cad) : 0), 0)
  const totalLiabilities = assets.filter(a => a.asset_class === 'LIABILITY')
    .reduce((s, a) => s + (a.current_value_cad ? Math.abs(parseFloat(a.current_value_cad)) : 0), 0)

  return (
    <div className="space-y-5">
      <div>
        <h2 className="text-lg font-semibold text-gray-900">Personal Assets & Liabilities</h2>
        <p className="text-sm text-gray-500">
          Real estate, life insurance, and other assets — plus what's owed against them —
          feed the Dashboard's Net Worth figure alongside your investment accounts.
        </p>
      </div>

      <div className="flex gap-4 text-sm">
        <div className="bg-emerald-50 border border-emerald-200 rounded-lg px-4 py-2">
          <span className="text-emerald-700 font-semibold">{fmtCAD(String(totalAssets))}</span>
          <span className="text-emerald-600 text-xs ml-1">personal assets</span>
        </div>
        <div className="bg-red-50 border border-red-200 rounded-lg px-4 py-2">
          <span className="text-red-600 font-semibold">-{fmtCAD(String(totalLiabilities))}</span>
          <span className="text-red-500 text-xs ml-1">liabilities</span>
        </div>
      </div>

      <AssetForm assets={assets} onCreated={refetch} />

      <div className="bg-white border border-gray-200 rounded-xl px-5">
        {assets.length === 0 && <p className="text-sm text-gray-400 py-6 text-center">No personal assets or liabilities yet.</p>}
        {assets.map(a => <AssetRow key={a.security_id} asset={a} />)}
      </div>
    </div>
  )
}
