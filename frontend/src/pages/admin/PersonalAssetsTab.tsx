import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  getPersonalAssets, createPersonalAsset, updatePersonalAsset, deletePersonalAsset,
  uploadPersonalAssetFile, openPersonalAssetFile, deletePersonalAssetFile,
  getPersonalAssetIncomeEntries, createPersonalAssetIncomeEntry, deletePersonalAssetIncomeEntry,
  getSecurityPriceHistory, addHistoricalPrice, parseInsuranceStatement,
} from '../../api/client'
import type { PersonalAsset, PersonalAssetClass, PersonalAssetCreate, InsuranceStatementParsed } from '../../api/client'
import { ChevronDown, ChevronRight, FileText, Trash2, Upload, Link2, Pencil, Clock, Plus, X, ScanLine } from 'lucide-react'

const CLASS_LABELS: Record<PersonalAssetClass, string> = {
  REAL_ESTATE: 'Real Estate',
  LIFE_INSURANCE: 'Life Insurance',
  OTHER_ASSET: 'Other Asset',
  LIABILITY: 'Liability',
}

const PROPERTY_TYPES = ['Primary Residence', 'Rental Property', 'Land']
const today = () => new Date().toISOString().slice(0, 10)

const CURRENCIES = ['CAD', 'USD']

function fmtCAD(v: string | null): string {
  if (v == null) return '—'
  const n = parseFloat(v)
  return n.toLocaleString('en-CA', { style: 'currency', currency: 'CAD', maximumFractionDigits: 0 })
}

function fmtNative(v: string | null, currency: string): string {
  if (v == null) return '—'
  const n = parseFloat(v)
  return n.toLocaleString('en-US', { style: 'currency', currency, maximumFractionDigits: 0 })
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
  const [form, setForm] = useState({ entry_date: today(), category: 'RENT' as const, amount_cad: '', description: '' })

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

// ─── Value history (every asset class) — dated value points over time ────────
function ValueHistory({ asset }: { asset: PersonalAsset }) {
  const qc = useQueryClient()
  const { data: points = [] } = useQuery({
    queryKey: ['personal-asset-history', asset.security_id],
    queryFn: () => getSecurityPriceHistory(asset.security_id, 'max'),
  })
  const [entryDate, setEntryDate] = useState(today())
  const [amount, setAmount] = useState('')

  const isLiability = asset.asset_class === 'LIABILITY'
  const latestDate = points.length ? points[points.length - 1].date : null

  const addMut = useMutation({
    mutationFn: () => {
      const magnitude = Math.abs(parseFloat(amount || '0'))
      const signed = isLiability ? -magnitude : magnitude
      const isCurrentOrFuture = !latestDate || entryDate >= latestDate
      return isCurrentOrFuture
        // today-or-newest -> also updates the live current value
        ? updatePersonalAsset(asset.security_id, { value: magnitude, as_of: entryDate })
        // backdated -> historical point only, current value untouched
        : addHistoricalPrice(asset.security_id, { price_date: entryDate, price: signed, currency: asset.currency })
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['personal-asset-history', asset.security_id] })
      qc.invalidateQueries({ queryKey: ['personal-assets'] })
      setAmount('')
    },
  })

  return (
    <div className="bg-gray-50 rounded-lg p-4 space-y-3">
      <div className="flex items-center gap-2 text-sm font-semibold text-gray-700">
        <Clock className="h-3.5 w-3.5" /> Value History
      </div>
      <div className="flex flex-wrap gap-2 items-end text-xs">
        <input type="date" className="border rounded px-2 py-1" value={entryDate}
          onChange={e => setEntryDate(e.target.value)} />
        <input className="border rounded px-2 py-1 w-32" placeholder={`${isLiability ? 'Amount owed' : 'Value'} (${asset.currency})`}
          value={amount} onChange={e => setAmount(e.target.value)} />
        <button onClick={() => addMut.mutate()} disabled={!amount || addMut.isPending}
          className="px-3 py-1 bg-blue-600 text-white rounded disabled:opacity-40">Add value point</button>
      </div>
      <div className="divide-y divide-gray-200 max-h-48 overflow-auto">
        {[...points].reverse().map(p => (
          <div key={p.date} className="flex items-center justify-between py-1.5 text-xs">
            <span className="text-gray-400">{p.date}</span>
            <span className="font-medium">{p.close_cad != null ? fmtCAD(String(Math.abs(p.close_cad))) : '—'}</span>
          </div>
        ))}
        {points.length === 0 && <p className="text-xs text-gray-400 py-2">No value history yet.</p>}
      </div>
    </div>
  )
}

