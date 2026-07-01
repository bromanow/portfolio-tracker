import { useEffect } from 'react'
import { useAuth } from '../context/AuthContext'
import { usePreference } from './usePreference'

const IDLE_MS = 10 * 60 * 1000   // 10 minutes

// Device-local session behaviour driven by a My Account preference: auto-logout after 10 min
// of no activity. (The "refresh prices on login" preference lives in Header.tsx instead — it
// drives the same refresh-prices button/mutation the header already shows, so it appears as
// that button spinning rather than a separate indicator.)
export function useSessionBehaviors() {
  const { logout } = useAuth()
  const [idleEnabled] = usePreference('idleLogout')

  useEffect(() => {
    if (!idleEnabled) return
    let timer: ReturnType<typeof setTimeout>
    const reset = () => { clearTimeout(timer); timer = setTimeout(() => logout(), IDLE_MS) }
    const events = ['mousemove', 'mousedown', 'keydown', 'scroll', 'touchstart', 'click']
    events.forEach(e => window.addEventListener(e, reset, { passive: true }))
    reset()
    return () => { clearTimeout(timer); events.forEach(e => window.removeEventListener(e, reset)) }
  }, [idleEnabled, logout])
}
