import { Outlet } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { AlertTriangle, RefreshCw } from 'lucide-react'
import Sidebar from './Sidebar'
import BottomNav from './BottomNav'
import QuickAddFAB from './QuickAddFAB'
import Header from './Header'
import api from '../api/client'

function useBackendHealth() {
  return useQuery({
    queryKey: ['health'],
    queryFn: () => api.get('/health').then(r => r.data),
    refetchInterval: 15_000,
    refetchIntervalInBackground: true,
    retry: 1,
    retryDelay: 2_000,
  })
}

export default function Layout() {
  const { isError, isFetching, refetch } = useBackendHealth()

  return (
    <div className="flex h-screen bg-gray-50">
      {/* Desktop sidebar — hidden on mobile */}
      <div className="hidden md:flex">
        <Sidebar />
      </div>

      <div className="flex flex-col flex-1 min-w-0 overflow-hidden">
        <Header />
        {isError && (
          <div className="flex items-center gap-3 bg-red-600 text-white text-sm px-5 py-2.5">
            <AlertTriangle className="h-4 w-4 shrink-0" />
            <span className="font-medium">Backend server is not responding.</span>
            <span className="text-red-200">Data cannot be loaded until the server restarts.</span>
            <button
              onClick={() => refetch()}
              disabled={isFetching}
              className="ml-auto flex items-center gap-1.5 bg-red-700 hover:bg-red-800 disabled:opacity-50 rounded px-3 py-1 text-xs font-medium"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${isFetching ? 'animate-spin' : ''}`} />
              {isFetching ? 'Checking…' : 'Retry'}
            </button>
          </div>
        )}
        {/* Bottom padding on mobile so content clears the tab bar */}
        <main className="flex-1 overflow-auto pb-safe">
          <div className="p-4 md:p-6 pb-20 md:pb-6">
            <Outlet />
          </div>
        </main>
      </div>

      {/* Mobile bottom nav — hidden on desktop */}
      <div className="md:hidden">
        <BottomNav />
      </div>

      {/* Floating action button — mobile only */}
      <QuickAddFAB />
    </div>
  )
}