// ─── Statement upload + Gemini extraction (LIFE_INSURANCE rows only) ─────────
function StatementUpload({ securityId }: { securityId: number }) {
  const qc = useQueryClient()
  const [result, setResult] = useState<InsuranceStatementParsed | null>(null)

  const parseMut = useMutation({
    mutationFn: (file: File) => parseInsuranceStatement(securityId, file),
    onSuccess: (data) => {
      setResult(data.parsed)
      qc.invalidateQueries({ queryKey: ['personal-assets'] })
      qc.invalidateQueries({ queryKey: ['personal-asset-history', securityId] })
    },
  })

  return (
    <div className="bg-gray-50 rounded-lg p-4 space-y-3">
      <div className="flex items-center gap-2 text-sm font-semibold text-gray-700">
        <ScanLine className="h-3.5 w-3.5" /> Upload Statement
      </div>
      <p className="text-xs text-gray-500">
        Upload the insurer's statement PDF — fields (contract type, sum insured, death benefit,
        cash surrender value, insured, beneficiary) are extracted automatically and applied to
        this asset, with the statement stored as its attached document.
      </p>
      <label className="inline-flex items-center gap-2 px-3 py-1.5 bg-blue-600 text-white text-xs font-medium rounded cursor-pointer disabled:opacity-40 w-fit">
        <Upload className="h-3.5 w-3.5" />
        {parseMut.isPending ? 'Extracting…' : 'Choose PDF'}
        <input type="file" accept="application/pdf" className="hidden" disabled={parseMut.isPending}
          onChange={e => { const f = e.target.files?.[0]; if (f) parseMut.mutate(f) }} />
      </label>
      {parseMut.isError && (
        <p className="text-xs text-red-500">
          {(parseMut.error as { response?: { data?: { detail?: string } } })?.response?.data?.detail
            || 'Could not parse this statement.'}
        </p>
      )}
      {result && (
        <div className="text-xs text-gray-600 bg-white border border-gray-200 rounded p-3 space-y-1">
          <div className="font-medium text-gray-800">Extracted from statement dated {result.statement_date}:</div>
          {result.contract_type && <div>Contract Type: {result.contract_type}</div>}
          {result.policy_number && <div>Policy Number: {result.policy_number}</div>}
          {result.policy_issue_date && <div>Policy Issue Date: {result.policy_issue_date}</div>}
          {result.insured_name && <div>Insured: {result.insured_name}</div>}
          {result.beneficiary && <div>Beneficiary: {result.beneficiary}</div>}
          {result.sum_insured && <div>Sum Insured: {fmtCAD(result.sum_insured)}</div>}
          {result.death_benefit && <div>Death Benefit: {fmtCAD(result.death_benefit)}</div>}
          {result.cash_surrender_value && <div>Cash Surrender Value: {fmtCAD(result.cash_surrender_value)}</div>}
        </div>
      )}
    </div>
  )
}

