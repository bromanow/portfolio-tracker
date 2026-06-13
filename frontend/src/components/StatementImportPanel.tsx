import { useState, useRef, useEffect, useMemo } from 'react'
import { FileText, Loader2, CheckCircle, AlertTriangle, Sparkles, Eye, Trash2 } from 'lucide-react'
import { importStatement, listStatements, openStatementFile, deleteStatement, getAccounts, type StoredStatement, type Account } from '../api/client'

// Parse any investment statement PDF into holdings (Gemini-powered; institution-agnostic).
export default function StatementImportPanel() {
  const [owner, setOwner] = useState('')
  const [accountId, setAccountId] = useState<number | null>(null)   // null = auto-detect/create
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<{ institution: string; account: string; as_of: string; holdings: number; total: string; currency: string; contribution: string | null; engine: string } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [stored, setStored] = useState<StoredStatement[]>([])
  const [accounts, setAccounts] = useState<Account[]>([])
  const inputRef = useRef<HTMLInputElement>(null)

  const refresh = () => listStatements().then(setStored).catch(() => {})
  useEffect(() => {
    refresh()
    getAccounts().then(a => {
      setAccounts(a)
      // Default Owner to a real owner value so auto-match/create uses the right one.
      const owners = [...new Set(a.map(x => x.owner).filter(Boolean))]
      setOwner(prev => prev || owners.find(o => /michelle/i.test(o)) || owners[0] || 'Michelle Romanow')
    }).catch(() => setOwner(o => o || 'Michelle Romanow'))
  }, [])

  const owners = useMemo(() => [...new Set(accounts.map(a => a.owner).filter(Boolean))], [accounts])

  const onFile = async (file?: File) => {
    if (!file) return
    setBusy(true); setError(null); setResult(null)
    try { setResult(await importStatement(file, owner, accountId)); refresh() }
    catch (e: any) { setError(e?.response?.data?.detail ?? 'Import failed') }
    finally { setBusy(false); if (inputRef.current) inputRef.current.value = '' }
  }

  const onDelete = async (s: StoredStatement) => {
    if (!confirm(`Remove the stored PDF "${s.original_filename}"? (Imported holdings stay.)`)) return
    try { await deleteStatement(s.id); refresh() } catch { /* ignore */ }
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

        <button
          onClick={() => inputRef.current?.click()}
          disabled={busy}
          className="flex items-center gap-1.5 px-3 py-1.5 bg-blue-600 text-white text-sm rounded hover:bg-blue-700 disabled:opacity-50"
        >
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileText className="h-4 w-4" />}
          {busy ? 'Reading statement…' : 'Choose statement PDF'}
        </button>
        <input ref={inputRef} type="file" accept="application/pdf,.pdf" className="hidden"
          onChange={e => onFile(e.target.files?.[0])} />
      </div>
      {accountId != null && (
        <p className="text-xs text-gray-400 -mt-2">
          All statements you upload here will be merged into this one account — use this for a plan
          whose statement format changed but is really the same account (e.g. Manulife's internal move).
        </p>
      )}

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
          <div className="divide-y divide-gray-100">
            {stored.map(s => (
              <div key={s.id} className="flex items-center gap-3 py-2 text-sm">
                <FileText className="h-4 w-4 text-gray-400 flex-shrink-0" />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-gray-800">
                    {s.account || s.institution || s.original_filename}
                    {s.as_of && <span className="text-gray-400"> · {s.as_of}</span>}
                  </div>
                  <div className="text-xs text-gray-400 truncate">
                    {s.original_filename} · {fmtSize(s.byte_size)}
                    {s.engine && <> · {s.engine}</>}
                  </div>
                </div>
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
        </div>
      )}
    </div>
  )
}
