import { useState, useEffect, useCallback, useRef } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { X, Check } from 'lucide-react'
import { getFxRateLookup, createTypeOverride } from '../api/client'
import type { Transaction, Security, Account } from '../api/client'
import DatePicker from './DatePicker'

// Shared between the Activity → Transactions page and the security detail card's
// Transactions tab, so editing a transaction looks and behaves identically everywhere.

export const ALL_TYPES = [
  'BUY', 'SELL', 'DIVIDEND', 'DRIP', 'RETURN_OF_CAPITAL',
  'OPTION_BUY', 'OPTION_SELL', 'OPTION_EXPIRY', 'OPTION_ASSIGNMENT', 'OPTION_EXERCISE',
  'TRANSFER_IN', 'TRANSFER_OUT', 'JOURNAL', 'FX_CONVERSION', 'FX_ADJUSTMENT',
  'SPLIT', 'FORWARD_SPLIT', 'REVERSE_SPLIT', 'INTEREST', 'FEE', 'DEPOSIT', 'WITHDRAWAL',
  'OPENING_BALANCE', 'CASH_OPENING', 'ADJUSTMENT', 'OTHER',
]

// Numeric fields that may contain user-typed commas (e.g. "2,536")
const NUMERIC_FIELDS = ['quantity', 'price', 'commission', 'transaction_amount', 'account_currency_amount', 'cad_amount', 'fx_rate_to_account', 'fx_rate_to_cad'] as const

export function cleanNumericFields<T extends Record<string, unknown>>(data: T): T {
  const result: Record<string, unknown> = { ...data }
  for (const f of NUMERIC_FIELDS) {
    if (typeof result[f] === 'string') {
      result[f] = (result[f] as string).replace(/,/g, '')
    }
  }
  return result as T
}

/** Clean + strip fields the backend recomputes itself, ready to send to updateTransaction. */
export function prepareTransactionUpdate(fields: Partial<Transaction>): Partial<Transaction> {
  const f = cleanNumericFields(fields) as Record<string, unknown>
  // Strip cad_amount so the backend infers it from transaction_amount. The backend always
  // recalculates cad_amount for CAD transactions when cad_amount is absent from the payload.
  delete f.cad_amount
  delete f.account_currency_amount
  return f as Partial<Transaction>
}

export function fmtApiError(err: unknown): string {
  const e = err as { response?: { data?: { detail?: unknown } }; message?: string }
  const detail = e?.response?.data?.detail
  if (Array.isArray(detail)) {
    // Pydantic 422 returns array of {loc, msg, type}
    return detail.map((d: { msg?: string; loc?: string[] }) =>
      `${d.loc?.slice(1).join('.') ?? ''}: ${d.msg ?? ''}`.trim()
    ).join('; ')
  }
  if (typeof detail === 'string') return detail
  return e?.message || 'Request failed'
}

export interface EditState {
  tx: Transaction
  fields: Partial<Transaction>
}

export interface TxFormFieldsProps {
  fields: Partial<Transaction>
  onChange: (fields: Partial<Transaction>) => void
  accounts: Account[]
  securities: Security[]
  tickerInput: string
  onTickerChange: (val: string) => void
  tickerDatalistId: string
  mode: 'create' | 'edit'
}