// ─── Shared field set for both Add and Edit forms ────────────────────────────
interface FieldState {
  assetClass: PersonalAssetClass
  name: string
  owner: string
  value: string
  currency: string
  bookValue: string
  acquiredDate: string
  interestRate: string
  propertyType: string
  addressStreet: string
  addressCity: string
  addressProvince: string
  addressPostalCode: string
  addressCountry: string
  policyNumber: string
  insurerName: string
  contractType: string
  sumInsured: string
  insuredName: string
  lenderName: string
  maturityDate: string
  isCorporate: boolean
  entityName: string
  zillowEstimate: string
  linkedId: number | null
  notes: string
}

function blankFields(assetClass: PersonalAssetClass = 'REAL_ESTATE'): FieldState {
  return {
    assetClass, name: '', owner: '', value: '', currency: 'CAD', bookValue: '', acquiredDate: today(), interestRate: '',
    propertyType: PROPERTY_TYPES[0], addressStreet: '', addressCity: '', addressProvince: '',
    addressPostalCode: '', addressCountry: '', policyNumber: '', insurerName: '',
    contractType: '', sumInsured: '', insuredName: '', lenderName: '',
    maturityDate: '', isCorporate: false, entityName: '', zillowEstimate: '', linkedId: null, notes: '',
  }
}

function fieldsFromAsset(a: PersonalAsset): FieldState {
  return {
    assetClass: a.asset_class, name: a.name || '', owner: a.owner || '',
    value: a.current_value ? Math.abs(parseFloat(a.current_value)).toString() : '',
    currency: a.currency || 'CAD',
    bookValue: a.purchase_price ? Math.abs(parseFloat(a.purchase_price)).toString() : '',
    acquiredDate: a.acquired_date || today(),
    interestRate: a.interest_rate || '',
    propertyType: a.property_type || PROPERTY_TYPES[0],
    addressStreet: a.address_street || '', addressCity: a.address_city || '',
    addressProvince: a.address_province || '', addressPostalCode: a.address_postal_code || '',
    addressCountry: a.address_country || '',
    policyNumber: a.policy_number || '', insurerName: a.insurer_name || '',
    contractType: a.contract_type || '',
    sumInsured: a.sum_insured_cad ? Math.abs(parseFloat(a.sum_insured_cad)).toString() : '',
    insuredName: a.insured_name || '',
    lenderName: a.lender_name || '', maturityDate: a.maturity_date || '',
    isCorporate: a.is_corporate, entityName: a.entity_name || '',
    zillowEstimate: a.zillow_estimate_cad || '', linkedId: a.linked_security_id, notes: a.notes || '',
  }
}

