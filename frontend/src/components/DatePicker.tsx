import { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronLeft, ChevronRight, Calendar as CalIcon, X } from 'lucide-react'

// A lightweight calendar date picker that replaces the native <input type="date">.
// - No free-text year entry (so you can't type a 5-digit year)
// - Month + year dropdowns for fast jumps across many years
// - value/onChange use ISO "YYYY-MM-DD" strings (same contract as the native input)

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const WD = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa']

const pad = (n: number) => String(n).padStart(2, '0')
const iso = (y: number, m: number, d: number) => `${y}-${pad(m + 1)}-${pad(d)}`
const parseISO = (s: string): { y: number; m: number; d: number } | null => {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s)
  if (!m) return null
  return { y: +m[1], m: +m[2] - 1, d: +m[3] }
}
const fmtDisplay = (s: string) => {
  const p = parseISO(s)
  return p ? `${MONTHS[p.m]} ${p.d}, ${p.y}` : ''
}

export default function DatePicker({
  value, onChange, min, max, placeholder = 'Pick date', highlight = false, className = 'w-32',
}: {
  value: string
  onChange: (v: string) => void
  min?: string
  max?: string
  placeholder?: string
  highlight?: boolean
  className?: string
}) {
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)
  const today = new Date()
  const sel = parseISO(value)
  // The month currently shown in the calendar grid (defaults to selection, else today).
  const [view, setView] = useState(() => sel ?? { y: today.getFullYear(), m: today.getMonth(), d: 1 })

  useEffect(() => { if (sel) setView({ y: sel.y, m: sel.m, d: 1 }) }, [value])  // eslint-disable-line

  useEffect(() => {
    if (!open) return
    const onDoc = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])

  const minP = min ? parseISO(min) : null
  const maxP = max ? parseISO(max) : null
  const minY = minP?.y ?? 2000
  const maxY = maxP?.y ?? today.getFullYear()
  const years = useMemo(
    () => Array.from({ length: maxY - minY + 1 }, (_, i) => maxY - i),
    [minY, maxY],
  )

  const disabled = (y: number, m: number, d: number) => {
    const v = iso(y, m, d)
    if (min && v < min) return true
    if (max && v > max) return true
    return false
  }

  const firstWd = new Date(view.y, view.m, 1).getDay()
  const daysIn = new Date(view.y, view.m + 1, 0).getDate()
  const cells: (number | null)[] = [
    ...Array(firstWd).fill(null),
    ...Array.from({ length: daysIn }, (_, i) => i + 1),
  ]

  const shiftMonth = (delta: number) => {
    let m = view.m + delta, y = view.y
    if (m < 0) { m = 11; y-- }
    if (m > 11) { m = 0; y++ }
    setView({ y, m, d: 1 })
  }

  return (
    <div ref={wrapRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        className={`flex items-center gap-1.5 border rounded px-2 py-1 text-xs ${className} focus:outline-none focus:ring-1 focus:ring-blue-400 ${
          highlight ? 'border-blue-400 text-blue-700' : 'border-gray-200 text-gray-600'
        }`}
      >
        <CalIcon className="h-3.5 w-3.5 text-gray-400 shrink-0" />
        <span className={`truncate ${value ? '' : 'text-gray-400'}`}>{value ? fmtDisplay(value) : placeholder}</span>
        {value && (
          <X
            className="h-3 w-3 text-gray-300 hover:text-red-500 ml-auto shrink-0"
            onClick={e => { e.stopPropagation(); onChange(''); setOpen(false) }}
          />
        )}
      </button>

      {open && (
        <div className="absolute z-30 mt-1 bg-white border border-gray-200 rounded-lg shadow-lg p-2 w-60">
          <div className="flex items-center justify-between gap-1 mb-2">
            <button type="button" onClick={() => shiftMonth(-1)} className="p-1 text-gray-400 hover:text-gray-700 rounded hover:bg-gray-100">
              <ChevronLeft className="h-4 w-4" />
            </button>
            <div className="flex items-center gap-1">
              <select
                value={view.m}
                onChange={e => setView(v => ({ ...v, m: +e.target.value }))}
                className="text-xs border border-gray-200 rounded px-1 py-0.5 focus:outline-none focus:ring-1 focus:ring-blue-400"
              >
                {MONTHS.map((mo, i) => <option key={mo} value={i}>{mo}</option>)}
              </select>
              <select
                value={view.y}
                onChange={e => setView(v => ({ ...v, y: +e.target.value }))}
                className="text-xs border border-gray-200 rounded px-1 py-0.5 focus:outline-none focus:ring-1 focus:ring-blue-400"
              >
                {years.map(y => <option key={y} value={y}>{y}</option>)}
              </select>
            </div>
            <button type="button" onClick={() => shiftMonth(1)} className="p-1 text-gray-400 hover:text-gray-700 rounded hover:bg-gray-100">
              <ChevronRight className="h-4 w-4" />
            </button>
          </div>

          <div className="grid grid-cols-7 gap-0.5 text-center">
            {WD.map(w => <div key={w} className="text-[10px] text-gray-400 font-medium py-0.5">{w}</div>)}
            {cells.map((d, i) => {
              if (d === null) return <div key={i} />
              const isSel = sel && sel.y === view.y && sel.m === view.m && sel.d === d
              const isToday = today.getFullYear() === view.y && today.getMonth() === view.m && today.getDate() === d
              const dis = disabled(view.y, view.m, d)
              return (
                <button
                  key={i}
                  type="button"
                  disabled={dis}
                  onClick={() => { onChange(iso(view.y, view.m, d)); setOpen(false) }}
                  className={`text-xs rounded py-1 transition-colors ${
                    isSel ? 'bg-blue-600 text-white font-semibold'
                      : dis ? 'text-gray-300 cursor-not-allowed'
                      : isToday ? 'text-blue-600 font-semibold hover:bg-blue-50'
                      : 'text-gray-700 hover:bg-blue-50'
                  }`}
                >
                  {d}
                </button>
              )
            })}
          </div>

          <div className="flex justify-between mt-2 pt-2 border-t border-gray-100">
            <button
              type="button"
              onClick={() => { const t = new Date(); onChange(iso(t.getFullYear(), t.getMonth(), t.getDate())); setOpen(false) }}
              className="text-[11px] text-blue-600 hover:text-blue-700"
            >
              Today
            </button>
            {value && (
              <button type="button" onClick={() => { onChange(''); setOpen(false) }} className="text-[11px] text-gray-400 hover:text-red-500">
                Clear
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
