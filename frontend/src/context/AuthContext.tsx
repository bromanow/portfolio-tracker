import { createContext, useContext, useState, useEffect, useCallback } from 'react'
import { useQueryClient } from '@tanstack/react-query'

export interface AuthUser {
  id: number
  email: string
  name: string
  role: string
  refresh_prices_on_login: boolean
}

interface AuthContextType {
  user: AuthUser | null
  isLoading: boolean
  login: (email: string, password: string) => Promise<void>
  logout: () => void
  /** Merge a patch into the current user locally — used after a preferences save so
   *  consumers (e.g. Header's login-refresh trigger) see the new value immediately
   *  without a full /auth/me round-trip. */
  updateUser: (patch: Partial<AuthUser>) => void
}

const AuthContext = createContext<AuthContextType | null>(null)

const API_BASE = import.meta.env.VITE_API_BASE_URL
  ? `${import.meta.env.VITE_API_BASE_URL}/api`
  : '/api'

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const queryClient = useQueryClient()
  const [user, setUser]       = useState<AuthUser | null>(null)
  const [isLoading, setIsLoading] = useState(true)

  // On mount, ask the backend whether the session cookie (if any) is still valid.
  useEffect(() => {
    fetch(`${API_BASE}/auth/me`, { credentials: 'include' })
      .then(r => (r.ok ? r.json() : Promise.reject()))
      .then((u: AuthUser) => setUser(u))
      .catch(() => setUser(null))
      .finally(() => setIsLoading(false))
  }, [])

  const login = useCallback(async (email: string, password: string) => {
    const r = await fetch(`${API_BASE}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      credentials: 'include',
      body: JSON.stringify({ email, password }),
    })
    if (!r.ok) {
      const err = await r.json().catch(() => ({}))
      throw new Error(err.detail ?? 'Login failed')
    }
    const data = await r.json()
    setUser(data.user)
  }, [])

  const logout = useCallback(() => {
    // Clears the session cookie server-side and stops IBeam if ibeam-control is deployed
    // (see ibeam-control/README.md). Fire-and-forget: local logout must succeed regardless.
    fetch(`${API_BASE}/auth/logout`, { method: 'POST', credentials: 'include' })
      .catch(() => { /* best-effort */ })
    setUser(null)
    queryClient.clear()   // wipe all cached data so next login gets a fresh fetch
  }, [queryClient])

  const updateUser = useCallback((patch: Partial<AuthUser>) => {
    setUser(u => (u ? { ...u, ...patch } : u))
  }, [])

  return (
    <AuthContext.Provider value={{ user, isLoading, login, logout, updateUser }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth(): AuthContextType {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>')
  return ctx
}
