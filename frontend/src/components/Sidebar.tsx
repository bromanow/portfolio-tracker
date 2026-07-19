import { useState } from 'react'
import { NavLink, useSearchParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import {
  LayoutDashboard,
  List,
  Settings,
  Briefcase,
  TrendingUp,
  ScanSearch,
  HeartPulse,
  ChevronLeft,
  ChevronRight,
  LogOut,
  Sun,
  Moon,
  Monitor,
} from 'lucide-react'
import { useAuth } from '../context/AuthContext'
import { useTheme } from '../context/ThemeContext'
import type { Theme } from '../context/ThemeContext'
import { getDataHealth } from '../api/client'

const nav = [
  { to: '/dashboard',   label: 'Net Worth',    icon: LayoutDashboard },
  { to: '/holdings',    label: 'Securities',   icon: Briefcase },
  { to: '/performance', label: 'Performance & Reports', icon: TrendingUp },
  { to: '/activity',    label: 'Activity',     icon: List },
  { to: '/scanner',     label: 'Research',     icon: ScanSearch },
  { to: '/data-health', label: 'Data Health',  icon: HeartPulse },
  { to: '/admin',       label: 'Admin',        icon: Settings },
]

const THEME_CYCLE: Record<Theme, Theme> = { light: 'dark', dark: 'system', system: 'light' }
const THEME_ICON = { light: Sun, dark: Moon, system: Monitor }
const THEME_LABEL: Record<Theme, string> = { light: 'Light', dark: 'Dark', system: 'System' }

export default function Sidebar() {
  const { user, logout } = useAuth()
  const { theme, setTheme } = useTheme()
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    return localStorage.getItem('sidebar-collapsed') === 'true'
  })
  const [searchParams] = useSearchParams()
  const search = searchParams.toString()

  // Badge: number of open data-health issues. Cached for a few minutes so the checks
  // (which scan positions/prices) don't run on every navigation.
  const { data: health } = useQuery({
    queryKey: ['data-health'],
    queryFn: getDataHealth,
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
  })
  const issueCount = health?.issue_count ?? 0

  const toggle = () => {
    setCollapsed(c => {
      const next = !c
      localStorage.setItem('sidebar-collapsed', String(next))
      return next
    })
  }

  const ThemeIcon = THEME_ICON[theme]

  return (
    <aside
      className={`${collapsed ? 'w-14' : 'w-56'} flex-shrink-0 transition-[width] duration-200 bg-card border-r border-border flex flex-col shadow-sm`}
    >
      {/* Header */}
      <div className={`flex items-center border-b border-border ${collapsed ? 'px-2 py-4 justify-center' : 'px-4 py-4'}`}>
        {!collapsed && (
          <div className="flex-1 min-w-0">
            <h1 className="text-lg font-bold text-primary leading-tight truncate">
              Portfolio Tracker
            </h1>
            <p className="text-xs text-muted-foreground mt-0.5">iTrade + IBKR</p>
          </div>
        )}
        <button
          onClick={toggle}
          title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          className="flex-shrink-0 p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
        >
          {collapsed
            ? <ChevronRight className="h-4 w-4" />
            : <ChevronLeft className="h-4 w-4" />}
        </button>
      </div>

      {/* Nav links */}
      <nav className={`flex-1 py-3 space-y-0.5 ${collapsed ? 'px-1' : 'px-2'}`}>
        {nav.map(({ to, label, icon: Icon }) => (
          <NavLink
            key={to}
            to={search ? `${to}?${search}` : to}
            title={collapsed ? label : undefined}
            className={({ isActive }) =>
              `relative flex items-center rounded-md text-sm font-medium transition-colors
               ${collapsed ? 'justify-center px-2 py-2.5' : 'gap-3 px-3 py-2.5'}
               ${isActive
                 ? 'bg-primary/10 text-primary'
                 : 'text-muted-foreground hover:bg-accent hover:text-foreground'
               }`
            }
          >
            <Icon className="h-4 w-4 flex-shrink-0" />
            {!collapsed && <span className="flex-1">{label}</span>}
            {to === '/data-health' && issueCount > 0 && (
              <span
                title={`${issueCount} data issue${issueCount > 1 ? 's' : ''}`}
                className={`flex-shrink-0 inline-flex items-center justify-center rounded-full bg-amber-500 text-white text-[10px] font-semibold ${
                  collapsed ? 'absolute top-1.5 right-1.5 h-2 w-2 p-0' : 'min-w-[18px] h-[18px] px-1'
                }`}
              >
                {collapsed ? '' : issueCount}
              </span>
            )}
          </NavLink>
        ))}
      </nav>

      {/* Theme + user + logout */}
      <div className={`border-t border-border ${collapsed ? 'px-1 py-3' : 'px-3 py-3'}`}>
        <button
          onClick={() => setTheme(THEME_CYCLE[theme])}
          title={`Theme: ${THEME_LABEL[theme]} (click to change)`}
          className={`flex items-center w-full rounded-md text-sm font-medium text-muted-foreground
            hover:bg-accent hover:text-foreground transition-colors mb-1
            ${collapsed ? 'justify-center px-2 py-2.5' : 'gap-3 px-2 py-2'}`}
        >
          <ThemeIcon className="h-4 w-4 flex-shrink-0" />
          {!collapsed && THEME_LABEL[theme]}
        </button>
        {!collapsed && user && (
          <p className="text-xs text-muted-foreground truncate px-1 mb-2" title={user.email}>
            {user.name}
            {user.role === 'admin' && (
              <span className="ml-1.5 text-[10px] font-medium text-primary bg-primary/10 px-1 py-0.5 rounded">
                admin
              </span>
            )}
          </p>
        )}
        <button
          onClick={logout}
          title="Sign out"
          className={`flex items-center w-full rounded-md text-sm font-medium text-muted-foreground
            hover:bg-destructive/10 hover:text-destructive transition-colors
            ${collapsed ? 'justify-center px-2 py-2.5' : 'gap-3 px-2 py-2'}`}
        >
          <LogOut className="h-4 w-4 flex-shrink-0" />
          {!collapsed && 'Sign out'}
        </button>
      </div>
    </aside>
  )
}
