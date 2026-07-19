import { useState } from 'react'
import {
  TrendingUp, DollarSign, Landmark, PanelLeftClose, PanelLeftOpen,
  Activity, Calculator, CalendarRange, FileSearch, Globe, List, ChevronRight,
} from 'lucide-react'
import { usePreference } from '../hooks/usePreference'
import RealizedGainsReport from './reports/RealizedGainsReport'
import IncomeReport from './reports/IncomeReport'
import PortfolioValueReport from './reports/PortfolioValueReport'
import PortfolioContinuityReport from './reports/PortfolioContinuityReport'
import CashStatementReport from './reports/CashStatementReport'
import MonthlyReturnsReport from './reports/MonthlyReturnsReport'
import ReturnDetailReport from './reports/ReturnDetailReport'
import FxRatesReport from './reports/FxRatesReport'
import LedgerReport from './reports/LedgerReport'

type ReportId = 'realized-gains' | 'income' | 'cash-statement' | 'portfolio-value' | 'continuity' | 'monthly-returns' | 'return-detail' | 'fx-rates' | 'ledger'

const REPORT_DEFS: {
  id: ReportId
  label: string
  description: string
  icon: React.ElementType
  component: React.ComponentType
}[] = [
  {
    id: 'portfolio-value',
    label: 'Portfolio Value Over Time',
    description: 'Historical NAV chart showing market vs. book value',
    icon: Activity,
    component: PortfolioValueReport,
  },
  {
    id: 'continuity',
    label: 'Portfolio Continuity',
    description: 'Reconcile portfolio changes: contributions, gains, income, fees',
    icon: Calculator,
    component: PortfolioContinuityReport,
  },
  {
    id: 'realized-gains',
    label: 'Realized Gains / Losses',
    description: 'Taxable dispositions and net capital gains by security and year',
    icon: TrendingUp,
    component: RealizedGainsReport,
  },
  {
    id: 'income',
    label: 'Investment Income',
    description: 'Dividends, interest, distributions, and other income',
    icon: DollarSign,
    component: IncomeReport,
  },
  {
    id: 'cash-statement',
    label: 'Cash Statement',
    description: 'Running cash balance with debits and credits by account',
    icon: Landmark,
    component: CashStatementReport,
  },
  {
    id: 'monthly-returns',
    label: 'Monthly / Annual Returns',
    description: 'Month-by-month return matrix per account, including closed accounts',
    icon: CalendarRange,
    component: MonthlyReturnsReport,
  },
  {
    id: 'return-detail',
    label: 'Return Calculation Detail',
    description: 'Numerator/denominator breakdown: price change, income, capital returned',
    icon: FileSearch,
    component: ReturnDetailReport,
  },
  {
    id: 'fx-rates',
    label: 'FX Rates',
    description: 'USD/CAD exchange rates used for portfolio calculations',
    icon: Globe,
    component: FxRatesReport,
  },
  {
    id: 'ledger',
    label: 'Transaction Ledger',
    description: 'Browse, filter, create, edit, and export all transactions',
    icon: List,
    component: LedgerReport,
  },
]

// ── Main Reports Page ─────────────────────────────────────────────────────────
export default function Reports() {
  // Subscribed only so this component (and the active report below) re-renders when
  // the header's eye-icon toggle flips — the fmtCAD* helpers read the pref via getPref().
  usePreference('hideValues')
  const [activeId, setActiveId] = useState<ReportId | null>(null)
  const [panelOpen, setPanelOpen] = useState(true)

  const active = REPORT_DEFS.find(r => r.id === activeId)

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-bold text-foreground">Reports</h1>

      <div className="flex gap-6 items-start">
        {/* Left panel — report list */}
        {panelOpen ? (
          <div className="w-64 flex-shrink-0 bg-card border border-border rounded-xl overflow-hidden">
            <div className="px-4 py-3 border-b border-border bg-muted/50 flex items-center justify-between">
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide">Available Reports</p>
              <button
                onClick={() => setPanelOpen(false)}
                title="Hide report list"
                className="p-1 rounded text-muted-foreground hover:text-muted-foreground hover:bg-accent transition-colors"
              >
                <PanelLeftClose className="h-3.5 w-3.5" />
              </button>
            </div>
            <nav className="divide-y divide-border/60">
              {REPORT_DEFS.map(r => {
                const Icon = r.icon
                const isActive = r.id === activeId
                return (
                  <button
                    key={r.id}
                    onClick={() => setActiveId(r.id)}
                    className={`w-full text-left px-4 py-3.5 flex items-start gap-3 transition-colors group ${
                      isActive
                        ? 'bg-primary/10 border-l-2 border-primary'
                        : 'hover:bg-muted/50 border-l-2 border-transparent'
                    }`}
                  >
                    <Icon className={`h-4 w-4 mt-0.5 flex-shrink-0 ${isActive ? 'text-primary' : 'text-muted-foreground group-hover:text-muted-foreground'}`} />
                    <div className="min-w-0">
                      <p className={`text-sm font-medium leading-tight ${isActive ? 'text-primary' : 'text-foreground'}`}>{r.label}</p>
                      <p className="text-xs text-muted-foreground mt-0.5 leading-snug">{r.description}</p>
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
              title="Show report list"
              className="flex items-center gap-1.5 px-2.5 py-2 bg-card border border-border rounded-lg text-xs text-muted-foreground hover:text-foreground hover:bg-muted/50 transition-colors shadow-sm"
            >
              <PanelLeftOpen className="h-3.5 w-3.5" />
              Reports
            </button>
          </div>
        )}

        {/* Right panel — selected report */}
        <div className="flex-1 min-w-0">
          {!active ? (
            <div className="bg-card border border-border rounded-xl flex flex-col items-center justify-center py-24 text-center px-8">
              <BarChart2Icon className="h-10 w-10 text-muted-foreground/50 mb-3" />
              <p className="text-muted-foreground font-medium">Select a report</p>
              <p className="text-sm text-muted-foreground mt-1">
                {panelOpen
                  ? 'Choose a report from the list on the left to get started.'
                  : 'Click "Reports" on the left to choose a report.'}
              </p>
            </div>
          ) : (
            <div className="space-y-5">
              <div className="flex items-center gap-3">
                {!panelOpen && (
                  <button
                    onClick={() => setPanelOpen(true)}
                    title="Show report list"
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
          )}
        </div>
      </div>
    </div>
  )
}

// tiny shim so we can reference BarChart2 as a component in the empty state
function BarChart2Icon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" stroke="currentColor" strokeWidth={1.5} viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" d="M3 13.5V21M8.25 9.75V21M13.5 6V21M18.75 3V21" />
    </svg>
  )
}
