import { Routes, Route, Navigate } from 'react-router-dom'
import { useAuth } from './context/AuthContext'
import Layout from './components/Layout'
import Login from './pages/Login'
import Dashboard from './pages/Dashboard'
import Holdings from './pages/Holdings'
import Performance from './pages/Performance'
import Activity from './pages/Activity'
import SecurityDetail from './pages/SecurityDetail'
import Scanner from './pages/Scanner'
import Prices from './pages/Prices'
import DataHealth from './pages/DataHealth'
import Admin from './pages/Admin'

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { user, isLoading } = useAuth()

  if (isLoading) {
    return (
      <div className="min-h-screen bg-gray-50 flex items-center justify-center">
        <div className="text-gray-400 text-sm">Loading…</div>
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
        <Route path="scanner"      element={<Scanner />} />
        <Route path="prices"       element={<Prices />} />
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
