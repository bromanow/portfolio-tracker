import { useState } from 'react'
import { PanelLeftClose, PanelLeftOpen, ChevronRight, Target, SlidersHorizontal, Radar } from 'lucide-react'
import CoveredCallPortfolioTool from './CoveredCallPortfolioTool'
import FundamentalScreener from '../components/FundamentalScreener'
import IbkrScannerTool from '../components/IbkrScannerTool'

type ToolId = 'covered-call-portfolio' | 'fundamental-screener' | 'ibkr-scanner'

const TOOL_DEFS: {
  id: ToolId
  label: string
  description: string
  icon: React.ElementType
  component: React.ComponentType
}[] = [
  {
    id: 'covered-call-portfolio',
    label: 'Covered Call Portfolio',
    description: 'Build and manage a covered-call income portfolio from your own target parameters',
    icon: Target,
    component: CoveredCallPortfolioTool,
  },
  {
    id: 'fundamental-screener',
    label: 'Fundamental Screener',
    description: 'Sort and filter stocks by P/E, debt/equity, ROE, revenue growth, and more',
    icon: SlidersHorizontal,
    component: FundamentalScreener,
  },
  {
    id: 'ibkr-scanner',
    label: 'IBKR Market Scanner',
    description: 'Live server-side scans of IBKR\'s full universe — no fixed ticker list needed (prototype)',
    icon: Radar,
    component: IbkrScannerTool,
  },
]

// ── Main Research Page ────────────────────────────────────────────────────────
export default function Research() {
  const [activeId, setActiveId] = useState<ToolId>('covered-call-portfolio')
  const [panelOpen, setPanelOpen] = useState(true)

  const active = TOOL_DEFS.find(t => t.id === activeId)!

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-foreground">Research</h1>

      <div className="flex gap-6 items-start">
        {/* Left panel — tool list */}
        {panelOpen ? (
          <div className="w-64 flex-shrink-0 bg-card border border-border rounded-xl overflow-hidden">
            <div className="px-4 py-3 border-b border-border bg-muted/50 flex items-center justify-between">
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Research Tools</p>
              <button
                onClick={() => setPanelOpen(false)}
                title="Hide tool list"
                className="p-1 rounded text-muted-foreground hover:text-muted-foreground hover:bg-accent transition-colors"
              >
                <PanelLeftClose className="h-3.5 w-3.5" />
              </button>
            </div>
            <nav className="divide-y divide-border/60">
              {TOOL_DEFS.map(t => {
                const Icon = t.icon
                const isActive = t.id === activeId
                return (
                  <button
                    key={t.id}
                    onClick={() => setActiveId(t.id)}
                    className={`w-full text-left px-4 py-3.5 flex items-start gap-3 transition-colors group ${
                      isActive
                        ? 'bg-primary/10 border-l-2 border-primary'
                        : 'hover:bg-muted/50 border-l-2 border-transparent'
                    }`}
                  >
                    <Icon className={`h-4 w-4 mt-0.5 flex-shrink-0 ${isActive ? 'text-primary' : 'text-muted-foreground group-hover:text-muted-foreground'}`} />
                    <div className="min-w-0">
                      <p className={`text-sm font-medium leading-tight ${isActive ? 'text-primary' : 'text-foreground'}`}>{t.label}</p>
                      <p className="text-xs text-muted-foreground mt-0.5 leading-snug">{t.description}</p>
                    </div>
                    {isActive && <ChevronRight className="h-4 w-4 text-primary/60 flex-shrink-0 mt-0.5 ml-auto" />}
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
              className="flex items-center gap-1.5 px-2.5 py-2 bg-card border border-border rounded-lg text-xs text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors shadow-sm"
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
                  className="p-1.5 rounded-md text-muted-foreground hover:text-muted-foreground hover:bg-accent transition-colors"
                >
                  <PanelLeftOpen className="h-4 w-4" />
                </button>
              )}
              <active.icon className="h-5 w-5 text-primary" />
              <div>
                <h2 className="text-lg font-semibold text-foreground leading-tight">{active.label}</h2>
                <p className="text-sm text-muted-foreground">{active.description}</p>
              </div>
            </div>
            <active.component />
          </div>
        </div>
      </div>
    </div>
  )
}