export function TxFormFields({ fields, onChange, accounts, securities, tickerInput, onTickerChange, tickerDatalistId, mode }: TxFormFieldsProps) {
  const [systemFxRate, setSystemFxRate] = useState<string | null>(null)
  const [fxLoading, setFxLoading] = useState(false)
  const [cadManual, setCadManual] = useState(false)
  // Track last fetched params so we don't double-apply on re-render
  const lastFetchRef = useRef<string>('')

  const currency = (fields.transaction_currency as string) || 'CAD'
  const isNonCAD = currency !== 'CAD'
  const isJournal = (fields.transaction_type as string) === 'JOURNAL'
  // For JOURNALs we always show the CAD book-value section (even when currency = CAD)
  const showFxSection = isNonCAD || isJournal

  const computeCad = useCallback((txAmt: string | null | undefined, fx: string | null | undefined): string | null => {
    const a = parseFloat(txAmt as string)
    const f = parseFloat(fx as string)
    if (isNaN(a) || isNaN(f)) return null
    return (a * f).toFixed(4)
  }, [])

  // Fetch system FX rate when date or currency changes
  useEffect(() => {
    const txDate = fields.transaction_date as string | undefined
    if (!txDate || !isNonCAD) {
      setSystemFxRate(null)
      return
    }
    const key = `${txDate}|${currency}`
    if (lastFetchRef.current === key) return
    lastFetchRef.current = key
    setFxLoading(true)
    getFxRateLookup(txDate, currency)
      .then(res => {
        const rate = res.rate
        setSystemFxRate(rate)
        if (mode === 'create') {
          const cadAmt = computeCad(fields.transaction_amount as string | undefined, rate)
          onChange({
            ...fields,
            fx_rate_to_cad: rate,
            fx_rate_to_account: rate,
            ...(cadAmt !== null ? { cad_amount: cadAmt } : {}),
          })
        }
      })
      .catch(() => setSystemFxRate(null))
      .finally(() => setFxLoading(false))
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fields.transaction_date, currency])

  const handleTxAmountChange = (val: string) => {
    const updates: Partial<Transaction> = { ...fields, transaction_amount: val || undefined }
    if (isNonCAD) {
      const txAmt = parseFloat(val.replace(/,/g, ''))
      if (cadManual) {
        // CAD amount is the driver — back-compute FX rate from cad ÷ tx_amount
        const cadAmt = parseFloat((fields.cad_amount as string | undefined)?.replace(/,/g, '') ?? '')
        if (!isNaN(txAmt) && txAmt !== 0 && !isNaN(cadAmt)) {
          const back = (cadAmt / txAmt).toFixed(6)
          updates.fx_rate_to_cad = back
          updates.fx_rate_to_account = back
        }
      } else {
        // FX rate is the driver — forward-compute cad_amount
        const cad = computeCad(val, fields.fx_rate_to_cad as string | undefined)
        if (cad !== null) updates.cad_amount = cad
      }
    }
    onChange(updates)
  }

  const handleFxRateChange = (val: string) => {
    // FX rate edited manually — switch to forward mode
    setCadManual(false)
    const updates: Partial<Transaction> = { ...fields, fx_rate_to_cad: val || undefined, fx_rate_to_account: val || undefined }
    if (isNonCAD) {
      const cad = computeCad(fields.transaction_amount as string | undefined, val)
      if (cad !== null) updates.cad_amount = cad
    }
    onChange(updates)
  }

  const handleCadAmountChange = (val: string) => {
    // CAD amount edited manually — switch to reverse mode and back-compute FX rate
    setCadManual(true)
    const updates: Partial<Transaction> = { ...fields, cad_amount: val || undefined }
    if (isNonCAD) {
      const cadAmt = parseFloat(val.replace(/,/g, ''))
      const txAmt = parseFloat((fields.transaction_amount as string | undefined)?.replace(/,/g, '') ?? '')
      if (!isNaN(cadAmt) && !isNaN(txAmt) && txAmt !== 0) {
        const back = (cadAmt / txAmt).toFixed(6)
        updates.fx_rate_to_cad = back
        updates.fx_rate_to_account = back
      }
    } else if (isJournal) {
      // JOURNAL with CAD currency: book value is entered directly in CAD;
      // keep transaction_amount in sync (same currency, same number)
      updates.transaction_amount = val || undefined
      updates.account_currency_amount = val || undefined
    }
    onChange(updates)
  }

  const handleCadReset = () => {
    // Reset to forward mode: recompute cad_amount from tx_amount × fx_rate
    setCadManual(false)
    const cad = computeCad(fields.transaction_amount as string | undefined, fields.fx_rate_to_cad as string | undefined)
    onChange({ ...fields, cad_amount: cad ?? undefined })
  }

  const fxRateStr = (fields.fx_rate_to_cad as string | undefined) || ''
  const systemRateHint = () => {
    if (!isNonCAD) return null
    const backComputedNote = cadManual
      ? <span className="text-xs text-amber-600 dark:text-amber-400 ml-1">← back-computed from CAD ÷ amount</span>
      : null
    if (fxLoading) return <span className="text-xs text-muted-foreground">Fetching system rate…{backComputedNote}</span>
    if (!systemFxRate) return <span className="text-xs text-muted-foreground">No system rate for this date{backComputedNote}</span>
    const rounded = parseFloat(fxRateStr).toFixed(4)
    const roundedSys = parseFloat(systemFxRate).toFixed(4)
    if (rounded === roundedSys) return <span className="text-xs text-muted-foreground">System rate ✓{backComputedNote}</span>
    return (
      <span className="text-xs text-muted-foreground">
        System: {systemFxRate}{' '}
        <button type="button" className="text-xs text-primary/70 underline" onClick={() => handleFxRateChange(systemFxRate)}>
          {mode === 'create' ? 'Apply' : 'Apply system rate'}
        </button>
        {backComputedNote}
      </span>
    )
  }

  return (
    <div className="grid grid-cols-2 gap-3 text-sm">
      {/* Account */}
      <div>
        <label className="block text-xs text-muted-foreground mb-1">
          Account {mode === 'create' && <span className="text-red-400">*</span>}
        </label>
        <select className="bg-background text-foreground border border-border rounded px-3 py-1.5 text-sm w-full"
          value={fields.account_id || ''}
          onChange={e => onChange({ ...fields, account_id: e.target.value ? Number(e.target.value) : undefined })}>
          {mode === 'edit' && <option value="">— unchanged —</option>}
          {mode === 'create' && <option value="">Select account</option>}
          {accounts.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
        </select>
      </div>
      {/* Date */}
      <div>
        <label className="block text-xs text-muted-foreground mb-1">Date <span className="text-red-400">*</span></label>
        <DatePicker className="w-full" max={new Date().toISOString().slice(0, 10)}
          value={(fields.transaction_date as string) || ''}
          onChange={v => { lastFetchRef.current = ''; onChange({ ...fields, transaction_date: v }) }} />
      </div>
      {/* Type */}
      <div>
        <label className="block text-xs text-muted-foreground mb-1">Type <span className="text-red-400">*</span></label>
        <select className="bg-background text-foreground border border-border rounded px-3 py-1.5 text-sm w-full"
          value={(fields.transaction_type as string) || ''}
          onChange={e => onChange({ ...fields, transaction_type: e.target.value })}>
          {ALL_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
        </select>
      </div>
      {/* Ticker */}
      <div>
        <label className="block text-xs text-muted-foreground mb-1">Ticker (Security)</label>
        <input list={tickerDatalistId} className="bg-background text-foreground border border-border rounded px-3 py-1.5 text-sm w-full uppercase"
          value={tickerInput}
          onChange={e => onTickerChange(e.target.value.toUpperCase())}
          placeholder="e.g. ENB" />
        <datalist id={tickerDatalistId}>
          {(securities as Security[]).map(s => (
            <option key={s.id} value={s.ticker}>{s.name || s.ticker}</option>
          ))}
        </datalist>
        {tickerInput && !(securities as Security[]).find(s => s.ticker.toUpperCase() === tickerInput) && (
          <p className="text-xs text-amber-600 dark:text-amber-400 mt-0.5">
            {mode === 'create' ? '⚠ Ticker not found — new security will be created' : '⚠ Ticker not found in securities list'}
          </p>
        )}
      </div>
      {/* Quantity */}
      <div>
        <label className="block text-xs text-muted-foreground mb-1">Quantity</label>
        <input type="text" className="bg-background text-foreground border border-border rounded px-3 py-1.5 text-sm w-full"
          value={(fields.quantity as string) || ''}
          onChange={e => onChange({ ...fields, quantity: e.target.value || undefined })} />
      </div>
      {/* Transaction Currency */}
      <div>
        <label className="block text-xs text-muted-foreground mb-1">Transaction Currency</label>
        <select className="bg-background text-foreground border border-border rounded px-3 py-1.5 text-sm w-full"
          value={currency}
          onChange={e => {
            lastFetchRef.current = ''
            onChange({ ...fields, transaction_currency: e.target.value })
          }}>
          <option>CAD</option>
          <option>USD</option>
        </select>
      </div>
      {/* Price */}
      <div>
        <label className="block text-xs text-muted-foreground mb-1">Price ({currency})</label>
        <input type="text" className="bg-background text-foreground border border-border rounded px-3 py-1.5 text-sm w-full"
          value={(fields.price as string) || ''}
          onChange={e => onChange({ ...fields, price: e.target.value || undefined })} />
      </div>
      {/* Commission */}
      <div>
        <label className="block text-xs text-muted-foreground mb-1">Commission ({currency})</label>
        <input type="text" className="bg-background text-foreground border border-border rounded px-3 py-1.5 text-sm w-full"
          value={(fields.commission as string) || ''}
          onChange={e => onChange({ ...fields, commission: e.target.value || undefined })} />
      </div>
      {/* Net Amount / Book Value */}
      <div>
        <label className="block text-xs text-muted-foreground mb-1">
          {isJournal ? `Book Value (${currency})` : `Net Amount (${currency})`}
        </label>
        <input type="text" className="bg-background text-foreground border border-border rounded px-3 py-1.5 text-sm w-full"
          value={(fields.transaction_amount as string) || ''}
          onChange={e => handleTxAmountChange(e.target.value)} />
      </div>
      {/* Spacer to keep grid even */}
      <div />
      {/* ACB Book Value section — FX + CAD amount for non-CAD, or CAD-only for JOURNAL */}
      {showFxSection && (
        <>
          {/* Explanation banner for JOURNAL transactions */}
          {isJournal && (
            <div className="col-span-2 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 text-xs text-amber-800 space-y-0.5">
              <p className="font-semibold">ACB Book Value Transfer</p>
              <p>
                For the <strong>receiving leg (+qty)</strong>, enter the book value of the transferred shares.
                This sets the cost basis (ACB) in the destination account.
                Use the original purchase cost — <strong>not</strong> the current market price.
              </p>
              {fields.quantity && parseFloat(fields.quantity as string) < 0 && (
                <p className="text-amber-600 dark:text-amber-400 italic">
                  This appears to be the <strong>outgoing leg (−qty)</strong>. The ACB here has no effect —
                  edit the receiving leg (+qty) instead.
                </p>
              )}
            </div>
          )}
          <div className={`col-span-2 grid gap-3 ${isNonCAD ? 'grid-cols-2' : 'grid-cols-1'}`}>
            {/* FX Rate — only for non-CAD */}
            {isNonCAD && (
              <div>
                <label className="block text-xs text-muted-foreground mb-1">
                  {isJournal ? `FX Rate on transfer date (${currency} → CAD)` : `FX Rate (${currency} → CAD)`}
                </label>
                <input type="text" className="bg-background text-foreground border border-border rounded px-3 py-1.5 text-sm w-full"
                  value={fxRateStr}
                  onChange={e => handleFxRateChange(e.target.value)} />
                <div className="mt-0.5">{systemRateHint()}</div>
              </div>
            )}
            {/* CAD Amount — always shown for JOURNAL or non-CAD */}
            <div>
              <label className="block text-xs text-muted-foreground mb-1">
                {isJournal ? 'Book Value (CAD) ← used as ACB' : 'CAD Amount'}
              </label>
              <input type="text" className="bg-background text-foreground border border-border rounded px-3 py-1.5 text-sm w-full"
                value={(fields.cad_amount as string) || ''}
                onChange={e => handleCadAmountChange(e.target.value)} />
              <div className="mt-0.5">
                {isNonCAD
                  ? cadManual
                    ? <span className="text-xs text-muted-foreground">manual —{' '}
                        <button type="button" className="text-xs text-primary/70 underline" onClick={handleCadReset}>↺ auto</button>
                      </span>
                    : <span className="text-xs text-muted-foreground">auto-computed from amount × FX rate</span>
                  : isJournal
                    ? <span className="text-xs text-muted-foreground">enter the CAD book value directly</span>
                    : null
                }
              </div>
            </div>
          </div>
        </>
      )}
      {/* Notes */}
      <div>
        <label className="block text-xs text-muted-foreground mb-1">Notes {mode === 'edit' && <span className="text-muted-foreground">(user field)</span>}</label>
        <input type="text" className="bg-background text-foreground border border-border rounded px-3 py-1.5 text-sm w-full"
          value={(fields.notes as string) || ''}
          onChange={e => onChange({ ...fields, notes: e.target.value || undefined })} />
      </div>
      {/* Description */}
      <div className="col-span-2">
        <label className="block text-xs text-muted-foreground mb-1">
          Description{mode === 'edit' && <span className="text-muted-foreground"> (original CSV text — editable)</span>}
          {mode === 'create' && <span className="text-muted-foreground"> (optional)</span>}
        </label>
        <input type="text" className="bg-background text-foreground border border-border rounded px-3 py-1.5 text-sm w-full text-muted-foreground"
          value={(fields.raw_description as string) || ''}
          onChange={e => onChange({ ...fields, raw_description: e.target.value || undefined })} />
      </div>
    </div>
  )
}

// ─── Edit modal wrapper (shell + form + save/cancel) ─────────────────────────

export interface TransactionEditModalProps {
  editing: EditState | null
  onClose: () => void
  onChangeFields: (fields: Partial<Transaction>) => void
  accounts: Account[]
  securities: Security[]
  tickerInput: string
  onTickerChange: (val: string) => void
  error: string | null
  saving: boolean
  onSave: () => void
}

export function TransactionEditModal({
  editing, onClose, onChangeFields, accounts, securities, tickerInput, onTickerChange, error, saving, onSave,
}: TransactionEditModalProps) {
  const qc = useQueryClient()
  const [createRule, setCreateRule] = useState(false)

  // Reset the checkbox each time a (different) transaction is opened for editing.
  useEffect(() => { setCreateRule(false) }, [editing?.tx.id])

  const overrideMutation = useMutation({
    mutationFn: (vars: { security_id: number; account_id: number; from_type: string; to_type: string }) =>
      createTypeOverride(vars.security_id, vars),
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: ['type-overrides', vars.security_id] })
    },
  })

  if (!editing) return null

  const originalType = editing.tx.transaction_type
  const draftType = (editing.fields.transaction_type as string | undefined) ?? originalType
  const typeChanged = draftType !== originalType
  const canCreateRule = typeChanged && !!editing.tx.security_id && !!editing.tx.account_id

  const handleSave = () => {
    if (createRule && canCreateRule) {
      overrideMutation.mutate({
        security_id: editing.tx.security_id!,
        account_id: editing.tx.account_id,
        from_type: originalType,
        to_type: draftType,
      })
    }
    onSave()
  }

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-card rounded-xl shadow-xl max-w-2xl w-full p-6 space-y-4">
        <div className="flex items-center justify-between">
          <h3 className="font-semibold text-foreground">Edit Transaction #{editing.tx.id}</h3>
          <button onClick={onClose} className="text-muted-foreground hover:text-muted-foreground">
            <X className="h-5 w-5" />
          </button>
        </div>
        <TxFormFields
          fields={editing.fields}
          onChange={onChangeFields}
          accounts={accounts}
          securities={securities}
          tickerInput={tickerInput}
          onTickerChange={onTickerChange}
          tickerDatalistId="edit-tx-tickers"
          mode="edit"
        />
        {canCreateRule && (
          <label className="flex items-start gap-2 bg-primary/10 border border-primary/20 rounded-lg px-3 py-2 text-xs text-primary cursor-pointer">
            <input type="checkbox" className="bg-background text-foreground mt-0.5" checked={createRule} onChange={e => setCreateRule(e.target.checked)} />
            <span>
              Always reclassify <strong>{originalType}</strong> → <strong>{draftType}</strong> for{' '}
              <strong>{editing.tx.security_ticker || 'this security'}</strong> in <strong>{editing.tx.account_name}</strong>{' '}
              going forward (applies to future imports only — this transaction is fixed either way).
            </span>
          </label>
        )}
        {overrideMutation.isError && (
          <div className="bg-amber-50 border border-amber-200 rounded p-2 text-xs text-amber-700">
            Transaction saved, but the reclassify rule failed to save — you can add it later from the security's Transactions tab.
          </div>
        )}
        {error && (
          <div className="bg-red-50 border border-red-200 rounded p-2 text-xs text-red-700">
            Error: {error}
          </div>
        )}
        <div className="flex justify-end gap-3 pt-2 border-t border-border">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm border border-border rounded-lg hover:bg-muted/50"
          >
            Cancel
          </button>
          <button
            onClick={handleSave}
            disabled={saving}
            className="flex items-center gap-2 px-4 py-2 text-sm bg-primary text-white rounded-lg hover:bg-primary/90 disabled:opacity-50"
          >
            <Check className="h-4 w-4" />
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </div>
    </div>
  )
}
