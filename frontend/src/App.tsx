import { useEffect, useRef } from 'react'
import { Routes, Route, Navigate } from 'react-router-dom'
import { useAuth } from './context/AuthContext'
import { useFilterContext } from './context/FilterContext'
import Layout from './components/Layout'
import Login from './pages/Login'
import Dashboard from './pages/Dashboard'
import Holdings from './pages/Holdings'
import Performance from './pages/Performance'
import Activity from './pages/Activity'
import SecurityDetail from './pages/SecurityDetail'
import Research from './pages/Research'
import DataHealth from './pages/DataHealth'
import Admin from './pages/Admin'

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { user, isLoading } = useAuth()
  const { clearFilters } = useFilterContext()

  // FilterProvider is mounted once at the app root (main.tsx) above the auth-gated routes,
  // so its in-memory Brokerage/Account/Type filters otherwise survive a logout — and would
  // leak into the next login, possibly a different user. Reset them on the logged-in →
  // logged-out transition only (not on initial mount, when user starts null too).
  const wasLoggedIn = useRef(false)
  useEffect(() => {
    if (user) {
      wasLoggedIn.current = true
    } else if (wasLoggedIn.current) {
      clearFilters()
      wasLoggedIn.current = false
    }
  }, [user, clearFilters])

  if (isLoading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="text-muted-foreground text-sm">Loading…</div>
      </div>
    )
  }

  return user ? <>{children}</> : <Navigate to="/login" replace />
}


export default function App() {
  return (
    <Routes>
      {/* Public */}
      <Route path="/login" element={<Login />} />

      {/* Protected — everything under Layout requires auth */}
      <Route
        path="/"
        element={
          <ProtectedRoute>
            <Layout />
          </ProtectedRoute>
        }
      >
        <Route index element={<Navigate to="/dashboard" replace />} />
        <Route path="dashboard"    element={<Dashboard />} />
        <Route path="holdings"     element={<Holdings />} />
        <Route path="holdings/security/:securityId" element={<SecurityDetail />} />
        <Route path="performance"  element={<Performance />} />
        <Route path="activity"     element={<Activity />} />
        <Route path="scanner"      element={<Research />} />
        <Route path="prices"       element={<Navigate to="/admin?tab=prices" replace />} />
        <Route path="data-health"  element={<DataHealth />} />
        <Route path="admin"        element={<Admin />} />

        {/* Legacy redirects — keep old bookmarks working */}
        <Route path="import"       element={<Navigate to="/activity" replace />} />
        <Route path="transactions" element={<Navigate to="/activity" replace />} />
        <Route path="options"      element={<Navigate to="/holdings" replace />} />
        <Route path="reports"      element={<Navigate to="/performance" replace />} />
      </Route>

      {/* Catch-all */}
      <Route path="*" element={<Navigate to="/dashboard" replace />} />
    </Routes>
  )
}
