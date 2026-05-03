import { useState } from 'react'
import { NavLink, useSearchParams } from 'react-router-dom'
import {
  LayoutDashboard,
  Upload,
  List,
  Settings,
  BarChart2,
  Layers,
  DollarSign,
  Briefcase,
  TrendingUp,
  ChevronLeft,
  ChevronRight,
  LogOut,
  Users,
} from 'lucide-react'
import { useAuth } from '../context/AuthContext'
import { useClientContext } from '../context/ClientContext'

const nav = [
  { to: '/dashboard',    label: 'Dashboard',    icon: LayoutDashboard },
  { to: '/holdings',     label: 'Holdings',     icon: Briefcase },
  { to: '/performance',  label: 'Performance',  icon: TrendingUp },
  { to: '/options',      label: 'Options',      icon: Layers },
  { to: '/transactions', label: 'Transactions', icon: List },
  { to: '/prices',       label: 'Prices',       icon: DollarSign },
  { to: '/import',       label: 'Import',       icon: Upload },
  { to: '/reports',      label: 'Reports',      icon: BarChart2 },
]

const adminNav = { to: '/admin', label: 'Admin', icon: Settings }

export default function Sidebar() {
  const { user, logout } = useAuth()
  const { clients, selectedClientId, setSelectedClientId } = useClientContext()
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    return localStorage.getItem('sidebar-collapsed') === 'true'
  })
  const [searchParams] = useSearchParams()
  const search = searchParams.toString()

  const isAdmin = user?.role === 'admin'
  const visibleNav = isAdmin ? [...nav, adminNav] : nav

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

      {/* Client selector — only when multiple clients available */}
      {clients.length > 1 && (
        <div className={`border-b border-gray-100 ${collapsed ? 'px-1 py-2' : 'px-3 py-2'}`}>
          {collapsed ? (
            /* Collapsed: show just an icon */
            <div className="flex justify-center" title="Client filter active">
              <Users className={`h-4 w-4 ${selectedClientId !== null ? 'text-blue-600' : 'text-gray-400'}`} />
            </div>
          ) : (
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-wide text-gray-400 mb-1.5 px-0.5">
                Client
              </p>
              <div className="flex flex-wrap gap-1">
                <button
                  onClick={() => setSelectedClientId(null)}
                  className={`px-2 py-0.5 rounded text-xs font-medium transition-colors ${
                    selectedClientId === null
                      ? 'bg-blue-600 text-white'
                      : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                  }`}
                >
                  All
                </button>
                {clients.map(c => (
                  <button
                    key={c.id}
                    onClick={() => setSelectedClientId(c.id)}
                    title={c.name}
                    className={`px-2 py-0.5 rounded text-xs font-medium transition-colors truncate max-w-[80px] ${
                      selectedClientId === c.id
                        ? 'bg-blue-600 text-white'
                        : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                    }`}
                  >
                    {c.name.split(' ')[0]}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* Nav links */}
      <nav className={`flex-1 py-3 space-y-0.5 ${collapsed ? 'px-1' : 'px-2'}`}>
        {visibleNav.map(({ to, label, icon: Icon }) => (
          <NavLink
            key={to}
            to={search ? `${to}?${search}` : to}
            title={collapsed ? label : undefined}
            className={({ isActive }) =>
              `flex items-center rounded-md text-sm font-medium transition-colors
               ${collapsed ? 'justify-center px-2 py-2.5' : 'gap-3 px-3 py-2.5'}
               ${isActive
                 ? 'bg-blue-50 text-blue-700'
                 : 'text-gray-600 hover:bg-gray-100 hover:text-gray-900'
               }`
            }
          >
            <Icon className="h-4 w-4 flex-shrink-0" />
            {!collapsed && label}
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
