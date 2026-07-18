import { useState, useMemo, useEffect, useRef, useCallback } from 'react'
import { useDropzone } from 'react-dropzone'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Trash2, AlertTriangle, X, Edit2, Check, RefreshCw, Sparkles, Search, FileText, Upload, ExternalLink, Loader2 } from 'lucide-react'
import {
  getSecurities, createSecurity, updateSecurity, deleteSecurity, deleteUnusedSecurities, mergeSecurities,
  fetchSecurityYahooInfo, searchYahooSecurities,
  getNoteDetails, updateNoteDetails, uploadNoteDetailsFile, openNoteDetailsFile, deleteNoteDetailsFile,
  type NoteDetails,
  fetchPriceHistory, getPriceJob,
} from '../../api/client'
import type { Security, YahooSearchResult } from '../../api/client'
import { ConfirmDialog, useSortState, SortTh, sortRows } from './shared'

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
function SecurityPicker({ securities, value, onChange, placeholder }: {
  securities: Security[]; value: number | null; onChange: (id: number | null) => void; placeholder: string
}) {
  const [q, setQ] = useState('')
  const [open, setOpen] = useState(false)
  const label = (s: Security) => `${s.name || s.ticker} — ${s.ticker}`
  const selected = securities.find(s => s.id === value) || null
  const matches = (q.trim()
    ? securities.filter(s => label(s).toLowerCase().includes(q.toLowerCase()))
    : securities).slice(0, 20)
  return (
    <div className="relative">
      <input
        className="border border-gray-200 rounded px-2 py-1.5 text-sm w-72"
        placeholder={placeholder}
        value={selected && !open ? label(selected) : q}
        onChange={e => { setQ(e.target.value); setOpen(true); if (value) onChange(null) }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
      />
      {open && matches.length > 0 && (
        <div className="absolute z-20 mt-1 max-h-64 overflow-auto bg-white border border-gray-200 rounded shadow-lg w-72">
          {matches.map(s => (
            <button key={s.id} type="button"
              onMouseDown={e => { e.preventDefault(); onChange(s.id); setQ(''); setOpen(false) }}
              className="block w-full text-left px-3 py-1.5 text-sm hover:bg-blue-50 truncate">
              {s.name || s.ticker} <span className="text-gray-400">— {s.ticker}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

export default function SecuritiesTab() {
  const qc = useQueryClient()
  const [search, setSearch] = useState('')
  const { data: securities = [] } = useQuery({
    queryKey: ['securities', search],
    queryFn: () => getSecurities({ search: search || undefined }),
  })
  // Full (unfiltered) list for the merge pickers, so they're not limited by the ticker search.
  const { data: allSecurities = [] } = useQuery({ queryKey: ['securities', 'all'], queryFn: () => getSecurities() })
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
  // ── Merge securities (e.g. a Plaid mis-named holding into your real fund) ──
  const [mergeSource, setMergeSource] = useState<number | null>(null)
  const [mergeTarget, setMergeTarget] = useState<number | null>(null)
  const [mergeMsg, setMergeMsg] = useState<string | null>(null)
  const mergeMut = useMutation({
    mutationFn: () => mergeSecurities(mergeSource!, mergeTarget!),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ['securities'] })
      setMergeMsg(`Merged ${r.merged} into ${r.into} (${r.transactions_moved} transactions moved).`)
      setMergeSource(null); setMergeTarget(null)
    },
    onError: (err: { response?: { data?: { detail?: string } } }) =>
      setMergeMsg(err?.response?.data?.detail || 'Merge failed'),
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

  // ── Note Details modal state ────────────────────────────────────────────────
  const [noteDetailsFor, setNoteDetailsFor] = useState<Security | null>(null)
  const [noteDetailsForm, setNoteDetailsForm] = useState<Partial<NoteDetails>>({})
  const [noteDetailsUploading, setNoteDetailsUploading] = useState(false)
  const [noteDetailsError, setNoteDetailsError] = useState<string | null>(null)

  const { data: noteDetailsData } = useQuery({
    queryKey: ['note-details', noteDetailsFor?.id],
    queryFn: () => getNoteDetails(noteDetailsFor!.id),
    enabled: !!noteDetailsFor,
  })
  // Only seed the form from the fetched row ONCE per open — a background refetch (e.g.
  // after uploading a file) must not clobber fields the user just got auto-filled/edited.
  const noteDetailsInitialized = useRef(false)
  useEffect(() => {
    if (noteDetailsData && !noteDetailsInitialized.current) {
      setNoteDetailsForm(noteDetailsData)
      noteDetailsInitialized.current = true
    }
  }, [noteDetailsData])

  const openNoteDetails = (sec: Security) => {
    setNoteDetailsFor(sec)
    setNoteDetailsForm({})
    setNoteDetailsError(null)
    noteDetailsInitialized.current = false
  }

  const saveNoteDetailsMut = useMutation({
    mutationFn: () => updateNoteDetails(noteDetailsFor!.id, noteDetailsForm),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['note-details', noteDetailsFor?.id] })
      setNoteDetailsFor(null)   // save and close
    },
    onError: () => setNoteDetailsError('Failed to save.'),
  })

  const uploadNoteFileMut = useMutation({
    mutationFn: (file: File) => uploadNoteDetailsFile(noteDetailsFor!.id, file),
    onMutate: () => { setNoteDetailsUploading(true); setNoteDetailsError(null) },
    onSuccess: (data) => {
      setNoteDetailsUploading(false)
      const { extracted, ...fileMeta } = data
      setNoteDetailsForm(f => ({
        ...f,
        original_filename: fileMeta.original_filename,
        content_type: fileMeta.content_type,
        byte_size: fileMeta.byte_size,
        uploaded_at: fileMeta.uploaded_at,
        // Merge only the fields Gemini actually found — never overwrite with a null and
        // wipe out something the user already typed.
        ...(extracted ? Object.fromEntries(Object.entries(extracted).filter(([, v]) => v != null)) : {}),
      }))
      qc.invalidateQueries({ queryKey: ['note-details', noteDetailsFor?.id] })
    },
    onError: () => { setNoteDetailsUploading(false); setNoteDetailsError('Upload failed — please upload a PDF.') },
  })

  const deleteNoteFileMut = useMutation({
    mutationFn: () => deleteNoteDetailsFile(noteDetailsFor!.id),
    onSuccess: () => {
      setNoteDetailsForm(f => ({ ...f, original_filename: null, content_type: null, byte_size: null, uploaded_at: null }))
      qc.invalidateQueries({ queryKey: ['note-details', noteDetailsFor?.id] })
    },
  })

  // Drag-and-drop for the info-sheet PDF — click-to-browse stays on the plain <input>
  // labels below (noClick/noKeyboard so dropzone only handles the drag/drop gesture,
  // and clicking "View"/"Remove" inside the same container doesn't open a file dialog).
  const onDropNoteFile = useCallback((files: File[]) => { if (files.length) uploadNoteFileMut.mutate(files[0]) },
    [uploadNoteFileMut])
  const { getRootProps: getNoteDropRootProps, isDragActive: isNoteDragActive } = useDropzone({
    onDrop: onDropNoteFile,
    accept: { 'application/pdf': ['.pdf'] },
    multiple: false,
    noClick: true,
    noKeyboard: true,
    disabled: noteDetailsUploading,
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
            {['EQUITY', 'ETF', 'MUTUAL_FUND', 'FUND', 'OPTION', 'CURRENCY', 'MORTGAGE', 'FIXED_INCOME', 'STRUCTURED_NOTE', 'SAVINGS_ACCOUNT', 'REAL_ESTATE', 'LIFE_INSURANCE', 'OTHER_ASSET', 'LIABILITY'].map(t => <option key={t} value={t}>{t}</option>)}
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
        <h3 className="font-medium text-gray-700 mb-3">Merge securities</h3>
        <p className="text-xs text-gray-500 mb-3">
          Move one security's transactions, prices and Plaid mapping onto another, then delete it —
          e.g. join a Plaid-mis-named holding (“Cluster Group Holdings”/CLUS) onto your real fund.
          Type to search either field.
        </p>
        <div className="flex flex-wrap items-end gap-3">
          <div className="flex flex-col gap-1">
            <label className="text-xs text-gray-500">Merge this (deleted)</label>
            <SecurityPicker securities={(allSecurities as Security[]).filter(s => !s.is_option)}
              value={mergeSource} onChange={setMergeSource} placeholder="Search source…" />
          </div>
          <span className="pb-2 text-gray-400">→ into →</span>
          <div className="flex flex-col gap-1">
            <label className="text-xs text-gray-500">Keep this (target)</label>
            <SecurityPicker securities={(allSecurities as Security[]).filter(s => !s.is_option)}
              value={mergeTarget} onChange={setMergeTarget} placeholder="Search target…" />
          </div>
          <button
            onClick={() => { if (mergeSource && mergeTarget && confirm('Merge and delete the source security? This moves its transactions/prices to the target.')) { setMergeMsg(null); mergeMut.mutate() } }}
            disabled={!mergeSource || !mergeTarget || mergeSource === mergeTarget || mergeMut.isPending}
            className="text-sm bg-gray-700 text-white rounded px-3 py-1.5 hover:bg-gray-800 disabled:opacity-50">
            {mergeMut.isPending ? 'Merging…' : 'Merge'}
          </button>
        </div>
        {mergeMsg && <p className="text-xs text-gray-600 mt-2">{mergeMsg}</p>}
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
            {['EQUITY', 'ETF', 'MUTUAL_FUND', 'FUND', 'OPTION', 'CURRENCY', 'MORTGAGE', 'FIXED_INCOME', 'STRUCTURED_NOTE', 'SAVINGS_ACCOUNT', 'REAL_ESTATE', 'LIFE_INSURANCE', 'OTHER_ASSET', 'LIABILITY'].map(t => <option key={t}>{t}</option>)}
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
              <SortTh label="Interest Rate (%)" col="interest_rate" sort={sort} toggle={toggle} className="px-3 py-3 text-right" />
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
                              {['EQUITY', 'ETF', 'MUTUAL_FUND', 'FUND', 'OPTION', 'CURRENCY', 'MORTGAGE', 'FIXED_INCOME', 'STRUCTURED_NOTE', 'SAVINGS_ACCOUNT', 'REAL_ESTATE', 'LIFE_INSURANCE', 'OTHER_ASSET', 'LIABILITY'].map(t => <option key={t}>{t}</option>)}
                            </select></td>
                            <td className="px-3 py-2"><input className="border rounded px-2 py-1 text-xs w-24"
                              list="exchange-options"
                              value={editData.exchange ?? (s.exchange || '')} onChange={e => setEditData(d => ({ ...d, exchange: e.target.value.toUpperCase() }))} /></td>
                            <td className="px-3 py-2"><select className="border rounded px-2 py-1 text-xs" value={editData.currency ?? (s.currency || 'CAD')}
                              onChange={e => setEditData(d => ({ ...d, currency: e.target.value }))}>
                              <option>CAD</option><option>USD</option>
                            </select></td>
                            <td className="px-3 py-2 text-right">
                              <input type="number" step="0.01" className="border rounded px-2 py-1 text-xs w-20 text-right"
                                placeholder="—"
                                title="Annual coupon/interest rate (%) — for structured notes, mortgages, and other manually-priced interest-bearing securities. Used by the Projected Income report."
                                value={editData.interest_rate ?? (s.interest_rate ?? '')}
                                onChange={e => setEditData(d => ({ ...d, interest_rate: e.target.value || null }))} />
                            </td>
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
                            <td className="px-3 py-2.5 text-right text-xs text-gray-600">{s.interest_rate ? `${s.interest_rate}%` : '—'}</td>
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
                                  onClick={() => openNoteDetails(s)}
                                  title="Note details — term-sheet fields + info-sheet PDF"
                                  className="text-indigo-400 hover:text-indigo-600"
                                >
                                  <FileText className="h-3.5 w-3.5" />
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
                    <tr><td colSpan={8} className="px-3 py-8 text-center text-sm text-gray-400">No securities match the current filters.</td></tr>
                  )}
                  <tr>
                    <td colSpan={8} className="px-3 py-2 border-t border-gray-200 bg-gray-50">
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

      {/* Note Details Modal */}
      {noteDetailsFor && (
        <div className="fixed inset-0 z-50 flex items-start justify-center pt-12 bg-black/30 overflow-y-auto" onClick={() => setNoteDetailsFor(null)}>
          <div className="bg-white rounded-xl shadow-2xl w-[640px] max-h-[85vh] flex flex-col my-8" onClick={e => e.stopPropagation()}>
            {/* Header */}
            <div className="flex items-center justify-between px-4 py-3 border-b">
              <div className="flex items-center gap-2">
                <FileText className="h-4 w-4 text-indigo-500" />
                <span className="font-semibold text-sm text-gray-800">
                  Note Details — {noteDetailsFor.ticker}
                </span>
              </div>
              <button onClick={() => setNoteDetailsFor(null)} className="text-gray-400 hover:text-gray-600"><X className="h-4 w-4" /></button>
            </div>

            <div className="overflow-y-auto px-4 py-4 space-y-5">
              {/* Info-sheet file section — whole box is a drop target (click-to-browse
                  stays on the labels below, via noClick) */}
              <div
                {...getNoteDropRootProps()}
                className={`rounded-lg p-3 border transition-colors ${
                  isNoteDragActive ? 'bg-blue-50 border-blue-400 border-dashed' : 'bg-gray-50 border-gray-200'
                }`}
              >
                <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">
                  Info Sheet {isNoteDragActive && <span className="text-blue-600 normal-case font-normal">— drop PDF to upload</span>}
                </p>
                {noteDetailsForm.original_filename ? (
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm text-gray-700 truncate">{noteDetailsForm.original_filename}</span>
                    <div className="flex gap-2 flex-shrink-0">
                      <button
                        onClick={() => openNoteDetailsFile(noteDetailsFor.id)}
                        className="flex items-center gap-1 text-xs text-blue-600 hover:text-blue-700"
                      >
                        <ExternalLink className="h-3 w-3" /> View
                      </button>
                      <label className="flex items-center gap-1 text-xs text-gray-600 hover:text-gray-800 cursor-pointer">
                        <Upload className="h-3 w-3" /> Replace
                        <input type="file" accept="application/pdf" className="hidden"
                          onChange={e => { const f = e.target.files?.[0]; if (f) uploadNoteFileMut.mutate(f); e.target.value = '' }} />
                      </label>
                      <button
                        onClick={() => deleteNoteFileMut.mutate()}
                        className="flex items-center gap-1 text-xs text-red-500 hover:text-red-600"
                      >
                        <Trash2 className="h-3 w-3" /> Remove
                      </button>
                    </div>
                  </div>
                ) : (
                  <label className="flex items-center justify-center gap-2 border-2 border-dashed border-gray-300 rounded-lg py-4 text-sm text-gray-500 hover:border-blue-400 hover:text-blue-600 cursor-pointer transition-colors">
                    {noteDetailsUploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
                    {noteDetailsUploading ? 'Uploading…' : 'Upload PDF info sheet'}
                    <input type="file" accept="application/pdf" className="hidden"
                      onChange={e => { const f = e.target.files?.[0]; if (f) uploadNoteFileMut.mutate(f); e.target.value = '' }} />
                  </label>
                )}
              </div>

              {/* Terms */}
              <div>
                <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Terms</p>
                <div className="grid grid-cols-2 gap-3">
                  <label className="text-xs text-gray-500 col-span-2">Reference Asset
                    <input className="mt-1 w-full border rounded px-2 py-1.5 text-sm" value={noteDetailsForm.reference_asset ?? ''}
                      onChange={e => setNoteDetailsForm(f => ({ ...f, reference_asset: e.target.value }))} />
                  </label>
                  <label className="text-xs text-gray-500">Payment Amount
                    <input className="mt-1 w-full border rounded px-2 py-1.5 text-sm" placeholder="$10.74 per Note" value={noteDetailsForm.payment_amount ?? ''}
                      onChange={e => setNoteDetailsForm(f => ({ ...f, payment_amount: e.target.value }))} />
                  </label>
                  <label className="text-xs text-gray-500">Payment Frequency
                    <input className="mt-1 w-full border rounded px-2 py-1.5 text-sm" placeholder="Monthly" value={noteDetailsForm.payment_frequency ?? ''}
                      onChange={e => setNoteDetailsForm(f => ({ ...f, payment_frequency: e.target.value }))} />
                  </label>
                  <label className="text-xs text-gray-500">Payment Barrier (%)
                    <input type="number" step="0.01" className="mt-1 w-full border rounded px-2 py-1.5 text-sm" value={noteDetailsForm.payment_barrier_pct ?? ''}
                      onChange={e => setNoteDetailsForm(f => ({ ...f, payment_barrier_pct: e.target.value || null }))} />
                  </label>
                  <label className="text-xs text-gray-500">Autocall Level (%)
                    <input type="number" step="0.01" className="mt-1 w-full border rounded px-2 py-1.5 text-sm" value={noteDetailsForm.autocall_level_pct ?? ''}
                      onChange={e => setNoteDetailsForm(f => ({ ...f, autocall_level_pct: e.target.value || null }))} />
                  </label>
                  <label className="text-xs text-gray-500">Barrier Level (%)
                    <input type="number" step="0.01" className="mt-1 w-full border rounded px-2 py-1.5 text-sm" value={noteDetailsForm.barrier_level_pct ?? ''}
                      onChange={e => setNoteDetailsForm(f => ({ ...f, barrier_level_pct: e.target.value || null }))} />
                  </label>
                </div>
              </div>

              {/* Identifiers */}
              <div>
                <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Identifiers</p>
                <div className="grid grid-cols-2 gap-3">
                  <label className="text-xs text-gray-500">Status
                    <select className="mt-1 w-full border rounded px-2 py-1.5 text-sm" value={noteDetailsForm.status ?? ''}
                      onChange={e => setNoteDetailsForm(f => ({ ...f, status: e.target.value || null }))}>
                      <option value="">—</option>
                      <option>Active</option>
                      <option>Called</option>
                      <option>Matured</option>
                    </select>
                  </label>
                  <label className="text-xs text-gray-500">Product Category
                    <input className="mt-1 w-full border rounded px-2 py-1.5 text-sm" placeholder="Callable Contingent Coupon/ROC" value={noteDetailsForm.product_category ?? ''}
                      onChange={e => setNoteDetailsForm(f => ({ ...f, product_category: e.target.value }))} />
                  </label>
                  <label className="text-xs text-gray-500">CUSIP Code
                    <input className="mt-1 w-full border rounded px-2 py-1.5 text-sm" value={noteDetailsForm.cusip_code ?? ''}
                      onChange={e => setNoteDetailsForm(f => ({ ...f, cusip_code: e.target.value }))} />
                  </label>
                  <label className="text-xs text-gray-500">ADP Code
                    <input className="mt-1 w-full border rounded px-2 py-1.5 text-sm" value={noteDetailsForm.adp_code ?? ''}
                      onChange={e => setNoteDetailsForm(f => ({ ...f, adp_code: e.target.value }))} />
                  </label>
                </div>
              </div>

              {/* Dates */}
              <div>
                <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Dates</p>
                <div className="grid grid-cols-3 gap-3">
                  <label className="text-xs text-gray-500">Issue Date
                    <input type="date" className="mt-1 w-full border rounded px-2 py-1.5 text-sm" value={noteDetailsForm.issue_date ?? ''}
                      onChange={e => setNoteDetailsForm(f => ({ ...f, issue_date: e.target.value || null }))} />
                  </label>
                  <label className="text-xs text-gray-500">Maturity Date
                    <input type="date" className="mt-1 w-full border rounded px-2 py-1.5 text-sm" value={noteDetailsForm.maturity_date ?? ''}
                      onChange={e => setNoteDetailsForm(f => ({ ...f, maturity_date: e.target.value || null }))} />
                  </label>
                  <label className="text-xs text-gray-500">Term (years)
                    <input type="number" step="0.1" className="mt-1 w-full border rounded px-2 py-1.5 text-sm" value={noteDetailsForm.term_years ?? ''}
                      onChange={e => setNoteDetailsForm(f => ({ ...f, term_years: e.target.value || null }))} />
                  </label>
                </div>
              </div>

              {noteDetailsError && <p className="text-xs text-red-600">{noteDetailsError}</p>}
            </div>

            <div className="flex items-center justify-end gap-2 px-4 py-3 border-t">
              <button onClick={() => setNoteDetailsFor(null)} className="text-sm text-gray-500 px-3 py-1.5 rounded hover:bg-gray-100">Cancel</button>
              <button
                onClick={() => saveNoteDetailsMut.mutate()}
                disabled={saveNoteDetailsMut.isPending}
                className="text-sm bg-blue-600 text-white px-4 py-1.5 rounded hover:bg-blue-700 disabled:opacity-50"
              >
                {saveNoteDetailsMut.isPending ? 'Saving…' : 'Save'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
