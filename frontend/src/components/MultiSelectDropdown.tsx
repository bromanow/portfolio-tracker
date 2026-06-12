import { useState, useRef, useEffect } from 'react'
import { ChevronDown } from 'lucide-react'

interface Option {
  value: string
  label: string
}

interface MultiSelectDropdownProps {
  placeholder: string
  options: Option[]
  selected: string[]
  onChange: (values: string[]) => void
  disabled?: boolean
}

export default function MultiSelectDropdown({
  placeholder,
  options,
  selected,
  onChange,
  disabled = false,
}: MultiSelectDropdownProps) {
  const [open, setOpen] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    function handleMouseDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handleMouseDown)
    return () => document.removeEventListener('mousedown', handleMouseDown)
  }, [open])

  useEffect(() => {
    if (!open) return
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [open])

  const toggle = (val: string) =>
    onChange(selected.includes(val) ? selected.filter(v => v !== val) : [...selected, val])

  const displayLabel =
    selected.length === 0
      ? placeholder
      : selected.length === 1
        ? options.find(o => o.value === selected[0])?.label ?? selected[0]
        : `${selected.length} selected`

  const isActive = selected.length > 0

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen(o => !o)}
        className={`border rounded px-2 py-1 text-xs flex items-center gap-1 min-w-max transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
          isActive
            ? 'border-blue-400 bg-blue-50 text-blue-700'
            : 'border-gray-200 bg-white text-gray-600 hover:border-gray-300'
        }`}
      >
        <span>{displayLabel}</span>
        <ChevronDown className={`h-3 w-3 opacity-50 flex-shrink-0 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <div className="absolute top-full left-0 mt-1 bg-white border border-gray-200 rounded-lg shadow-xl z-50 min-w-max max-h-64 overflow-y-auto">
          {options.length > 0 && (
            <div className="sticky top-0 bg-white px-3 py-1.5 border-b border-gray-100 flex justify-between items-center gap-3">
              <span className="text-xs text-gray-400">
                {selected.length === 0 ? 'All' : `${selected.length} selected`}
              </span>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => onChange(options.map(o => o.value))}
                  disabled={selected.length === options.length}
                  className="text-xs text-blue-600 hover:text-blue-800 font-medium disabled:text-gray-300 disabled:cursor-default"
                >
                  Select all
                </button>
                <span className="text-gray-200">·</span>
                <button
                  type="button"
                  onClick={() => onChange([])}
                  disabled={selected.length === 0}
                  className="text-xs text-blue-600 hover:text-blue-800 font-medium disabled:text-gray-300 disabled:cursor-default"
                >
                  Clear
                </button>
              </div>
            </div>
          )}
          {options.length === 0 && (
            <div className="px-3 py-2 text-xs text-gray-400">No options</div>
          )}
          {options.map(opt => (
            <label
              key={opt.value}
              className="flex items-center gap-2 px-3 py-1.5 hover:bg-gray-50 cursor-pointer text-xs whitespace-nowrap"
            >
              <input
                type="checkbox"
                checked={selected.includes(opt.value)}
                onChange={() => toggle(opt.value)}
                className="rounded accent-blue-600"
              />
              {opt.label}
            </label>
          ))}
        </div>
      )}
    </div>
  )
}
