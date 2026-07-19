import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { FilterProvider } from './context/FilterContext'
import { AuthProvider } from './context/AuthContext'
import { ClientProvider } from './context/ClientContext'
import { ThemeProvider } from './context/ThemeContext'
import App from './App'
import './index.css'
import { registerSW } from 'virtual:pwa-register'

// Auto-update the PWA: activate the new service worker and reload when a new
// deploy is detected, so home-screen installs never get stuck on a stale build.
registerSW({ immediate: true })

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      retry: 1,
    },
  },
})

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ThemeProvider>
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          <AuthProvider>
            <ClientProvider>
              <FilterProvider>
                <App />
              </FilterProvider>
            </ClientProvider>
          </AuthProvider>
        </BrowserRouter>
      </QueryClientProvider>
    </ThemeProvider>
  </React.StrictMode>,
)
