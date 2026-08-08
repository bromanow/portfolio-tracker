import { useEffect } from 'react'
import { useAuth } from '../context/AuthContext'
import { useValuePreference } from './usePreference'

// Device-local session behaviour driven by a My Account preference: auto-logout after a
// user-chosen period of inactivity ('off' | '10' | '30' | '60' minutes). (The "refresh
// prices on login" preference lives in Header.tsx instead — it drives the same refresh-prices
// button/mutation the header already shows, so it appears as that button spinning rather than
// a separate indicator.)
export function useSessionBehaviors() {
  const { logout } = useAuth()
  const [idleMinutes] = useValuePreference('idleLogoutMinutes', 'off')

  useEffect(() => {
    const minutes = parseInt(idleMinutes, 10)
    if (!minutes || Number.isNaN(minutes)) return   // 'off' → no auto-logout
    const idleMs = minutes * 60 * 1000
    let timer: ReturnType<typeof setTimeout>
    const reset = () => { clearTimeout(timer); timer = setTimeout(() => logout(), idleMs) }
    const events = ['mousemove', 'mousedown', 'keydown', 'scroll', 'touchstart', 'click']
    events.forEach(e => window.addEventListener(e, reset, { passive: true }))
    reset()
    return () => { clearTimeout(timer); events.forEach(e => window.removeEventListener(e, reset)) }
  }, [idleMinutes, logout])
}