function AssetFields({ f, setF, assets, excludeId, lockClass }: {
  f: FieldState; setF: (fn: (f: FieldState) => FieldState) => void
  assets: PersonalAsset[]; excludeId?: number; lockClass?: boolean
}) {
  const set = <K extends keyof FieldState>(k: K, v: FieldState[K]) => setF(prev => ({ ...prev, [k]: v }))
  return (
    <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
      <div>
        <label className="text-xs text-gray-500">Type</label>
        <select className="border rounded px-2 py-1.5 text-sm w-full" value={f.assetClass} disabled={lockClass}
          onChange={e => set('assetClass', e.target.value as PersonalAssetClass)}>
          {(Object.keys(CLASS_LABELS) as PersonalAssetClass[]).map(c => (
            <option key={c} value={c}>{CLASS_LABELS[c]}</option>
          ))}
        </select>
      </div>
      <div>
        <label className="text-xs text-gray-500">Name</label>
        <input className="border rounded px-2 py-1.5 text-sm w-full" value={f.name} onChange={e => set('name', e.target.value)}
          placeholder={f.assetClass === 'LIABILITY' ? 'e.g. Mortgage - 123 Main St' : 'e.g. 123 Main St'} />
      </div>
      <div>
        <label className="text-xs text-gray-500">Owner</label>
        <input className="border rounded px-2 py-1.5 text-sm w-full" value={f.owner} onChange={e => set('owner', e.target.value)} placeholder="Brian" />
      </div>
      <div>
        <label className="text-xs text-gray-500">{f.assetClass === 'LIABILITY' ? 'Amount Owed' : 'Current Value'}</label>
        <input className="border rounded px-2 py-1.5 text-sm w-full" value={f.value} onChange={e => set('value', e.target.value)} placeholder="650000" />
      </div>
      <div>
        <label className="text-xs text-gray-500">Currency</label>
        <select className="border rounded px-2 py-1.5 text-sm w-full" value={f.currency} onChange={e => set('currency', e.target.value)}>
          {CURRENCIES.map(c => <option key={c} value={c}>{c}</option>)}
        </select>
      </div>
      {(f.assetClass === 'REAL_ESTATE' || f.assetClass === 'OTHER_ASSET') && (
        <div>
          <label className="text-xs text-gray-500">Initial Book Value ({f.currency}, optional)</label>
          <input className="border rounded px-2 py-1.5 text-sm w-full" value={f.bookValue}
            onChange={e => set('bookValue', e.target.value)} placeholder="e.g. original purchase price" />
        </div>
      )}
      <div>
        <label className="text-xs text-gray-500">Acquired / Setup Date</label>
        <input type="date" className="border rounded px-2 py-1.5 text-sm w-full" value={f.acquiredDate}
          onChange={e => set('acquiredDate', e.target.value)} />
      </div>
      <div>
        <label className="text-xs text-gray-500">Interest Rate % (optional)</label>
        <input className="border rounded px-2 py-1.5 text-sm w-full" value={f.interestRate} onChange={e => set('interestRate', e.target.value)} placeholder="4.5" />
      </div>
      <div>
        <label className="text-xs text-gray-500 flex items-center gap-1"><Link2 className="h-3 w-3" /> Link to existing asset/liability</label>
        <LinkPicker assets={assets} value={f.linkedId} onChange={id => set('linkedId', id)} excludeId={excludeId} />
      </div>

      {f.assetClass === 'REAL_ESTATE' && (
        <>
          <div>
            <label className="text-xs text-gray-500">Property Type</label>
            <select className="border rounded px-2 py-1.5 text-sm w-full" value={f.propertyType} onChange={e => set('propertyType', e.target.value)}>
              {PROPERTY_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
            </select>
          </div>
          <div>
            <label className="text-xs text-gray-500">Street</label>
            <input className="border rounded px-2 py-1.5 text-sm w-full" value={f.addressStreet} onChange={e => set('addressStreet', e.target.value)} />
          </div>
          <div>
            <label className="text-xs text-gray-500">City</label>
            <input className="border rounded px-2 py-1.5 text-sm w-full" value={f.addressCity} onChange={e => set('addressCity', e.target.value)} />
          </div>
          <div>
            <label className="text-xs text-gray-500">Province / State</label>
            <input className="border rounded px-2 py-1.5 text-sm w-full" value={f.addressProvince} onChange={e => set('addressProvince', e.target.value)} />
          </div>
          <div>
            <label className="text-xs text-gray-500">Postal / ZIP Code</label>
            <input className="border rounded px-2 py-1.5 text-sm w-full" value={f.addressPostalCode} onChange={e => set('addressPostalCode', e.target.value)} />
          </div>
          <div>
            <label className="text-xs text-gray-500">Country</label>
            <input className="border rounded px-2 py-1.5 text-sm w-full" value={f.addressCountry} onChange={e => set('addressCountry', e.target.value)} />
          </div>
          <div>
            <label className="text-xs text-gray-500">Zillow Estimate (CAD, optional)</label>
            <input className="border rounded px-2 py-1.5 text-sm w-full" value={f.zillowEstimate} onChange={e => set('zillowEstimate', e.target.value)}
              placeholder="Paste from Zillow" />
          </div>
        </>
      )}

      {f.assetClass === 'LIFE_INSURANCE' && (
        <>
          <div>
            <label className="text-xs text-gray-500">Policy Number</label>
            <input className="border rounded px-2 py-1.5 text-sm w-full" value={f.policyNumber} onChange={e => set('policyNumber', e.target.value)} />
          </div>
          <div>
            <label className="text-xs text-gray-500">Insurer</label>
            <input className="border rounded px-2 py-1.5 text-sm w-full" value={f.insurerName} onChange={e => set('insurerName', e.target.value)} />
          </div>
          <div>
            <label className="text-xs text-gray-500">Type of Contract</label>
            <input className="border rounded px-2 py-1.5 text-sm w-full" value={f.contractType} onChange={e => set('contractType', e.target.value)}
              placeholder="e.g. Perspecta - Single Life" />
          </div>
          <div>
            <label className="text-xs text-gray-500">Insured</label>
            <input className="border rounded px-2 py-1.5 text-sm w-full" value={f.insuredName} onChange={e => set('insuredName', e.target.value)} />
          </div>
          <div>
            <label className="text-xs text-gray-500">Sum Insured (CAD, optional)</label>
            <input className="border rounded px-2 py-1.5 text-sm w-full" value={f.sumInsured} onChange={e => set('sumInsured', e.target.value)} />
          </div>
        </>
      )}

      {f.assetClass === 'LIABILITY' && (
        <>
          <div>
            <label className="text-xs text-gray-500">Lender</label>
            <input className="border rounded px-2 py-1.5 text-sm w-full" value={f.lenderName} onChange={e => set('lenderName', e.target.value)} />
          </div>
          <div>
            <label className="text-xs text-gray-500">Maturity Date</label>
            <input type="date" className="border rounded px-2 py-1.5 text-sm w-full" value={f.maturityDate} onChange={e => set('maturityDate', e.target.value)} />
          </div>
        </>
      )}

      <div className="flex items-end gap-2">
        <label className="flex items-center gap-2 text-xs text-gray-600">
          <input type="checkbox" checked={f.isCorporate} onChange={e => set('isCorporate', e.target.checked)} />
          Held via a corporation
        </label>
      </div>
      {f.isCorporate && (
        <div>
          <label className="text-xs text-gray-500">Entity Name</label>
          <input className="border rounded px-2 py-1.5 text-sm w-full" value={f.entityName} onChange={e => set('entityName', e.target.value)}
            placeholder="e.g. Romanow Holdings Inc." />
        </div>
      )}

      <div className="sm:col-span-3">
        <label className="text-xs text-gray-500">Notes</label>
        <input className="border rounded px-2 py-1.5 text-sm w-full" value={f.notes} onChange={e => set('notes', e.target.value)} />
      </div>
    </div>
  )
}

function fieldsToPayload(f: FieldState): Omit<PersonalAssetCreate, 'asset_class' | 'name' | 'owner' | 'value'> {
  const hasBookValue = (f.assetClass === 'REAL_ESTATE' || f.assetClass === 'OTHER_ASSET') && !!f.bookValue
  return {
    acquired_date: f.acquiredDate || undefined,
    interest_rate: f.interestRate ? parseFloat(f.interestRate) : undefined,
    purchase_price: hasBookValue ? parseFloat(f.bookValue) : undefined,
    purchase_date: hasBookValue ? f.acquiredDate || undefined : undefined,
    property_type: f.assetClass === 'REAL_ESTATE' ? f.propertyType : undefined,
    address_street: f.assetClass === 'REAL_ESTATE' ? f.addressStreet || undefined : undefined,
    address_city: f.assetClass === 'REAL_ESTATE' ? f.addressCity || undefined : undefined,
    address_province: f.assetClass === 'REAL_ESTATE' ? f.addressProvince || undefined : undefined,
    address_postal_code: f.assetClass === 'REAL_ESTATE' ? f.addressPostalCode || undefined : undefined,
    address_country: f.assetClass === 'REAL_ESTATE' ? f.addressCountry || undefined : undefined,
    policy_number: f.assetClass === 'LIFE_INSURANCE' ? f.policyNumber || undefined : undefined,
    insurer_name: f.assetClass === 'LIFE_INSURANCE' ? f.insurerName || undefined : undefined,
    contract_type: f.assetClass === 'LIFE_INSURANCE' ? f.contractType || undefined : undefined,
    sum_insured_cad: f.assetClass === 'LIFE_INSURANCE' && f.sumInsured ? parseFloat(f.sumInsured) : undefined,
    insured_name: f.assetClass === 'LIFE_INSURANCE' ? f.insuredName || undefined : undefined,
    lender_name: f.assetClass === 'LIABILITY' ? f.lenderName || undefined : undefined,
    maturity_date: f.assetClass === 'LIABILITY' && f.maturityDate ? f.maturityDate : undefined,
    is_corporate: f.isCorporate,
    entity_name: f.isCorporate ? f.entityName || undefined : undefined,
    zillow_estimate_cad: f.assetClass === 'REAL_ESTATE' && f.zillowEstimate ? parseFloat(f.zillowEstimate) : undefined,
    linked_security_id: f.linkedId ?? undefined,
    notes: f.notes || undefined,
  }
}

// ─── Add form ─────────────────────────────────────────────────────────────────
function AssetForm({ assets, onCreated }: { assets: PersonalAsset[]; onCreated: () => void }) {
  const [f, setF] = useState<FieldState>(blankFields())

  const createMut = useMutation({
    mutationFn: () => createPersonalAsset({
      asset_class: f.assetClass, name: f.name, owner: f.owner, value: parseFloat(f.value || '0'),
      currency: f.currency, ...fieldsToPayload(f),
    }),
    onSuccess: () => { onCreated(); setF(blankFields(f.assetClass)) },
  })

  return (
    <div className="bg-white border border-gray-200 rounded-xl p-5 space-y-4">
      <h3 className="font-semibold text-gray-800">Add a personal asset or liability</h3>
      <AssetFields f={f} setF={setF} assets={assets} />
      <button
        onClick={() => createMut.mutate()}
        disabled={!f.name || !f.owner || !f.value || createMut.isPending}
        className="px-4 py-2 bg-blue-600 text-white text-sm rounded disabled:opacity-40"
      >
        {createMut.isPending ? 'Adding…' : 'Add'}
      </button>
      {createMut.isError && <p className="text-xs text-red-500">Failed to add — check the name isn't already in use.</p>}
    </div>
  )
}

// ─── Edit form (pre-filled, inline within a row) ──────────────────────────────
function EditForm({ asset, assets, onDone }: { asset: PersonalAsset; assets: PersonalAsset[]; onDone: () => void }) {
  const qc = useQueryClient()
  const [f, setF] = useState<FieldState>(fieldsFromAsset(asset))

  const saveMut = useMutation({
    mutationFn: () => updatePersonalAsset(asset.security_id, {
      name: f.name, value: parseFloat(f.value || '0'), as_of: today(),
      currency: f.currency, ...fieldsToPayload(f),
    }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['personal-assets'] })
      qc.invalidateQueries({ queryKey: ['personal-asset-history', asset.security_id] })
      onDone()
    },
  })

  return (
    <div className="bg-blue-50/50 border border-blue-100 rounded-lg p-4 space-y-3 mb-3">
      <AssetFields f={f} setF={setF} assets={assets} excludeId={asset.security_id} lockClass />
      <div className="flex items-center gap-2">
        <button onClick={() => saveMut.mutate()} disabled={saveMut.isPending}
          className="px-4 py-1.5 bg-blue-600 text-white text-sm rounded disabled:opacity-40">
          {saveMut.isPending ? 'Saving…' : 'Save changes'}
        </button>
        <button onClick={onDone} className="px-3 py-1.5 text-sm text-gray-500">Cancel</button>
      </div>
      <p className="text-[11px] text-gray-400">
        Saving here also records today's value as a new value-history point. To back-date a
        value change, use Value History below instead.
      </p>
    </div>
  )
}

