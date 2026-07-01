import { useEffect, useRef, useState } from 'react'
import { useAuth } from '../context/AuthContext'
import { getPref, usePreference } from './usePreference'
import { refreshAllPrices, getPriceJob } from '../api/client'

const IDLE_MS = 10 * 60 * 1000   // 10 minutes

export type PriceRefreshStatus = 'idle' | 'running' | 'done' | 'error'

// Device-local session behaviours driven by user preferences (see My Account):
//   • idle auto-logout after 10 min of no activity
//   • automatic price refresh once per login (the endpoint kicks off a background job,
//     so we poll it and surface a status the caller can render as a toast — otherwise the
//     refresh happens silently and looks like "nothing happened").
export function useSessionBehaviors() {
  const { user, logout } = useAuth()
  const [idleEnabled] = usePreference('idleLogout')
  const [priceRefreshStatus, setPriceRefreshStatus] = useState<PriceRefreshStatus>('idle')

  useEffect(() => {
    if (!idleEnabled) return
    let timer: ReturnType<typeof setTimeout>
    const reset = () => { clearTimeout(timer); timer = setTimeout(() => logout(), IDLE_MS) }
    const events = ['mousemove', 'mousedown', 'keydown', 'scroll', 'touchstart', 'click']
    events.forEach(e => window.addEventListener(e, reset, { passive: true }))
    reset()
    return () => { clearTimeout(timer); events.forEach(e => window.removeEventListener(e, reset)) }
  }, [idleEnabled, logout])

  // Fires once per login (Layout — and this hook with it — unmounts on logout, so `fired`
  // naturally resets on the next login rather than needing a sessionStorage guard).
  const fired = useRef(false)
  useEffect(() => {
    if (!user || fired.current) return
    fired.current = true
    if (!getPref('refreshOnLogin')) return

    setPriceRefreshStatus('running')
    refreshAllPrices()
      .then(job => {
        const jobId = job.job_id ?? job.id
        if (!jobId) { setPriceRefreshStatus('done'); return }
        const poll = setInterval(async () => {
          try {
            const status = await getPriceJob(jobId)
            if (status.status === 'done' || status.status === 'error') {
              clearInterval(poll)
              setPriceRefreshStatus(status.status)
              setTimeout(() => setPriceRefreshStatus('idle'), 4000)
            }
          } catch {
            clearInterval(poll)
            setPriceRefreshStatus('error')
            setTimeout(() => setPriceRefreshStatus('idle'), 4000)
          }
        }, 2000)
      })
      .catch(() => {
        setPriceRefreshStatus('error')
        setTimeout(() => setPriceRefreshStatus('idle'), 4000)
      })
  }, [user])

  return { priceRefreshStatus }
}
