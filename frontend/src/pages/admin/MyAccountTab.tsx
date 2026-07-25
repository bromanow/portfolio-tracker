import { useState } from 'react'
import { Eye, EyeOff } from 'lucide-react'
import { useAuth } from '../../context/AuthContext'
import { usePreference } from '../../hooks/usePreference'
import { changePassword, updateMyPreferences } from '../../api/client'

// ─── My Account Tab ──────────────────────────────────────────────────────────
function ToggleSwitch({ on, onClick, disabled }: { on: boolean; onClick: () => void; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      disabled={disabled}
      onClick={onClick}
      className={`mt-0.5 relative inline-flex h-5 w-9 flex-shrink-0 items-center rounded-full transition-colors disabled:opacity-50 ${on ? 'bg-primary' : 'bg-muted-foreground/30'}`}
    >
      <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-card transition-transform`} style={{ transform: on ? 'translateX(18px)' : 'translateX(3px)' }} />
    </button>
  )
}

// A per-browser preference — stored only in this device's localStorage.
function PrefToggle({ prefKey, label, hint }: { prefKey: Parameters<typeof usePreference>[0]; label: string; hint: string }) {
  const [on, setOn] = usePreference(prefKey)
  return (
    <label className="flex items-start gap-3 cursor-pointer">
      <ToggleSwitch on={on} onClick={() => setOn(!on)} />
      <span>
        <span className="text-sm font-medium text-foreground">{label}</span>
        <span className="block text-xs text-muted-foreground">{hint}</span>
      </span>
    </label>
  )
}

// A per-account preference — persisted server-side (via updateUser), so it stays
// consistent across every browser/device signed into this account, unlike PrefToggle
// above (which silently resets per-browser with no visible warning).
function ServerPrefToggle({ field, label, hint }: {
  field: 'refresh_prices_on_login' | 'notify_covered_call_alerts'; label: string; hint: string
}) {
  const { user, updateUser } = useAuth()
  const [saving, setSaving] = useState(false)
  const on = user?.[field] ?? false

  const toggle = async () => {
    const next = !on
    setSaving(true)
    try {
      await updateMyPreferences({ [field]: next })
      updateUser({ [field]: next })
    } catch {
      // leave the switch as-is on failure — no optimistic flip happened yet
    } finally {
      setSaving(false)
    }
  }

  return (
    <label className="flex items-start gap-3 cursor-pointer">
      <ToggleSwitch on={on} onClick={toggle} disabled={saving} />
      <span>
        <span className="text-sm font-medium text-foreground">{label}</span>
        <span className="block text-xs text-muted-foreground">{hint}</span>
      </span>
    </label>
  )
}

export default function MyAccountTab() {
  const { user } = useAuth()
  const [pwCurrent, setPwCurrent] = useState('')
  const [pwNew,     setPwNew]     = useState('')
  const [pwConfirm, setPwConfirm] = useState('')
  const [pwLoading, setPwLoading] = useState(false)
  const [pwError,   setPwError]   = useState<string | null>(null)
  const [pwSuccess, setPwSuccess] = useState(false)
  const [showCurrent, setShowCurrent] = useState(false)
  const [showNew,     setShowNew]     = useState(false)

  const handleChangePassword = async (e: React.FormEvent) => {
    e.preventDefault()
    setPwError(null)
    setPwSuccess(false)
    if (pwNew.length < 8) { setPwError('New password must be at least 8 characters.'); return }
    if (pwNew !== pwConfirm) { setPwError('New passwords do not match.'); return }
    setPwLoading(true)
    try {
      await changePassword({ current_password: pwCurrent, new_password: pwNew })
      setPwSuccess(true)
      setPwCurrent(''); setPwNew(''); setPwConfirm('')
    } catch (err: any) {
      setPwError(err.response?.data?.detail ?? 'Password change failed.')
    } finally {
      setPwLoading(false)
    }
  }

  return (
    <div className="space-y-6 max-w-md">
      {/* User info */}
      <div className="bg-card border border-border rounded-xl p-5 space-y-2">
        <h2 className="text-sm font-semibold text-foreground mb-3">Account Info</h2>
        <div className="flex justify-between text-sm">
          <span className="text-muted-foreground">Name</span>
          <span className="font-medium text-foreground">{user?.name}</span>
        </div>
        <div className="flex justify-between text-sm">
          <span className="text-muted-foreground">Email</span>
          <span className="font-medium text-foreground">{user?.email}</span>
        </div>
        <div className="flex justify-between text-sm">
          <span className="text-muted-foreground">Role</span>
          <span className="font-medium text-foreground capitalize">{user?.role}</span>
        </div>
      </div>

      {/* Preferences */}
      <div className="bg-card border border-border rounded-xl p-5 space-y-3">
        <h2 className="text-sm font-semibold text-foreground">Preferences</h2>
        <PrefToggle prefKey="idleLogout"
          label="Log out after 10 minutes of inactivity"
          hint="Automatically signs you out if there's no mouse or keyboard activity." />
        <ServerPrefToggle field="refresh_prices_on_login"
          label="Refresh prices automatically on login"
          hint="Kicks off a market-price refresh once each time you sign in. Applies to this account on every device." />
        <ServerPrefToggle field="notify_covered_call_alerts"
          label="Email me covered-call alerts"
          hint="Daily digest when a sold call is within 7 days of expiry or has gone in-the-money (assignment risk)." />
      </div>

      {/* Change password */}
      <div className="bg-card border border-border rounded-xl p-5">
        <h2 className="text-sm font-semibold text-foreground mb-4">Change Password</h2>
        <form onSubmit={handleChangePassword} className="space-y-3">
          <div>
            <label className="block text-xs font-medium text-muted-foreground mb-1">Current Password</label>
            <div className="relative">
              <input
                type={showCurrent ? 'text' : 'password'}
                value={pwCurrent}
                onChange={e => setPwCurrent(e.target.value)}
                required
                className="bg-background text-foreground w-full border rounded px-3 py-2 text-sm pr-9 focus:outline-none focus:border-primary/40"
                placeholder="Enter current password"
              />
              <button type="button" onClick={() => setShowCurrent(v => !v)}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-muted-foreground">
                {showCurrent ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
              </button>
            </div>
          </div>
          <div>
            <label className="block text-xs font-medium text-muted-foreground mb-1">New Password</label>
            <div className="relative">
              <input
                type={showNew ? 'text' : 'password'}
                value={pwNew}
                onChange={e => setPwNew(e.target.value)}
                required
                className="bg-background text-foreground w-full border rounded px-3 py-2 text-sm pr-9 focus:outline-none focus:border-primary/40"
                placeholder="Min 8 characters"
              />
              <button type="button" onClick={() => setShowNew(v => !v)}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-muted-foreground">
                {showNew ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
              </button>
            </div>
          </div>
          <div>
            <label className="block text-xs font-medium text-muted-foreground mb-1">Confirm New Password</label>
            <input
              type="password"
              value={pwConfirm}
              onChange={e => setPwConfirm(e.target.value)}
              required
              className="bg-background text-foreground w-full border rounded px-3 py-2 text-sm focus:outline-none focus:border-primary/40"
              placeholder="Repeat new password"
            />
          </div>
          {pwError   && <p className="text-xs text-red-600 dark:text-red-400 bg-red-50 rounded px-3 py-2">{pwError}</p>}
          {pwSuccess && <p className="text-xs text-emerald-600 dark:text-emerald-400 bg-emerald-50 rounded px-3 py-2">✓ Password changed successfully.</p>}
          <button
            type="submit"
            disabled={pwLoading}
            className="w-full py-2 text-sm bg-primary text-white rounded-lg hover:bg-primary/90 disabled:opacity-50 font-medium"
          >
            {pwLoading ? 'Saving…' : 'Change Password'}
          </button>
        </form>
      </div>
    </div>
  )
}