// ─── Row: edit form + PDF + expandable ledger/history ─────────────────────────
function AssetRow({ asset, assets }: { asset: PersonalAsset; assets: PersonalAsset[] }) {
  const qc = useQueryClient()
  const [expanded, setExpanded] = useState(false)
  const [editing, setEditing] = useState(false)

  const uploadMut = useMutation({
    mutationFn: (file: File) => uploadPersonalAssetFile(asset.security_id, file),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['personal-assets'] }),
  })
  const deleteFileMut = useMutation({
    mutationFn: () => deletePersonalAssetFile(asset.security_id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['personal-assets'] }),
  })
  const deleteMut = useMutation({
    mutationFn: () => deletePersonalAsset(asset.security_id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['personal-assets'] }),
  })

  const addressLine = [asset.address_street, asset.address_city, asset.address_province, asset.address_postal_code]
    .filter(Boolean).join(', ')

  return (
    <div className="border-b border-gray-100 last:border-0">
      <div className="flex items-center gap-3 py-3">
        <button onClick={() => setExpanded(e => !e)} className="text-gray-400 hover:text-gray-600">
          {expanded ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        </button>

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
            {asset.owner} · {addressLine || asset.insurer_name || asset.lender_name || ''}
            {asset.zillow_estimate_cad && <> · Zillow est. {fmtCAD(asset.zillow_estimate_cad)}</>}
            {asset.acquired_date && <> · Acquired {asset.acquired_date}</>}
          </div>
        </div>

        <div className="text-right">
          <div className={`font-semibold ${asset.asset_class === 'LIABILITY' ? 'text-red-500' : 'text-gray-800'}`}>
            {asset.asset_class === 'LIABILITY' ? '-' : ''}{fmtNative(asset.current_value ? Math.abs(parseFloat(asset.current_value)).toString() : null, asset.currency)}
          </div>
          {asset.currency !== 'CAD' && (
            <div className="text-[10px] text-gray-400">
              = {fmtCAD(asset.current_value_cad ? Math.abs(parseFloat(asset.current_value_cad)).toString() : null)}
            </div>
          )}
          <div className="text-[10px] text-gray-400">{asset.value_updated_at?.slice(0, 10)}</div>
        </div>

        <div className="flex items-center gap-1">
          <button onClick={() => { setEditing(e => !e); setExpanded(true) }} className="p-1.5 text-gray-400 hover:text-blue-600 rounded" title="Edit">
            <Pencil className="h-3.5 w-3.5" />
          </button>
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
          <button
            onClick={() => {
              if (window.confirm(`Delete "${asset.name}"? This removes its value history and any linked document — this can't be undone.`)) {
                deleteMut.mutate()
              }
            }}
            disabled={deleteMut.isPending}
            className="p-1.5 text-gray-300 hover:text-red-500 rounded disabled:opacity-40"
            title="Delete"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>
      {expanded && (
        <div className="pb-3 space-y-3">
          {editing && <EditForm asset={asset} assets={assets} onDone={() => setEditing(false)} />}
          {asset.asset_class === 'REAL_ESTATE' && <IncomeLedger securityId={asset.security_id} />}
          {asset.asset_class === 'LIFE_INSURANCE' && (
            (asset.contract_type || asset.insured_name || asset.sum_insured_cad || asset.death_benefit_cad) && (
              <div className="bg-gray-50 rounded-lg p-4 text-xs grid grid-cols-2 sm:grid-cols-3 gap-3">
                {asset.contract_type && <div><div className="text-gray-400">Contract Type</div><div className="font-medium text-gray-800">{asset.contract_type}</div></div>}
                {asset.insured_name && <div><div className="text-gray-400">Insured</div><div className="font-medium text-gray-800">{asset.insured_name}</div></div>}
                {asset.beneficiary && <div><div className="text-gray-400">Beneficiary</div><div className="font-medium text-gray-800">{asset.beneficiary}</div></div>}
                {asset.sum_insured_cad && <div><div className="text-gray-400">Sum Insured</div><div className="font-medium text-gray-800">{fmtCAD(asset.sum_insured_cad)}</div></div>}
                {asset.death_benefit_cad && <div><div className="text-gray-400">Death Benefit</div><div className="font-medium text-gray-800">{fmtCAD(asset.death_benefit_cad)}</div></div>}
              </div>
            )
          )}
          {asset.asset_class === 'LIFE_INSURANCE' && <StatementUpload securityId={asset.security_id} />}
          <ValueHistory asset={asset} />
        </div>
      )}
    </div>
  )
}

