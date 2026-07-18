import { useState } from 'react'
import { Eye, EyeOff } from 'lucide-react'
import { useAuth } from '../../context/AuthContext'
import { usePreference } from '../../hooks/usePreference'
import { changePassword } from '../../api/client'

// ─── My Account Tab ──────────────────────────────────────────────────────────
function PrefToggle({ prefKey, label, hint }: { prefKey: Parameters<typeof usePreference>[0]; label: string; hint: string }) {
  const [on, setOn] = usePreference(prefKey)
  return (
    <label className="flex items-start gap-3 cursor-pointer">
      <button
        type="button"
        role="switch"
        aria-checked={on}
        onClick={() => setOn(!on)}
        className={`mt-0.5 relative inline-flex h-5 w-9 flex-shrink-0 items-center rounded-full transition-colors ${on ? 'bg-blue-600' : 'bg-gray-300'}`}
      >
        <span className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${on ? 'translate-x-4.5' : 'translate-x-1'}`} style={{ transform: on ? 'translateX(18px)' : 'translateX(3px)' }} />
      </button>
      <span>
        <span className="text-sm font-medium text-gray-800">{label}</span>
        <span className="block text-xs text-gray-500">{hint}</span>
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
      <div className="bg-white border border-gray-200 rounded-xl p-5 space-y-2">
        <h2 className="text-sm font-semibold text-gray-700 mb-3">Account Info</h2>
        <div className="flex justify-between text-sm">
          <span className="text-gray-500">Name</span>
          <span className="font-medium text-gray-900">{user?.name}</span>
        </div>
        <div className="flex justify-between text-sm">
          <span className="text-gray-500">Email</span>
          <span className="font-medium text-gray-900">{user?.email}</span>
        </div>
        <div className="flex justify-between text-sm">
          <span className="text-gray-500">Role</span>
          <span className="font-medium text-gray-900 capitalize">{user?.role}</span>
        </div>
      </div>

      {/* Preferences */}
      <div className="bg-white border border-gray-200 rounded-xl p-5 space-y-3">
        <h2 className="text-sm font-semibold text-gray-700">Preferences</h2>
        <PrefToggle prefKey="idleLogout"
          label="Log out after 10 minutes of inactivity"
          hint="Automatically signs you out if there's no mouse or keyboard activity." />
        <PrefToggle prefKey="refreshOnLogin"
          label="Refresh prices automatically on login"
          hint="Kicks off a market-price refresh once each time you sign in." />
      </div>

      {/* Change password */}
      <div className="bg-white border border-gray-200 rounded-xl p-5">
        <h2 className="text-sm font-semibold text-gray-700 mb-4">Change Password</h2>
        <form onSubmit={handleChangePassword} className="space-y-3">
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Current Password</label>
            <div className="relative">
              <input
                type={showCurrent ? 'text' : 'password'}
                value={pwCurrent}
                onChange={e => setPwCurrent(e.target.value)}
                required
                className="w-full border rounded px-3 py-2 text-sm pr-9 focus:outline-none focus:border-blue-400"
                placeholder="Enter current password"
              />
              <button type="button" onClick={() => setShowCurrent(v => !v)}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600">
                {showCurrent ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
              </button>
            </div>
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">New Password</label>
            <div className="relative">
              <input
                type={showNew ? 'text' : 'password'}
                value={pwNew}
                onChange={e => setPwNew(e.target.value)}
                required
                className="w-full border rounded px-3 py-2 text-sm pr-9 focus:outline-none focus:border-blue-400"
                placeholder="Min 8 characters"
              />
              <button type="button" onClick={() => setShowNew(v => !v)}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600">
                {showNew ? <EyeOff className="h-3.5 w-3.5" /> : <Eye className="h-3.5 w-3.5" />}
              </button>
            </div>
          </div>
          <div>
            <label className="block text-xs font-medium text-gray-600 mb-1">Confirm New Password</label>
            <input
              type="password"
              value={pwConfirm}
              onChange={e => setPwConfirm(e.target.value)}
              required
              className="w-full border rounded px-3 py-2 text-sm focus:outline-none focus:border-blue-400"
              placeholder="Repeat new password"
            />
          </div>
          {pwError   && <p className="text-xs text-red-600 bg-red-50 rounded px-3 py-2">{pwError}</p>}
          {pwSuccess && <p className="text-xs text-emerald-600 bg-emerald-50 rounded px-3 py-2">✓ Password changed successfully.</p>}
          <button
            type="submit"
            disabled={pwLoading}
            className="w-full py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 font-medium"
          >
            {pwLoading ? 'Saving…' : 'Change Password'}
          </button>
        </form>
      </div>
    </div>
  )
}
