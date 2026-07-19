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
} from 'lucide-react'
import { useAuth } from '../context/AuthContext'
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

export default function Sidebar() {
  const { user, logout } = useAuth()
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

  return (
    <aside
      className={`${collapsed ? 'w-14' : 'w-56'} flex-shrink-0 transition-[width] duration-200 bg-white border-r border-gray-200 flex flex-col shadow-sm`}
    >
      {/* Header */}
      <div className={`flex items-center border-b border-gray-200 ${collapsed ? 'px-2 py-4 justify-center' : 'px-4 py-4'}`}>
        {!collapsed && (
          <div className="flex-1 min-w-0">
            <h1 className="text-lg font-bold text-blue-700 leading-tight truncate">
              Portfolio Tracker
            </h1>
            <p className="text-xs text-gray-400 mt-0.5">iTrade + IBKR</p>
          </div>
        )}
        <button
          onClick={toggle}
          title={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          className="flex-shrink-0 p-1.5 rounded-md text-gray-400 hover:text-gray-600 hover:bg-gray-100 transition-colors"
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
                 ? 'bg-blue-50 text-blue-700'
                 : 'text-gray-600 hover:bg-gray-100 hover:text-gray-900'
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

      {/* User + logout */}
      <div className={`border-t border-gray-200 ${collapsed ? 'px-1 py-3' : 'px-3 py-3'}`}>
        {!collapsed && user && (
          <p className="text-xs text-gray-500 truncate px-1 mb-2" title={user.email}>
            {user.name}
            {user.role === 'admin' && (
              <span className="ml-1.5 text-[10px] font-medium text-blue-500 bg-blue-50 px-1 py-0.5 rounded">
                admin
              </span>
            )}
          </p>
        )}
        <button
          onClick={logout}
          title="Sign out"
          className={`flex items-center w-full rounded-md text-sm font-medium text-gray-500
            hover:bg-red-50 hover:text-red-600 transition-colors
            ${collapsed ? 'justify-center px-2 py-2.5' : 'gap-3 px-2 py-2'}`}
        >
          <LogOut className="h-4 w-4 flex-shrink-0" />
          {!collapsed && 'Sign out'}
        </button>
      </div>
    </aside>
  )
}