const GROUP_ORDER: PersonalAssetClass[] = ['REAL_ESTATE', 'LIFE_INSURANCE', 'OTHER_ASSET', 'LIABILITY']

export default function PersonalAssetsTab() {
  const { data: assets = [], refetch } = useQuery({
    queryKey: ['personal-assets'],
    queryFn: getPersonalAssets,
  })
  const [showAdd, setShowAdd] = useState(false)

  const totalAssets = assets.filter(a => a.asset_class !== 'LIABILITY')
    .reduce((s, a) => s + (a.current_value_cad ? parseFloat(a.current_value_cad) : 0), 0)
  const totalLiabilities = assets.filter(a => a.asset_class === 'LIABILITY')
    .reduce((s, a) => s + (a.current_value_cad ? Math.abs(parseFloat(a.current_value_cad)) : 0), 0)

  return (
    <div className="space-y-5">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-gray-900">Other Assets and Liabilities</h2>
          <p className="text-sm text-gray-500">
            Real estate, life insurance, and other assets — plus what's owed against them —
            feed the Dashboard's Net Worth figure alongside your investment accounts.
          </p>
        </div>
        <button
          onClick={() => setShowAdd(s => !s)}
          className="flex items-center gap-1.5 px-3 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 flex-shrink-0"
        >
          {showAdd ? <X className="h-4 w-4" /> : <Plus className="h-4 w-4" />}
          {showAdd ? 'Cancel' : 'Add'}
        </button>
      </div>

      <div className="flex gap-4 text-sm">
        <div className="bg-emerald-50 border border-emerald-200 rounded-lg px-4 py-2">
          <span className="text-emerald-700 font-semibold">{fmtCAD(String(totalAssets))}</span>
          <span className="text-emerald-600 text-xs ml-1">other assets</span>
        </div>
        <div className="bg-red-50 border border-red-200 rounded-lg px-4 py-2">
          <span className="text-red-600 font-semibold">-{fmtCAD(String(totalLiabilities))}</span>
          <span className="text-red-500 text-xs ml-1">liabilities</span>
        </div>
      </div>

      {showAdd && (
        <AssetForm assets={assets} onCreated={() => { refetch(); setShowAdd(false) }} />
      )}

      {assets.length === 0 && (
        <div className="bg-white border border-gray-200 rounded-xl px-5">
          <p className="text-sm text-gray-400 py-6 text-center">No other assets or liabilities yet.</p>
        </div>
      )}

      {GROUP_ORDER.map(cls => {
        const group = assets.filter(a => a.asset_class === cls)
        if (group.length === 0) return null
        return (
          <div key={cls}>
            <h3 className="text-xs font-semibold text-gray-400 uppercase tracking-wide mb-2">{CLASS_LABELS[cls]}</h3>
            <div className="bg-white border border-gray-200 rounded-xl px-5">
              {group.map(a => <AssetRow key={a.security_id} asset={a} assets={assets} />)}
            </div>
          </div>
        )
      })}
    </div>
  )
}
