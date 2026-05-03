import { Routes, Route, Navigate } from 'react-router-dom'
import Layout from './components/Layout'
import Dashboard from './pages/Dashboard'
import Holdings from './pages/Holdings'
import Performance from './pages/Performance'
import Import from './pages/Import'
import Transactions from './pages/Transactions'
import Options from './pages/Options'
import Prices from './pages/Prices'
import Admin from './pages/Admin'
import Reports from './pages/Reports'

export default function App() {
  return (
    <Routes>
      <Route path="/" element={<Layout />}>
        <Route index element={<Navigate to="/dashboard" replace />} />
        <Route path="dashboard" element={<Dashboard />} />
        <Route path="holdings" element={<Holdings />} />
        <Route path="performance" element={<Performance />} />
        <Route path="import" element={<Import />} />
        <Route path="transactions" element={<Transactions />} />
        <Route path="options" element={<Options />} />
        <Route path="prices" element={<Prices />} />
        <Route path="admin" element={<Admin />} />
        <Route path="reports" element={<Reports />} />
      </Route>
    </Routes>
  )
}
