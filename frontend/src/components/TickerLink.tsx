import { useSecurityCard } from '../context/SecurityCardContext'

/**
 * A ticker shown anywhere — opens the security detail card. Pass `securityId` when the
 * caller's data already has it; otherwise it's resolved from the shared ticker map (built
 * from the full securities list), which correctly renders as plain text for tickers this
 * app doesn't track (e.g. a random IBKR Market Scanner result).
 */
export default function TickerLink({ ticker, securityId, className }: {
  ticker: string
  securityId?: number | null
  className?: string
}) {
  const { open, resolveTicker } = useSecurityCard()
  const resolvedId = securityId ?? resolveTicker(ticker)

  if (!resolvedId) return <span className={className}>{ticker}</span>
  return (
    <button
      onClick={e => { e.stopPropagation(); open(resolvedId) }}
      className={`hover:underline hover:text-blue-800 ${className || ''}`}
    >
      {ticker}
    </button>
  )
}
