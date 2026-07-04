import { useEffect, useState } from 'react'

// Lightweight client-side user preferences (localStorage). These are device-local behaviours
// (idle auto-logout, refresh-on-login) so they don't need a server round-trip; a custom event
// keeps every reader in sync when one toggle changes.

export const PREF_KEYS = {
  idleLogout: 'pref-idle-logout',
  refreshOnLogin: 'pref-refresh-on-login',
  hideValues: 'pref-hide-values',
} as const

export type PrefKey = keyof typeof PREF_KEYS

export function getPref(key: PrefKey): boolean {
  return localStorage.getItem(PREF_KEYS[key]) === 'true'
}

export function setPref(key: PrefKey, value: boolean): void {
  localStorage.setItem(PREF_KEYS[key], String(value))
  window.dispatchEvent(new CustomEvent('pref-changed', { detail: key }))
}

export function usePreference(key: PrefKey): [boolean, (v: boolean) => void] {
  const [value, setValue] = useState(() => getPref(key))
  useEffect(() => {
    const onChange = () => setValue(getPref(key))
    window.addEventListener('pref-changed', onChange)
    return () => window.removeEventListener('pref-changed', onChange)
  }, [key])
  return [value, (v: boolean) => setPref(key, v)]
}
