import { useState, useRef } from 'react'
import { FileText, Loader2, CheckCircle, AlertTriangle } from 'lucide-react'
import { importManulifeStatement } from '../api/client'

// Parse an institution statement PDF into holdings (Manulife for now).
export default function StatementImportPanel() {
  const [owner, setOwner] = useState('Michelle')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<{ account: string; as_of: string; funds: number; total: string } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)

  const onFile = async (file?: File) => {
    if (!file) return
    setBusy(true); setError(null); setResult(null)
    try { setResult(await importManulifeStatement(file, owner)) }
    catch (e: any) { setError(e?.response?.data?.detail ?? 'Import failed') }
    finally { setBusy(false); if (inputRef.current) inputRef.current.value = '' }
  }

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-4 space-y-4 max-w-2xl">
      <div className="flex items-center gap-2">
        <FileText className="h-4 w-4 text-blue-600" />
        <h2 className="font-semibold text-gray-800">Statement import — Manulife</h2>
      </div>
      <p className="text-sm text-gray-500">
        Upload a Manulife group-retirement statement PDF. We parse the fund holdings (units,
        unit price, value) and rebuild the account — no manual entry. Each upload replaces the
        account's holdings with the statement's, so just drop in the newest statement.
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
          Choose statement PDF
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
            Imported <strong>{result.funds}</strong> funds into <strong>{result.account}</strong> as of{' '}
            <strong>{result.as_of}</strong> — total{' '}
            <strong>${Number(result.total).toLocaleString('en-CA', { minimumFractionDigits: 2 })}</strong>.
            Check it on the Holdings page.
          </div>
        </div>
      )}
    </div>
  )
}
