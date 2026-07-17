import { createContext, useContext, useMemo, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { getConsolidatedPositions, getSecurities, getSecurity } from '../api/client'
import type { ConsolidatedPosition } from '../api/client'
import SecurityDetailPanel from '../components/SecurityDetailPanel'

interface SecurityCardContextValue {
  open: (securityId: number) => void
  /** Resolve a bare ticker string to a security_id via the cached ticker map, or null if
   *  it isn't a security this app tracks (e.g. a random IBKR scanner result). */
  resolveTicker: (ticker: string) => number | null
}

const SecurityCardContext = createContext<SecurityCardContextValue>({
  open: () => {},
  resolveTicker: () => null,
})

export function SecurityCardProvider({ children }: { children: React.ReactNode }) {
  const [openSecurityId, setOpenSecurityId] = useState<number | null>(null)

  // Ticker -> security_id map, built once from the full securities list (changes rarely).
  // Lets any page link a bare ticker string even when its own data has no security_id at all.
  const { data: allSecurities = [] } = useQuery({
    queryKey: ['securities', 'all'],
    queryFn: () => getSecurities(),
    staleTime: 15 * 60 * 1000,
  })
  const tickerMap = useMemo(() => {
    const m: Record<string, number> = {}
    for (const s of allSecurities) m[s.ticker] = s.id
    return m
  }, [allSecurities])

  // Currently-held positions (real data, no stub needed) — fetched lazily, only once a card
  // is actually opened.
  const { data: allPositionsForCard = [] } = useQuery({
    queryKey: ['consolidated-positions'],
    queryFn: () => getConsolidatedPositions({}),
    staleTime: 2 * 60 * 1000,
    enabled: openSecurityId !== null,
  })
  const heldPosition = (allPositionsForCard as ConsolidatedPosition[]).find(p => p.security_id === openSecurityId) || null

  // Securities no longer held (sold off, matured notes, etc.) fall back to a zeroed stub
  // built from a plain security lookup, so the card still opens usefully.
  const { data: fallbackSecurity } = useQuery({
    queryKey: ['security', openSecurityId],
    queryFn: () => getSecurity(openSecurityId!),
    enabled: openSecurityId !== null && !heldPosition,
  })
  const selectedPosition: ConsolidatedPosition | null = heldPosition || (fallbackSecurity ? {
    security_id: fallbackSecurity.id,
    ticker: fallbackSecurity.ticker,
    security_name: fallbackSecurity.name,
    asset_class: fallbackSecurity.asset_class,
    exchange: fallbackSecurity.exchange,
    currency: fallbackSecurity.currency || 'CAD',
    total_quantity: '0',
    total_acb_cad: '0',
    acb_per_share_cad: '0',
    account_count: 0,
    accounts: [],
  } : null)

  const value = useMemo<SecurityCardContextValue>(() => ({
    open: (securityId: number) => setOpenSecurityId(securityId),
    resolveTicker: (ticker: string) => tickerMap[ticker] ?? null,
  }), [tickerMap])

  return (
    <SecurityCardContext.Provider value={value}>
      {children}
      {selectedPosition && (
        <SecurityDetailPanel
          position={selectedPosition}
          allPositions={allPositionsForCard as ConsolidatedPosition[]}
          onClose={() => setOpenSecurityId(null)}
        />
      )}
    </SecurityCardContext.Provider>
  )
}

export const useSecurityCard = () => useContext(SecurityCardContext)
