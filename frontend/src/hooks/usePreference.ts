import { useEffect, useState } from 'react'

// Lightweight client-side user preferences (localStorage). These are genuinely device-local
// behaviours (idle auto-logout, hide-values display toggle) so they don't need a server
// round-trip; a custom event keeps every reader in sync when one toggle changes.
// ("Refresh prices on login" used to live here too, but a purely per-browser setting silently
// resets/desyncs across devices with no visible warning — it's now tied to the account via
// user.refresh_prices_on_login / PATCH /auth/me/preferences instead, see MyAccountTab.tsx's
// ServerPrefToggle and Header.tsx's login-refresh effect.)

export const PREF_KEYS = {
  idleLogout: 'pref-idle-logout',
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

// ── String-valued preferences (same localStorage + sync mechanism) ──────────────
export const VALUE_PREF_KEYS = {
  // Idle auto-logout duration: 'off' | '10' | '30' | '60' (minutes). Migrated from the old
  // boolean `idleLogout` pref: if that was on and no duration was ever chosen, default to 10.
  idleLogoutMinutes: 'pref-idle-logout-minutes',
} as const

export type ValuePrefKey = keyof typeof VALUE_PREF_KEYS

export function getValuePref(key: ValuePrefKey, fallback: string): string {
  const v = localStorage.getItem(VALUE_PREF_KEYS[key])
  if (v !== null) return v
  // one-time migration from the legacy boolean idle-logout toggle
  if (key === 'idleLogoutMinutes' && localStorage.getItem(PREF_KEYS.idleLogout) === 'true') return '10'
  return fallback
}

export function setValuePref(key: ValuePrefKey, value: string): void {
  localStorage.setItem(VALUE_PREF_KEYS[key], value)
  window.dispatchEvent(new CustomEvent('pref-changed', { detail: key }))
}

export function useValuePreference(key: ValuePrefKey, fallback: string): [string, (v: string) => void] {
  const [value, setValue] = useState(() => getValuePref(key, fallback))
  useEffect(() => {
    const onChange = () => setValue(getValuePref(key, fallback))
    window.addEventListener('pref-changed', onChange)
    return () => window.removeEventListener('pref-changed', onChange)
  }, [key, fallback])
  return [value, (v: string) => setValuePref(key, v)]
}
