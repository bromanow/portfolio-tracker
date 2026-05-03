import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { getPortfolioAnalytics } from '../api/client'
import type { AnalyticsSlice, AnalyticsHolding } from '../api/client'
import {
  PieChart, Pie, Cell, Tooltip, ResponsiveContainer, Legend,
  BarChart, Bar, XAxis, YAxis, CartesianGrid,
} from 'recharts'
import { ChevronDown, ChevronRight } from 'lucide-react'

const COLORS = [
  '#3B82F6', '#10B981', '#F59E0B', '#EF4444', '#8B5CF6',
  '#06B6D4', '#84CC16', '#F97316', '#EC4899', '#6366F1',
  '#14B8A6', '#A855F7', '#78716C',
]

const ASSET_CLASS_COLORS: Record<string, string> = {
  EQUITY: '#3B82F6',
  ETF: '#6366F1',
  OPTION: '#8B5CF6',
  FIXED_INCOME: '#10B981',
  CASH: '#94a3b8',
}

function fmtCAD(n: number) {
  if (Math.abs(n) >= 1e6) return `$${(n / 1e6).toFixed(1)}M`
  if (Math.abs(n) >= 1e3) return `$${(n / 1e3).toFixed(0)}K`
  return new Intl.NumberFormat('en-CA', { style: 'currency', currency: 'CAD', maximumFractionDigits: 0 }).format(n)
}

// ─── Mini pie chart ───────────────────────────────────────────────────────────

function MiniPie({ data, title, colorMap }: {
  data: AnalyticsSlice[]
  title: string
  colorMap?: Record<string, string>
}) {
  const MAX = 6
  const shown = data.slice(0, MAX)
  const rest = data.slice(MAX)
  const display = rest.length > 0
    ? [...shown, { label: 'Other', total_cad: rest.reduce((s, d) => s + d.total_cad, 0), pct: rest.reduce((s, d) => s + d.pct, 0) }]
    : shown

  if (!display.length) {
    return (
      <div className="bg-white rounded-xl border border-gray-200 p-4 shadow-sm">
        <h3 className="text-sm font-semibold text-gray-700 mb-2">{title}</h3>
        <p className="text-xs text-gray-400">No data</p>
      </div>
    )
  }

  return (
    <div className="bg-white rounded-xl border border-gray-200 p-4 shadow-sm">
      <h3 className="text-sm font-semibold text-gray-700 mb-1">{title}</h3>
      <ResponsiveContainer width="100%" height={190}>
        <PieChart>
          <Pie
            data={display}
            dataKey="pct"
            nameKey="label"
            cx="40%"
            cy="50%"
            outerRadius={70}
            innerRadius={32}
            labelLine={false}
          >
            {display.map((entry, i) => (
              <Cell
                key={entry.label}
                fill={colorMap?.[entry.label] ?? COLORS[i % COLORS.length]}
              />
            ))}
          </Pie>
          <Tooltip
            formatter={(v: number, _: string, entry: { payload?: { total_cad?: number } }) => [
              `${v.toFixed(1)}%  ${fmtCAD(entry?.payload?.total_cad ?? 0)}`,
            ]}
          />
          <Legend
            layout="vertical"
            align="right"
            verticalAlign="middle"
            iconSize={8}
            iconType="circle"
            formatter={(value: string) => (
              <span className="text-xs text-gray-600">{value}</span>
            )}
          />
        </PieChart>
      </ResponsiveContainer>
    </div>
  )
}

// ─── Horizontal bar chart ─────────────────────────────────────────────────────

