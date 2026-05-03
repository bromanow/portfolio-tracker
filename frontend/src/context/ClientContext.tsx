import { createContext, useContext, useState, useCallback, useEffect } from 'react'
import { useQuery } from '@tanstack/react-query'
import { getClients } from '../api/client'
import type { Client } from '../api/client'

interface ClientContextValue {
  clients: Client[]
  selectedClientId: number | null   // null = "All clients"
  setSelectedClientId: (id: number | null) => void
  isLoading: boolean
}

const ClientContext = createContext<ClientContextValue>({
  clients: [],
  selectedClientId: null,
  setSelectedClientId: () => {},
  isLoading: false,
})

const STORAGE_KEY = 'pt_selected_client'

export function ClientProvider({ children }: { children: React.ReactNode }) {
  const isAuthenticated = !!localStorage.getItem('pt_auth_token')

  const { data: clients = [], isLoading } = useQuery({
    queryKey: ['clients'],
    queryFn: getClients,
    staleTime: 60_000,
    enabled: isAuthenticated,
  })

  const [selectedClientId, setSelectedClientIdRaw] = useState<number | null>(() => {
    // Clear any stale client selection — client scoping is now handled by the backend
    localStorage.removeItem(STORAGE_KEY)
    return null
  })

  // When clients load, if only one client is accessible (non-admin user), auto-select it
  useEffect(() => {
    if (clients.length === 1 && selectedClientId === null) {
      setSelectedClientIdRaw(clients[0].id)
      localStorage.setItem(STORAGE_KEY, String(clients[0].id))
    }
  }, [clients])

  const setSelectedClientId = useCallback((id: number | null) => {
    setSelectedClientIdRaw(id)
    if (id === null) {
      localStorage.removeItem(STORAGE_KEY)
    } else {
      localStorage.setItem(STORAGE_KEY, String(id))
    }
  }, [])

  return (
    <ClientContext.Provider value={{ clients, selectedClientId, setSelectedClientId, isLoading }}>
      {children}
    </ClientContext.Provider>
  )
}

export const useClientContext = () => useContext(ClientContext)
