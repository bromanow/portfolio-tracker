import { useState } from 'react'
import { PanelLeftClose, PanelLeftOpen, ChevronRight, ScanSearch, SlidersHorizontal } from 'lucide-react'
import { CoveredCallScannerTool } from './Scanner'
import FundamentalScreener from '../components/FundamentalScreener'

type ToolId = 'covered-call-scanner' | 'fundamental-screener'

const TOOL_DEFS: {
  id: ToolId
  label: string
  description: string
  icon: React.ElementType
  component: React.ComponentType
}[] = [
  {
    id: 'covered-call-scanner',
    label: 'Covered Call Scanner',
    description: 'Find covered-call opportunities across your watchlist and holdings',
    icon: ScanSearch,
    component: CoveredCallScannerTool,
  },
  {
    id: 'fundamental-screener',
    label: 'Fundamental Screener',
    description: 'Sort and filter stocks by P/E, debt/equity, ROE, revenue growth, and more',
    icon: SlidersHorizontal,
    component: FundamentalScreener,
  },
]

// ── Main Research Page ────────────────────────────────────────────────────────
export default function Research() {
  const [activeId, setActiveId] = useState<ToolId>('covered-call-scanner')
  const [panelOpen, setPanelOpen] = useState(true)

  const active = TOOL_DEFS.find(t => t.id === activeId)!

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-gray-900">Research</h1>

      <div className="flex gap-6 items-start">
        {/* Left panel — tool list */}
        {panelOpen ? (
          <div className="w-64 flex-shrink-0 bg-white border border-gray-200 rounded-xl overflow-hidden">
            <div className="px-4 py-3 border-b border-gray-100 bg-gray-50 flex items-center justify-between">
              <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide">Research Tools</p>
              <button
                onClick={() => setPanelOpen(false)}
                title="Hide tool list"
                className="p-1 rounded text-gray-400 hover:text-gray-600 hover:bg-gray-200 transition-colors"
              >
                <PanelLeftClose className="h-3.5 w-3.5" />
              </button>
            </div>
            <nav className="divide-y divide-gray-50">
              {TOOL_DEFS.map(t => {
                const Icon = t.icon
                const isActive = t.id === activeId
                return (
                  <button
                    key={t.id}
                    onClick={() => setActiveId(t.id)}
                    className={`w-full text-left px-4 py-3.5 flex items-start gap-3 transition-colors group ${
                      isActive
                        ? 'bg-blue-50 border-l-2 border-blue-600'
                        : 'hover:bg-gray-50 border-l-2 border-transparent'
                    }`}
                  >
                    <Icon className={`h-4 w-4 mt-0.5 flex-shrink-0 ${isActive ? 'text-blue-600' : 'text-gray-400 group-hover:text-gray-600'}`} />
                    <div className="min-w-0">
                      <p className={`text-sm font-medium leading-tight ${isActive ? 'text-blue-700' : 'text-gray-700'}`}>{t.label}</p>
                      <p className="text-xs text-gray-400 mt-0.5 leading-snug">{t.description}</p>
                    </div>
                    {isActive && <ChevronRight className="h-4 w-4 text-blue-400 flex-shrink-0 mt-0.5 ml-auto" />}
                  </button>
                )
              })}
            </nav>
          </div>
        ) : (
          /* Collapsed — thin strip with expand button */
          <div className="flex-shrink-0">
            <button
              onClick={() => setPanelOpen(true)}
              title="Show tool list"
              className="flex items-center gap-1.5 px-2.5 py-2 bg-white border border-gray-200 rounded-lg text-xs text-gray-500 hover:text-gray-700 hover:bg-gray-50 transition-colors shadow-sm"
            >
              <PanelLeftOpen className="h-3.5 w-3.5" />
              Tools
            </button>
          </div>
        )}

        {/* Right panel — selected tool */}
        <div className="flex-1 min-w-0">
          <div className="space-y-5">
            <div className="flex items-center gap-3">
              {!panelOpen && (
                <button
                  onClick={() => setPanelOpen(true)}
                  title="Show tool list"
                  className="p-1.5 rounded-md text-gray-400 hover:text-gray-600 hover:bg-gray-100 transition-colors"
                >
                  <PanelLeftOpen className="h-4 w-4" />
                </button>
              )}
              <active.icon className="h-5 w-5 text-blue-600" />
              <div>
                <h2 className="text-lg font-semibold text-gray-900 leading-tight">{active.label}</h2>
                <p className="text-sm text-gray-500">{active.description}</p>
              </div>
            </div>
            <active.component />
          </div>
        </div>
      </div>
    </div>
  )
}
