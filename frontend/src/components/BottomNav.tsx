import { NavLink } from 'react-router-dom'
import {
  LayoutDashboard,
  Briefcase,
  TrendingUp,
  List,
  ScanSearch,
  Settings,
} from 'lucide-react'
import { useAuth } from '../context/AuthContext'

const tabs = [
  { to: '/dashboard',   label: 'Net Worth',    icon: LayoutDashboard },
  { to: '/holdings',    label: 'Securities',   icon: Briefcase },
  { to: '/performance', label: 'Performance',  icon: TrendingUp },
  { to: '/activity',    label: 'Activity',     icon: List },
  { to: '/scanner',     label: 'Research',     icon: ScanSearch },
]

export default function BottomNav() {
  const { user } = useAuth()
  const isAdmin = user?.role === 'admin'

  return (
    <nav className="fixed bottom-0 left-0 right-0 z-50 bg-white border-t border-gray-200 flex items-stretch safe-area-inset-bottom">
      {tabs.map(({ to, label, icon: Icon }) => (
        <NavLink
          key={to}
          to={to}
          className={({ isActive }) =>
            `flex flex-col items-center justify-center flex-1 py-2 gap-0.5 text-[10px] font-medium transition-colors
             ${isActive ? 'text-blue-600' : 'text-gray-400'}`
          }
        >
          {({ isActive }) => (
            <>
              <Icon className={`h-5 w-5 ${isActive ? 'text-blue-600' : 'text-gray-400'}`} />
              <span>{label}</span>
            </>
          )}
        </NavLink>
      ))}

      {/* Admin gear — only shown to admin users */}
      {isAdmin && (
        <NavLink
          to="/admin"
          className={({ isActive }) =>
            `flex flex-col items-center justify-center flex-1 py-2 gap-0.5 text-[10px] font-medium transition-colors
             ${isActive ? 'text-blue-600' : 'text-gray-400'}`
          }
        >
          {({ isActive }) => (
            <>
              <Settings className={`h-5 w-5 ${isActive ? 'text-blue-600' : 'text-gray-400'}`} />
              <span>Admin</span>
            </>
          )}
        </NavLink>
      )}
    </nav>
  )
}
