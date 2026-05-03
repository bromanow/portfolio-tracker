import { Routes, Route, Navigate } from 'react-router-dom'
import { useAuth } from './context/AuthContext'
import Layout from './components/Layout'
import Login from './pages/Login'
import Dashboard from './pages/Dashboard'
import Holdings from './pages/Holdings'
import Performance from './pages/Performance'
import Import from './pages/Import'
import Transactions from './pages/Transactions'
import Options from './pages/Options'
import Prices from './pages/Prices'
import Admin from './pages/Admin'
import Reports from './pages/Reports'

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

function AdminRoute({ children }: { children: React.ReactNode }) {
  const { user } = useAuth()
  if (user?.role !== 'admin') return <Navigate to="/dashboard" replace />
  return <>{children}</>
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
        <Route path="performance"  element={<Performance />} />
        <Route path="import"       element={<Import />} />
        <Route path="transactions" element={<Transactions />} />
        <Route path="options"      element={<Options />} />
        <Route path="prices"       element={<Prices />} />
        <Route path="admin"        element={<AdminRoute><Admin /></AdminRoute>} />
        <Route path="reports"      element={<Reports />} />
      </Route>

      {/* Catch-all */}
      <Route path="*" element={<Navigate to="/dashboard" replace />} />
    </Routes>
  )
}
