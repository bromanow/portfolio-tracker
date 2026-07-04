import { useEffect, useRef, useState } from 'react'
import {
  createChart, LineSeries, HistogramSeries, LineStyle, ColorType,
  type IChartApi, type ISeriesApi, type Time,
} from 'lightweight-charts'
import { sma, rsi, macd, bollingerBands } from '../utils/technicalIndicators'

export interface ChartPoint {
  date: string   // 'YYYY-MM-DD'
  price: number
}

interface TechnicalChartProps {
  data: ChartPoint[]
  costBasis?: number | null
  currency?: string
  height?: number
}

type ToggleKey = 'ma' | 'bollinger' | 'rsi' | 'macd'

const TOGGLES: { key: ToggleKey; label: string }[] = [
  { key: 'ma', label: 'MA(50)' },
  { key: 'bollinger', label: 'Bollinger Bands' },
  { key: 'rsi', label: 'RSI(14)' },
  { key: 'macd', label: 'MACD' },
]

export default function TechnicalChart({ data, costBasis, currency = 'CAD', height = 280 }: TechnicalChartProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const chartRef = useRef<IChartApi | null>(null)
  const [active, setActive] = useState<Set<ToggleKey>>(new Set())

  const toggle = (key: ToggleKey) => {
    setActive(prev => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }

  useEffect(() => {
    const el = containerRef.current
    if (!el || data.length === 0) return

    const showRsi = active.has('rsi')
    const showMacd = active.has('macd')
    const extraPanes = (showRsi ? 1 : 0) + (showMacd ? 1 : 0)

    const chart = createChart(el, {
      autoSize: true,
      height: height + extraPanes * 110,
      layout: { background: { type: ColorType.Solid, color: 'transparent' }, textColor: '#6b7280', fontSize: 11 },
      grid: { vertLines: { color: '#f3f4f6' }, horzLines: { color: '#f3f4f6' } },
      rightPriceScale: { borderColor: '#e5e7eb' },
      timeScale: { borderColor: '#e5e7eb', timeVisible: false },
      crosshair: { mode: 0 },
    })
    chartRef.current = chart

    const times = data.map(d => d.date as Time)
    const closes = data.map(d => d.price)

    // ── Price pane (0) ──────────────────────────────────────────────────────
    const priceSeries = chart.addSeries(LineSeries, {
      color: '#2563eb', lineWidth: 2, priceLineVisible: false,
      title: `Price (${currency})`,
    }, 0)
    priceSeries.setData(data.map((d, i) => ({ time: times[i], value: d.price })))

    if (costBasis != null && costBasis > 0) {
      priceSeries.createPriceLine({
        price: costBasis, color: '#f97316', lineWidth: 1, lineStyle: LineStyle.Dashed,
        axisLabelVisible: true, title: 'Cost',
      })
    }

    if (active.has('ma')) {
      const maVals = sma(closes, 50)
      const maSeries = chart.addSeries(LineSeries, {
        color: '#8b5cf6', lineWidth: 1, priceLineVisible: false, title: 'MA(50)',
      }, 0)
      maSeries.setData(
        data.map((d, i) => ({ time: times[i], value: maVals[i] }))
          .filter((p): p is { time: Time; value: number } => p.value != null),
      )
    }

    if (active.has('bollinger')) {
      const bb = bollingerBands(closes, 20, 2)
      const bandSeries: [ (number | null)[], string, boolean ][] = [
        [bb.upper, '#9ca3af', false],
        [bb.middle, '#9ca3af', true],
        [bb.lower, '#9ca3af', false],
      ]
      for (const [vals, color, dashed] of bandSeries) {
        const s = chart.addSeries(LineSeries, {
          color, lineWidth: 1, lineStyle: dashed ? LineStyle.Dotted : LineStyle.Solid,
          priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false,
        }, 0)
        s.setData(
          data.map((d, i) => ({ time: times[i], value: vals[i] }))
            .filter((p): p is { time: Time; value: number } => p.value != null),
        )
      }
    }

    let paneIdx = 1

    // ── RSI pane ─────────────────────────────────────────────────────────────
    if (showRsi) {
      const rsiVals = rsi(closes, 14)
      const rsiSeries: ISeriesApi<'Line'> = chart.addSeries(LineSeries, {
        color: '#0891b2', lineWidth: 1, priceLineVisible: false, title: 'RSI(14)',
      }, paneIdx)
      rsiSeries.setData(
        data.map((d, i) => ({ time: times[i], value: rsiVals[i] }))
          .filter((p): p is { time: Time; value: number } => p.value != null),
      )
      rsiSeries.createPriceLine({ price: 70, color: '#d1d5db', lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: false, title: '' })
      rsiSeries.createPriceLine({ price: 30, color: '#d1d5db', lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: false, title: '' })
      chart.panes()[paneIdx]?.setHeight(100)
      paneIdx++
    }

    // ── MACD pane ────────────────────────────────────────────────────────────
    if (showMacd) {
      const m = macd(closes, 12, 26, 9)
      const histSeries = chart.addSeries(HistogramSeries, { priceLineVisible: false, title: 'MACD Hist' }, paneIdx)
      histSeries.setData(
        data.map((d, i) => ({
          time: times[i], value: m.histogram[i], color: (m.histogram[i] ?? 0) >= 0 ? '#10b981' : '#ef4444',
        })).filter((p): p is { time: Time; value: number; color: string } => p.value != null),
      )
      const macdSeries = chart.addSeries(LineSeries, { color: '#2563eb', lineWidth: 1, priceLineVisible: false, title: 'MACD' }, paneIdx)
      macdSeries.setData(
        data.map((d, i) => ({ time: times[i], value: m.macd[i] }))
          .filter((p): p is { time: Time; value: number } => p.value != null),
      )
      const signalSeries = chart.addSeries(LineSeries, { color: '#f59e0b', lineWidth: 1, priceLineVisible: false, title: 'Signal' }, paneIdx)
      signalSeries.setData(
        data.map((d, i) => ({ time: times[i], value: m.signal[i] }))
          .filter((p): p is { time: Time; value: number } => p.value != null),
      )
      chart.panes()[paneIdx]?.setHeight(100)
    }

    chart.timeScale().fitContent()

    return () => {
      chart.remove()
      chartRef.current = null
    }
  }, [data, active, costBasis, currency, height])

  return (
    <div>
      <div className="flex items-center gap-2 mb-2 flex-wrap">
        {TOGGLES.map(t => (
          <button
            key={t.key}
            onClick={() => toggle(t.key)}
            className={`px-2.5 py-1 text-xs rounded-md font-medium border transition-colors ${
              active.has(t.key)
                ? 'bg-blue-50 border-blue-200 text-blue-700'
                : 'bg-white border-gray-200 text-gray-500 hover:bg-gray-50'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>
      <div ref={containerRef} className="w-full" />
    </div>
  )
}
