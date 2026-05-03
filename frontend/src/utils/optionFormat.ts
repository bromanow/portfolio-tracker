export interface ParsedOption {
  display: string        // "AMD $125C Sep 19 '25"
  underlying: string     // "AMD"
  optionType: 'CALL' | 'PUT'
  typeChar: string       // "C" or "P"
  strike: number         // 125
  expiry: string         // "2025-09-19"
  expiryShort: string    // "Sep 19 '25"
  isCanadian: boolean
}

function makeExpiryShort(year: number, month: number, day: number): string {
  const d = new Date(year, month - 1, day, 12, 0, 0)
  const mon = d.toLocaleDateString('en-CA', { month: 'short' })
  const yr = String(year).slice(-2)
  return `${mon} ${day} '${yr}`
}

function strikeDisplay(strike: number): string {
  return strike % 1 === 0 ? `$${strike}` : `$${strike.toFixed(2)}`
}

export function parseOptionTicker(ticker: string): ParsedOption | null {
  const t = ticker.trim()

  // --- Legacy format: "CALL AMD 09/19/25 125" or "CALL .BNS 12/19/25 97" ---
  const legacy = t.match(/^(CALL|PUT)\s+\.?([\w\-]+)\s+(\d{2})\/(\d{2})\/(\d{2})\s+([\d.]+)/i)
  if (legacy) {
    const [, type, underlying, mo, dy, yr, strikeStr] = legacy
    const strike = parseFloat(strikeStr)
    const optionType = type.toUpperCase() as 'CALL' | 'PUT'
    const typeChar = optionType === 'CALL' ? 'C' : 'P'
    const year = 2000 + parseInt(yr)
    const expiry = `${year}-${mo}-${dy}`
    const expiryShort = makeExpiryShort(year, parseInt(mo), parseInt(dy))
    const isCanadian = /^(CALL|PUT)\s+\./i.test(t)
    return {
      display: `${underlying} ${strikeDisplay(strike)}${typeChar} ${expiryShort}`,
      underlying,
      optionType,
      typeChar,
      strike,
      expiry,
      expiryShort,
      isCanadian,
    }
  }

  // --- IB/OCC format: "CRWD 260717C00400000" or "WCP 260417C00014500" ---
  // Pattern: {underlying} {YYMMDD}{C|P}{8-digit-strike*1000}
  const ib = t.match(/^([\w\-\.]+)\s+(\d{2})(\d{2})(\d{2})([CP])(\d{8})$/i)
  if (ib) {
    const [, underlying, yy, mm, dd, tc, strikeStr] = ib
    const year = 2000 + parseInt(yy)
    const month = parseInt(mm)
    const day = parseInt(dd)
    const strike = parseInt(strikeStr) / 1000
    const optionType: 'CALL' | 'PUT' = tc.toUpperCase() === 'C' ? 'CALL' : 'PUT'
    const typeChar = tc.toUpperCase()
    const expiry = `${year}-${mm}-${dd}`
    const expiryShort = makeExpiryShort(year, month, day)
    return {
      display: `${underlying} ${strikeDisplay(strike)}${typeChar} ${expiryShort}`,
      underlying,
      optionType,
      typeChar,
      strike,
      expiry,
      expiryShort,
      isCanadian: false, // determined from security record on backend
    }
  }

  return null
}

export function formatOptionTicker(ticker: string): string {
  return parseOptionTicker(ticker)?.display ?? ticker
}
