import { useState, useRef } from 'react'
import { FileText, Loader2, CheckCircle, AlertTriangle, Sparkles } from 'lucide-react'
import { importStatement } from '../api/client'

// Parse any investment statement PDF into holdings (Gemini-powered; institution-agnostic).
export default function StatementImportPanel() {
  const [owner, setOwner] = useState('Michelle')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<{ institution: string; account: string; as_of: string; holdings: number; total: string; currency: string; contribution: string | null; engine: string } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const onFile = async (file?: File) => {
    if (!file) return
    setBusy(true); setError(null); setResult(null)
    try { setResult(await importStatement(file, owner)) }
    catch (e: any) { setError(e?.response?.data?.detail ?? 'Import failed') }
    finally { setBusy(false); if (inputRef.current) inputRef.current.value = '' }
  }

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

      <div className="flex items-center gap-3 flex-wrap">
        <label className="text-xs text-gray-500">Owner</label>
        <select value={owner} onChange={e => setOwner(e.target.value)}
          className="border border-gray-200 rounded px-2 py-1 text-sm">
          <option>Michelle</option>
          <option>Brian</option>
        </select>
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
    </div>
  )
}
