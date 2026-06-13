import { useState, useEffect, useMemo, useCallback } from 'react'
import { useDropzone } from 'react-dropzone'
import { FileText, Loader2, CheckCircle, AlertTriangle, Sparkles, Eye, Trash2, Upload, ChevronRight, ChevronDown, RefreshCw } from 'lucide-react'
import { importStatement, listStatements, openStatementFile, deleteStatement, reprocessStatement, reprocessStatements, statementHandoff, switchSecurity, getAccounts, getSecurities, type StoredStatement, type Account, type Security } from '../api/client'

// Parse any investment statement PDF into holdings (Gemini-powered; institution-agnostic).
export default function StatementImportPanel() {
  const [owner, setOwner] = useState('')
  const [accountId, setAccountId] = useState<number | null>(null)   // null = auto-detect/create
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<{ institution: string; account: string; as_of: string; holdings: number; total: string; currency: string; contribution: string | null; engine: string } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [stored, setStored] = useState<StoredStatement[]>([])
  const [accounts, setAccounts] = useState<Account[]>([])
  const [securities, setSecurities] = useState<Security[]>([])

  const refresh = () => listStatements().then(setStored).catch(() => {})
  useEffect(() => {
    refresh()
    getAccounts().then(a => {
      setAccounts(a)
      // Default Owner to a real owner value so auto-match/create uses the right one.
      const owners = [...new Set(a.map(x => x.owner).filter(Boolean))]
      setOwner(prev => prev || owners.find(o => /michelle/i.test(o)) || owners[0] || 'Michelle Romanow')
    }).catch(() => setOwner(o => o || 'Michelle Romanow'))
    getSecurities().then(setSecurities).catch(() => {})
  }, [])

  // Statement-sourced funds (synthetic tickers contain ':') — the from/to options for a switch.
  const switchSecurities = useMemo(
    () => securities.filter(s => s.ticker.includes(':')).sort((a, b) => (a.name || a.ticker).localeCompare(b.name || b.ticker)),
    [securities])

  const owners = useMemo(() => [...new Set(accounts.map(a => a.owner).filter(Boolean))], [accounts])

  // Stored statements grouped by account (newest first within each group).
  const groupedStored = useMemo(() => {
    const m = new Map<string, StoredStatement[]>()
    for (const s of stored) {
      const k = s.account || s.institution || 'Unassigned'
      if (!m.has(k)) m.set(k, [])
      m.get(k)!.push(s)
    }
    for (const arr of m.values()) arr.sort((a, b) => (b.as_of || '').localeCompare(a.as_of || ''))
    return [...m.entries()].sort((a, b) => a[0].localeCompare(b[0]))
  }, [stored])
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const toggleGroup = (k: string) => setCollapsed(prev => {
    const n = new Set(prev); n.has(k) ? n.delete(k) : n.add(k); return n
  })

  const onFile = async (file?: File) => {
    if (!file) return
    setBusy(true); setError(null); setResult(null)
    try { setResult(await importStatement(file, owner, accountId)); refresh() }
    catch (e: any) { setError(e?.response?.data?.detail ?? 'Import failed') }
    finally { setBusy(false) }
  }

  const onDrop = useCallback((files: File[]) => { if (files.length) onFile(files[0]) },
    [owner, accountId])  // eslint-disable-line react-hooks/exhaustive-deps
  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept: { 'application/pdf': ['.pdf'] },
    multiple: false,
    disabled: busy,
  })

  const onDelete = async (s: StoredStatement) => {
    if (!confirm(`Remove the stored PDF "${s.original_filename}"? (Imported holdings stay.)`)) return
    try { await deleteStatement(s.id); refresh() } catch { /* ignore */ }
  }

  // Reprocess (re-import) from the already-stored PDFs — no re-upload needed.
  const [reproc, setReproc] = useState<string | null>(null)
  const onReprocess = async (s: StoredStatement) => {
    setReproc(`s${s.id}`); setError(null)
    try { await reprocessStatement(s.id); refresh() }
    catch (e: any) { setError(e?.response?.data?.detail ?? 'Reprocess failed') }
    finally { setReproc(null) }
  }
  const onReprocessGroup = async (account: string, accountId: number | null) => {
    if (!accountId) return
    if (!confirm(`Reprocess all "${account}" statements (oldest → newest)? Re-parses each PDF via Gemini, so it uses quota.`)) return
    setReproc(`g${accountId}`); setError(null)
    try {
      const r = await reprocessStatements(accountId); refresh()
      const failed = r.results.filter(x => x.error)
      if (failed.length) setError(`${r.reprocessed}/${r.total} done. Failed: ${failed.map(x => `${x.as_of || x.id} — ${x.error}`).join(' | ')}`)
    } catch (e: any) { setError(e?.response?.data?.detail ?? 'Reprocess failed') }
    finally { setReproc(null) }
  }

  // ── Hand off to a live feed (e.g. Plaid) ──
  const [handoffAcct, setHandoffAcct] = useState<number | null>(null)
  const [handoffDate, setHandoffDate] = useState(() => new Date().toISOString().slice(0, 10))
  const [handoffMsg, setHandoffMsg] = useState<string | null>(null)
  const [handoffBusy, setHandoffBusy] = useState(false)
  const onHandoff = async () => {
    if (!handoffAcct) return
    if (!confirm(`Freeze statement history for this account as of ${handoffDate}? A live feed (Plaid) should own it after that date.`)) return
    setHandoffBusy(true); setHandoffMsg(null)
    try {
      const r = await statementHandoff(handoffAcct, handoffDate)
      setHandoffMsg(`Froze ${r.securities_unwound} holding(s) in ${r.account} as of ${r.cutover_date}.`)
    } catch (e: any) {
      setHandoffMsg(e?.response?.data?.detail ?? 'Handoff failed')
    } finally { setHandoffBusy(false) }
  }

  // ── Record a fund switch (e.g. 2035→2040) as a cash- & gain-neutral JOURNAL ──
  const [swAcct, setSwAcct] = useState<number | null>(null)
  const [swFrom, setSwFrom] = useState<number | null>(null)
  const [swTo, setSwTo] = useState<number | null>(null)
  const [swDate, setSwDate] = useState(() => new Date().toISOString().slice(0, 10))
  const [swMsg, setSwMsg] = useState<string | null>(null)
  const [swBusy, setSwBusy] = useState(false)
  const onSwitch = async () => {
    if (!swAcct || !swFrom || !swTo) return
    if (swFrom === swTo) { setSwMsg('Pick two different funds.'); return }
    setSwBusy(true); setSwMsg(null)
    try {
      const r = await switchSecurity(swAcct, swFrom, swTo, swDate)
      setSwMsg(`Switched ${r.from} → ${r.to} (CAD $${Number(r.value_moved_cad).toLocaleString('en-CA', { minimumFractionDigits: 2 })}) as of ${r.switch_date}.`)
    } catch (e: any) { setSwMsg(e?.response?.data?.detail ?? 'Switch failed') }
    finally { setSwBusy(false) }
  }

  const fmtSize = (b: number) => b >= 1e6 ? `${(b / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1e3))} KB`

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4 space-y-4 max-w-2xl">
      <div className="flex items-center gap-2">
        <Sparkles className="h-4 w-4 text-blue-600" />
        <h2 className="font-semibold text-gray-800">Statement import (AI-parsed)</h2>
      </div>
      <p className="text-sm text-gray-500">
        Upload any investment statement PDF (Manulife, Principal, a brokerage…). Gemini reads the
        holdings <em>and</em> the period's contributions/transfers. Each statement is recorded as of
        its own period-end, so successive statements build a real value history — and the
        contributions feed the return calc so growth is separated from new money. No manual entry,
        no per-format setup. Upload each statement as it arrives (oldest first); re-uploading the
        same one is safe.
      </p>

      <div className="flex items-end gap-3 flex-wrap">
        <div className="flex flex-col gap-1">
          <label className="text-xs text-gray-500">Import into account</label>
          <select value={accountId ?? ''} onChange={e => setAccountId(e.target.value ? Number(e.target.value) : null)}
            className="border border-gray-200 rounded px-2 py-1 text-sm min-w-[16rem]">
            <option value="">Auto-detect / create from statement</option>
            {accounts.map(a => (
              <option key={a.id} value={a.id}>{a.name} · {a.owner}</option>
            ))}
          </select>
        </div>

        <div className="flex flex-col gap-1">
          <label className="text-xs text-gray-500">Owner {accountId != null && <span className="text-gray-300">(ignored)</span>}</label>
          <select value={owner} onChange={e => setOwner(e.target.value)} disabled={accountId != null}
            className="border border-gray-200 rounded px-2 py-1 text-sm disabled:bg-gray-50 disabled:text-gray-400">
            {(owners.length ? owners : ['Michelle Romanow', 'Brian Romanow']).map(o => (
              <option key={o} value={o}>{o}</option>
            ))}
          </select>
        </div>

      </div>
      {accountId != null && (
        <p className="text-xs text-gray-400 -mt-2">
          All statements you upload here will be merged into this one account — use this for a plan
          whose statement format changed but is really the same account (e.g. Manulife's internal move).
        </p>
      )}

      <div
        {...getRootProps()}
        className={`border-2 border-dashed rounded-xl p-8 text-center cursor-pointer transition-colors ${
          busy ? 'opacity-60 cursor-not-allowed border-gray-200'
          : isDragActive ? 'border-blue-400 bg-blue-50'
          : 'border-gray-300 hover:border-blue-400 hover:bg-blue-50'
        }`}
      >
        <input {...getInputProps()} />
        {busy
          ? <Loader2 className="h-9 w-9 text-blue-400 mx-auto mb-2 animate-spin" />
          : <Upload className="h-9 w-9 text-gray-400 mx-auto mb-2" />}
        <p className="text-gray-600 font-medium">
          {busy ? 'Reading statement…'
            : isDragActive ? 'Drop the statement PDF here'
            : 'Drag & drop a statement PDF here, or click to select'}
        </p>
        <p className="text-xs text-gray-400 mt-1">PDF only · one at a time</p>
      </div>

      {error && (
        <div className="text-sm text-red-600 bg-red-50 border border-red-200 rounded p-2 flex items-start gap-2">
          <AlertTriangle className="h-4 w-4 flex-shrink-0 mt-0.5" /> {error}
        </div>
      )}
      {result && (
        <div className="text-sm text-emerald-700 bg-emerald-50 border border-emerald-200 rounded p-3 flex items-start gap-2">
          <CheckCircle className="h-4 w-4 flex-shrink-0 mt-0.5" />
          <div>
            Imported <strong>{result.holdings}</strong> holdings into <strong>{result.account}</strong>{' '}
            ({result.institution}) as of <strong>{result.as_of}</strong> — total{' '}
            <strong>{result.currency} ${Number(result.total).toLocaleString('en-CA', { minimumFractionDigits: 2 })}</strong>
            {result.contribution && Number(result.contribution) !== 0 && (
              <>, period contribution{' '}
                <strong>${Number(result.contribution).toLocaleString('en-CA', { minimumFractionDigits: 2 })}</strong></>
            )}. Check it on the Holdings &amp; Performance pages.
          </div>
        </div>
      )}

      {stored.length > 0 && (
        <div className="pt-2 border-t border-gray-100">
          <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">Stored statements</h3>
          <div className="space-y-1">
            {groupedStored.map(([account, files]) => {
              const open = !collapsed.has(account)
              return (
                <div key={account} className="border border-gray-100 rounded">
                  <div className="flex items-center">
                    <button onClick={() => toggleGroup(account)}
                      className="flex-1 flex items-center gap-2 px-2 py-1.5 text-sm text-left hover:bg-gray-50 rounded">
                      {open ? <ChevronDown className="h-4 w-4 text-gray-400 flex-shrink-0" />
                            : <ChevronRight className="h-4 w-4 text-gray-400 flex-shrink-0" />}
                      <span className="font-medium text-gray-700 truncate">{account}</span>
                      <span className="text-xs text-gray-400">{files.length}</span>
                    </button>
                    {files[0].account_id != null && (
                      <button onClick={() => onReprocessGroup(account, files[0].account_id)}
                        disabled={reproc != null}
                        title="Re-import all statements in this account from the stored PDFs"
                        className="flex items-center gap-1 px-2 py-1 mr-1 text-xs text-gray-500 hover:text-blue-600 hover:bg-blue-50 rounded disabled:opacity-40">
                        {reproc === `g${files[0].account_id}`
                          ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                          : <RefreshCw className="h-3.5 w-3.5" />}
                        Reprocess all
                      </button>
                    )}
                  </div>
                  {open && (
                    <div className="divide-y divide-gray-50 border-t border-gray-100">
                      {files.map(s => (
                        <div key={s.id} className="flex items-center gap-3 py-2 pl-7 pr-2 text-sm">
                          <FileText className="h-4 w-4 text-gray-400 flex-shrink-0" />
                          <div className="min-w-0 flex-1">
                            <div className="truncate text-gray-800">
                              {s.as_of || s.original_filename}
                              {s.owner && <span className="text-gray-400"> · {s.owner}</span>}
                            </div>
                            <div className="text-xs text-gray-400 truncate">
                              {s.original_filename} · {fmtSize(s.byte_size)}
                              {s.engine && <> · {s.engine}</>}
                            </div>
                          </div>
                          <button onClick={() => onReprocess(s)} disabled={reproc != null}
                            title="Re-import this statement from the stored PDF"
                            className="flex items-center gap-1 px-2 py-1 text-xs text-gray-500 hover:text-blue-600 hover:bg-blue-50 rounded disabled:opacity-40">
                            {reproc === `s${s.id}`
                              ? <Loader2 className="h-3.5 w-3.5 animate-spin" />
                              : <RefreshCw className="h-3.5 w-3.5" />}
                          </button>
                          <button onClick={() => openStatementFile(s.id)}
                            className="flex items-center gap-1 px-2 py-1 text-xs text-blue-600 hover:bg-blue-50 rounded">
                            <Eye className="h-3.5 w-3.5" /> View
                          </button>
                          <button onClick={() => onDelete(s)}
                            className="flex items-center gap-1 px-2 py-1 text-xs text-gray-400 hover:text-red-600 hover:bg-red-50 rounded">
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      )}

      <details className="pt-2 border-t border-gray-100">
        <summary className="text-xs font-semibold text-gray-500 uppercase tracking-wide cursor-pointer">
          Hand off to a live feed (Plaid)
        </summary>
        <p className="text-xs text-gray-400 mt-2">
          Once a live feed (Plaid) is taking over an account, freeze its statement history as of a
          cutover date so the two don't double-count. Statements drive value/returns before the
          date; the live feed drives them after. Safe to re-run with a new date.
        </p>
        <div className="flex items-end gap-3 flex-wrap mt-2">
          <div className="flex flex-col gap-1">
            <label className="text-xs text-gray-500">Account</label>
            <select value={handoffAcct ?? ''} onChange={e => setHandoffAcct(e.target.value ? Number(e.target.value) : null)}
              className="border border-gray-200 rounded px-2 py-1 text-sm min-w-[16rem]">
              <option value="">Select account…</option>
              {accounts.map(a => <option key={a.id} value={a.id}>{a.name} · {a.owner}</option>)}
            </select>
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-xs text-gray-500">Cutover date</label>
            <input type="date" value={handoffDate} onChange={e => setHandoffDate(e.target.value)}
              className="border border-gray-200 rounded px-2 py-1 text-sm" />
          </div>
          <button onClick={onHandoff} disabled={!handoffAcct || handoffBusy}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-gray-700 text-white text-sm rounded hover:bg-gray-800 disabled:opacity-50">
            {handoffBusy && <Loader2 className="h-4 w-4 animate-spin" />}
            Freeze &amp; hand off
          </button>
        </div>
        {handoffMsg && <p className="text-xs text-gray-600 mt-2">{handoffMsg}</p>}
      </details>

      <details className="pt-2 border-t border-gray-100">
        <summary className="text-xs font-semibold text-gray-500 uppercase tracking-wide cursor-pointer">
          Record a fund switch
        </summary>
        <p className="text-xs text-gray-400 mt-2">
          For a fund roll (e.g. a 2035 → 2040 target-date fund) that isn't a buy or sell. Moves the
          whole position and cost basis from one fund to another at book value — no cash and no
          gain/loss (the new fund keeps the old fund's price). Use this when a statement shows one
          fund gone and another appeared with no contribution.
        </p>
        <div className="flex items-end gap-3 flex-wrap mt-2">
          <div className="flex flex-col gap-1">
            <label className="text-xs text-gray-500">Account</label>
            <select value={swAcct ?? ''} onChange={e => setSwAcct(e.target.value ? Number(e.target.value) : null)}
              className="border border-gray-200 rounded px-2 py-1 text-sm min-w-[14rem]">
              <option value="">Select account…</option>
              {accounts.map(a => <option key={a.id} value={a.id}>{a.name} · {a.owner}</option>)}
            </select>
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-xs text-gray-500">From fund</label>
            <select value={swFrom ?? ''} onChange={e => setSwFrom(e.target.value ? Number(e.target.value) : null)}
              className="border border-gray-200 rounded px-2 py-1 text-sm min-w-[12rem]">
              <option value="">Select…</option>
              {switchSecurities.map(s => <option key={s.id} value={s.id}>{s.name || s.ticker}</option>)}
            </select>
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-xs text-gray-500">To fund</label>
            <select value={swTo ?? ''} onChange={e => setSwTo(e.target.value ? Number(e.target.value) : null)}
              className="border border-gray-200 rounded px-2 py-1 text-sm min-w-[12rem]">
              <option value="">Select…</option>
              {switchSecurities.map(s => <option key={s.id} value={s.id}>{s.name || s.ticker}</option>)}
            </select>
          </div>
          <div className="flex flex-col gap-1">
            <label className="text-xs text-gray-500">Switch date</label>
            <input type="date" value={swDate} onChange={e => setSwDate(e.target.value)}
              className="border border-gray-200 rounded px-2 py-1 text-sm" />
          </div>
          <button onClick={onSwitch} disabled={!swAcct || !swFrom || !swTo || swBusy}
            className="flex items-center gap-1.5 px-3 py-1.5 bg-gray-700 text-white text-sm rounded hover:bg-gray-800 disabled:opacity-50">
            {swBusy && <Loader2 className="h-4 w-4 animate-spin" />}
            Record switch
          </button>
        </div>
        {swMsg && <p className="text-xs text-gray-600 mt-2">{swMsg}</p>}
      </details>
    </div>
  )
}