function HBarChart({ data, title, colorFn }: {
  data: AnalyticsSlice[] | AnalyticsHolding[]
  title: string
  colorFn?: (entry: AnalyticsSlice | AnalyticsHolding, i: number) => string
}) {
  if (!data.length) {
    return (
      <div className="bg-white rounded-xl border border-gray-200 p-4 shadow-sm">
        <h3 className="text-sm font-semibold text-gray-700 mb-2">{title}</h3>
        <p className="text-xs text-gray-400">No data</p>
      </div>
    )
  }

  const labelKey = 'label' in data[0] ? 'label' : 'ticker'
  const chartHeight = Math.max(160, data.length * 28 + 32)

  return (
    <div className="bg-white rounded-xl border border-gray-200 p-4 shadow-sm">
      <h3 className="text-sm font-semibold text-gray-700 mb-1">{title}</h3>
      <ResponsiveContainer width="100%" height={chartHeight}>
        <BarChart
          data={data}
          layout="vertical"
          margin={{ top: 4, right: 48, bottom: 4, left: 4 }}
          barSize={14}
        >
          <CartesianGrid strokeDasharray="3 3" horizontal={false} stroke="#f0f0f0" />
          <XAxis type="number" tick={{ fontSize: 10 }} tickFormatter={v => `${v.toFixed(0)}%`} />
          <YAxis
            type="category"
            dataKey={labelKey}
            tick={{ fontSize: 10 }}
            width={90}
            tickFormatter={(v: string) => v.length > 14 ? v.slice(0, 13) + '…' : v}
          />
          <Tooltip
            formatter={(v: number, _: string, entry: { payload?: { total_cad?: number } }) => [
              `${v.toFixed(1)}%  ${fmtCAD(entry?.payload?.total_cad ?? 0)}`,
            ]}
          />
          <Bar dataKey="pct" radius={[0, 3, 3, 0]}>
            {data.map((entry, i) => (
              <Cell
                key={i}
                fill={colorFn ? colorFn(entry, i) : COLORS[i % COLORS.length]}
              />
            ))}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  )
}

// ─── Main panel ───────────────────────────────────────────────────────────────

interface Props {
  accountIds: string | undefined
  asOf?: string
}

export default function PortfolioAnalyticsPanel({ accountIds, asOf }: Props) {
  const [expanded, setExpanded] = useState(false)

  const { data, isLoading } = useQuery({
    queryKey: ['portfolio-analytics', accountIds, asOf],
    queryFn: () => getPortfolioAnalytics({ account_ids: accountIds, as_of: asOf }),
    enabled: expanded,
  })

  return (
    <div className="bg-white rounded-xl border border-gray-200 shadow-sm overflow-hidden">
      <div
        className="px-5 py-3 flex items-center gap-2 cursor-pointer hover:bg-gray-50 select-none"
        onClick={() => setExpanded(e => !e)}
      >
        {expanded
          ? <ChevronDown className="h-4 w-4 text-gray-400" />
          : <ChevronRight className="h-4 w-4 text-gray-400" />}
        <h2 className="font-semibold text-gray-800">Portfolio Analytics</h2>
        <span className="text-xs text-gray-400">sector · geography · currency · concentration</span>
      </div>

      {expanded && (
        <div className="border-t border-gray-100 p-5">
          {isLoading ? (
            <div className="flex items-center justify-center h-40">
              <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-blue-600" />
            </div>
          ) : !data ? (
            <p className="text-gray-400 text-sm">No analytics data.</p>
          ) : (
            <div className="space-y-4">
              {/* Row 1: Asset Class + Sector */}
              <div className="grid grid-cols-2 gap-4">
                <MiniPie
                  data={data.asset_class}
                  title="Asset Class"
                  colorMap={ASSET_CLASS_COLORS}
                />
                <MiniPie
                  data={data.sector}
                  title="Sector"
                />
              </div>

              {/* Row 2: Currency + Country */}
              <div className="grid grid-cols-2 gap-4">
                <MiniPie
                  data={data.currency}
                  title="Currency Exposure"
                />
                <HBarChart
                  data={data.country}
                  title="Geographic Exposure"
                />
              </div>

              {/* Row 3: Top Holdings */}
              {data.top_holdings.length > 0 && (
                <HBarChart
                  data={data.top_holdings.map(h => ({
                    ...h,
                    label: h.ticker,
                  })) as AnalyticsSlice[]}
                  title="Top Holdings by Value"
                  colorFn={(entry) => ASSET_CLASS_COLORS[(entry as AnalyticsHolding).asset_class] ?? COLORS[0]}
                />
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
