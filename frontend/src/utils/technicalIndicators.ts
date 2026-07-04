// Client-side technical indicator math, computed from a plain close-price series.
// Standard formulas (Wilder's RSI, EMA-based MACD, SMA+stddev Bollinger Bands) —
// no external TA library, since the app only has daily close prices (no OHLC/volume)
// so there's nothing here that needs more than these.

export function sma(values: number[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null)
  let sum = 0
  for (let i = 0; i < values.length; i++) {
    sum += values[i]
    if (i >= period) sum -= values[i - period]
    if (i >= period - 1) out[i] = sum / period
  }
  return out
}

export function ema(values: number[], period: number): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null)
  if (values.length < period) return out
  const k = 2 / (period + 1)
  let seed = 0
  for (let i = 0; i < period; i++) seed += values[i]
  let prev = seed / period
  out[period - 1] = prev
  for (let i = period; i < values.length; i++) {
    prev = values[i] * k + prev * (1 - k)
    out[i] = prev
  }
  return out
}

/** Wilder's RSI. Returns values on a 0-100 scale, null until enough data exists. */
export function rsi(values: number[], period = 14): (number | null)[] {
  const out: (number | null)[] = new Array(values.length).fill(null)
  if (values.length <= period) return out

  let gainSum = 0, lossSum = 0
  for (let i = 1; i <= period; i++) {
    const change = values[i] - values[i - 1]
    if (change >= 0) gainSum += change
    else lossSum -= change
  }
  let avgGain = gainSum / period
  let avgLoss = lossSum / period
  out[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss)

  for (let i = period + 1; i < values.length; i++) {
    const change = values[i] - values[i - 1]
    const gain = change >= 0 ? change : 0
    const loss = change < 0 ? -change : 0
    avgGain = (avgGain * (period - 1) + gain) / period
    avgLoss = (avgLoss * (period - 1) + loss) / period
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss)
  }
  return out
}

export interface MacdResult {
  macd: (number | null)[]
  signal: (number | null)[]
  histogram: (number | null)[]
}

export function macd(values: number[], fast = 12, slow = 26, signalPeriod = 9): MacdResult {
  const emaFast = ema(values, fast)
  const emaSlow = ema(values, slow)
  const macdLine: (number | null)[] = values.map((_, i) => {
    const f = emaFast[i], s = emaSlow[i]
    return f != null && s != null ? f - s : null
  })

  // EMA of the MACD line, skipping the leading nulls (macdLine only has real values from
  // index `slow - 1` onward — ema() would otherwise seed on nulls).
  const firstValid = macdLine.findIndex(v => v != null)
  const signalLine: (number | null)[] = new Array(values.length).fill(null)
  if (firstValid >= 0) {
    const compact = macdLine.slice(firstValid) as number[]
    const compactSignal = ema(compact, signalPeriod)
    compactSignal.forEach((v, i) => { signalLine[firstValid + i] = v })
  }

  const histogram: (number | null)[] = values.map((_, i) => {
    const m = macdLine[i], s = signalLine[i]
    return m != null && s != null ? m - s : null
  })

  return { macd: macdLine, signal: signalLine, histogram }
}

export interface BollingerBandsResult {
  upper: (number | null)[]
  middle: (number | null)[]
  lower: (number | null)[]
}

export function bollingerBands(values: number[], period = 20, stdDevMultiplier = 2): BollingerBandsResult {
  const middle = sma(values, period)
  const upper: (number | null)[] = new Array(values.length).fill(null)
  const lower: (number | null)[] = new Array(values.length).fill(null)

  for (let i = period - 1; i < values.length; i++) {
    const window = values.slice(i - period + 1, i + 1)
    const mean = middle[i] as number
    const variance = window.reduce((s, v) => s + (v - mean) ** 2, 0) / period
    const stdDev = Math.sqrt(variance)
    upper[i] = mean + stdDevMultiplier * stdDev
    lower[i] = mean - stdDevMultiplier * stdDev
  }
  return { upper, middle, lower }
}
