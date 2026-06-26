import { useEffect, useRef } from 'react'
import { useAuth } from '../context/AuthContext'
import { getPref, usePreference } from './usePreference'
import { refreshAllPrices } from '../api/client'

const IDLE_MS = 10 * 60 * 1000   // 10 minutes

// Device-local session behaviours driven by user preferences (see My Account):
//   • idle auto-logout after 10 min of no activity
//   • automatic price refresh once per session on login
export function useSessionBehaviors() {
  const { user, logout } = useAuth()
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

  const fired = useRef(false)
  useEffect(() => {
    if (!user || fired.current) return
    fired.current = true
    if (sessionStorage.getItem('did-login-refresh')) return   // already done this browser session
    if (!getPref('refreshOnLogin')) return
    sessionStorage.setItem('did-login-refresh', '1')
    refreshAllPrices().catch(() => { /* best-effort */ })
  }, [user])
}
