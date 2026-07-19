import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { UserPlus, ShieldCheck, ShieldOff, KeyRound, Pencil } from 'lucide-react'
import { getClients, getUsers, createUser, updateUser, resetUserPassword } from '../../api/client'

// ─── Users Tab ───────────────────────────────────────────────────────────────
export default function UsersTab() {
  const qc = useQueryClient()
  const { data: users = [] } = useQuery({ queryKey: ['users'], queryFn: getUsers })
  const { data: clients = [] } = useQuery({ queryKey: ['clients', 'admin'], queryFn: () => getClients(true) })

  const [showCreate, setShowCreate] = useState(false)
  const [newEmail, setNewEmail]     = useState('')
  const [newName,  setNewName]      = useState('')
  const [newPass,  setNewPass]      = useState('')
  const [newRole,  setNewRole]      = useState('user')
  const [newClients, setNewClients] = useState<number[]>([])
  const [createErr, setCreateErr]   = useState<string | null>(null)

  // Reset password state
  const [resetUserId, setResetUserId] = useState<number | null>(null)
  const [resetPass,   setResetPass]   = useState('')
  const [resetErr,    setResetErr]    = useState<string | null>(null)

  // Edit client access state
  const [editUserId,      setEditUserId]      = useState<number | null>(null)
  const [editClientIds,   setEditClientIds]   = useState<number[]>([])

  const createMut = useMutation({
    mutationFn: createUser,
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['users'] })
      setShowCreate(false)
      setNewEmail(''); setNewName(''); setNewPass(''); setNewRole('user'); setNewClients([])
      setCreateErr(null)
    },
    onError: (e: any) => setCreateErr(e.response?.data?.detail ?? 'Failed to create user'),
  })

  const toggleActiveMut = useMutation({
    mutationFn: ({ id, is_active }: { id: number; is_active: boolean }) =>
      updateUser(id, { is_active }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['users'] }),
  })

  const resetMut = useMutation({
    mutationFn: ({ id, pw }: { id: number; pw: string }) => resetUserPassword(id, pw),
    onSuccess: () => { setResetUserId(null); setResetPass(''); setResetErr(null) },
    onError: (e: any) => setResetErr(e.response?.data?.detail ?? 'Reset failed'),
  })

  const updateClientsMut = useMutation({
    mutationFn: ({ id, client_ids }: { id: number; client_ids: number[] }) =>
      updateUser(id, { client_ids }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['users'] }); setEditUserId(null) },
  })

  const toggleClientId = (arr: number[], id: number) =>
    arr.includes(id) ? arr.filter(x => x !== id) : [...arr, id]

  return (
    <div className="space-y-6 max-w-3xl">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-base font-semibold text-foreground">User Management</h2>
          <p className="text-xs text-muted-foreground mt-0.5">Create users and control which clients they can access.</p>
        </div>
        <button
          onClick={() => { setShowCreate(true); setCreateErr(null) }}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs bg-primary text-white rounded-lg hover:bg-primary/90 font-medium"
        >
          <UserPlus className="h-3.5 w-3.5" />
          New User
        </button>
      </div>

      {/* Create form */}
      {showCreate && (
        <div className="border border-primary/20 bg-primary/10 rounded-xl p-4 space-y-3">
          <h3 className="text-sm font-semibold text-foreground">Create New User</h3>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-muted-foreground mb-1">Name</label>
              <input value={newName} onChange={e => setNewName(e.target.value)}
                className="bg-background text-foreground w-full border rounded px-2.5 py-1.5 text-sm focus:outline-none focus:border-primary/40"
                placeholder="Full Name" />
            </div>
            <div>
              <label className="block text-xs font-medium text-muted-foreground mb-1">Email</label>
              <input value={newEmail} onChange={e => setNewEmail(e.target.value)}
                className="bg-background text-foreground w-full border rounded px-2.5 py-1.5 text-sm focus:outline-none focus:border-primary/40"
                placeholder="email@example.com" type="email" />
            </div>
            <div>
              <label className="block text-xs font-medium text-muted-foreground mb-1">Password</label>
              <input value={newPass} onChange={e => setNewPass(e.target.value)}
                className="bg-background text-foreground w-full border rounded px-2.5 py-1.5 text-sm focus:outline-none focus:border-primary/40"
                placeholder="Min 8 characters" type="password" />
            </div>
            <div>
              <label className="block text-xs font-medium text-muted-foreground mb-1">Role</label>
              <select value={newRole} onChange={e => setNewRole(e.target.value)}
                className="w-full border rounded px-2.5 py-1.5 text-sm focus:outline-none focus:border-primary/40 bg-card"
              >
                <option value="user">User</option>
                <option value="admin">Admin</option>
              </select>
            </div>
          </div>
          {newRole !== 'admin' && clients.length > 0 && (
            <div>
              <label className="block text-xs font-medium text-muted-foreground mb-1">Client Access</label>
              <div className="flex flex-wrap gap-2">
                {clients.map(c => (
                  <label key={c.id} className="flex items-center gap-1.5 text-xs cursor-pointer">
                    <input
                      type="checkbox"
                      checked={newClients.includes(c.id)}
                      onChange={() => setNewClients(prev => toggleClientId(prev, c.id))}
                      className="bg-background text-foreground rounded"
                    />
                    {c.name}
                  </label>
                ))}
              </div>
            </div>
          )}
          {createErr && <p className="text-xs text-red-600 dark:text-red-400">{createErr}</p>}
          <div className="flex gap-2 pt-1">
            <button
              onClick={() => createMut.mutate({ email: newEmail, name: newName, password: newPass, role: newRole, client_ids: newClients })}
              disabled={createMut.isPending}
              className="px-3 py-1.5 text-xs bg-primary text-white rounded hover:bg-primary/90 disabled:opacity-50 font-medium"
            >
              {createMut.isPending ? 'Creating…' : 'Create User'}
            </button>
            <button onClick={() => setShowCreate(false)} className="px-3 py-1.5 text-xs text-muted-foreground hover:text-foreground">
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* User list */}
      <div className="border border-border rounded-xl overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-muted/50 text-xs text-muted-foreground uppercase">
            <tr>
              <th className="text-left px-4 py-2.5 font-medium">Name / Email</th>
              <th className="text-left px-4 py-2.5 font-medium">Role</th>
              <th className="text-left px-4 py-2.5 font-medium">Clients</th>
              <th className="text-left px-4 py-2.5 font-medium">Last Login</th>
              <th className="text-right px-4 py-2.5 font-medium">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {users.map(u => (
              <tr key={u.id} className={u.is_active ? '' : 'opacity-50'}>
                <td className="px-4 py-3">
                  <div className="font-medium text-foreground">{u.name}</div>
                  <div className="text-xs text-muted-foreground">{u.email}</div>
                </td>
                <td className="px-4 py-3">
                  {u.role === 'admin'
                    ? <span className="inline-flex items-center gap-1 text-xs font-medium text-primary bg-primary/10 px-2 py-0.5 rounded-full">
                        <ShieldCheck className="h-3 w-3" /> admin
                      </span>
                    : <span className="text-xs text-muted-foreground">user</span>
                  }
                </td>
                <td className="px-4 py-3">
                  {u.role === 'admin' ? (
                    <span className="text-xs text-muted-foreground italic">all</span>
                  ) : editUserId === u.id ? (
                    <div className="flex flex-col gap-2">
                      <div className="flex flex-wrap gap-2">
                        {clients.map(c => (
                          <label key={c.id} className="flex items-center gap-1 text-xs cursor-pointer">
                            <input
                              type="checkbox"
                              checked={editClientIds.includes(c.id)}
                              onChange={() => setEditClientIds(prev => toggleClientId(prev, c.id))}
                              className="bg-background text-foreground rounded"
                            />
                            {c.name.split(' ')[0]}
                          </label>
                        ))}
                      </div>
                      <div className="flex gap-2">
                        <button
                          onClick={() => updateClientsMut.mutate({ id: u.id, client_ids: editClientIds })}
                          className="text-xs text-primary hover:text-primary font-medium"
                        >Save</button>
                        <button onClick={() => setEditUserId(null)} className="text-xs text-muted-foreground">Cancel</button>
                      </div>
                    </div>
                  ) : (
                    <button
                      onClick={() => { setEditUserId(u.id); setEditClientIds(u.client_ids) }}
                      className="text-xs text-muted-foreground hover:text-primary flex items-center gap-1"
                    >
                      {u.client_ids.length === 0
                        ? <span className="text-muted-foreground italic">None — click to set</span>
                        : clients.filter(c => u.client_ids.includes(c.id)).map(c => c.name.split(' ')[0]).join(', ')
                      }
                      <Pencil className="h-3 w-3 opacity-50" />
                    </button>
                  )}
                </td>
                <td className="px-4 py-3 text-xs text-muted-foreground">
                  {u.last_login ? new Date(u.last_login).toLocaleDateString() : '—'}
                </td>
                <td className="px-4 py-3 text-right">
                  <div className="flex items-center gap-2 justify-end">
                    {/* Reset password */}
                    {resetUserId === u.id ? (
                      <div className="flex items-center gap-1.5">
                        <input
                          type="password"
                          value={resetPass}
                          onChange={e => setResetPass(e.target.value)}
                          placeholder="New password"
                          className="bg-background text-foreground border rounded px-2 py-1 text-xs w-32 focus:outline-none focus:border-primary/40"
                        />
                        <button
                          onClick={() => resetMut.mutate({ id: u.id, pw: resetPass })}
                          disabled={resetPass.length < 8 || resetMut.isPending}
                          className="text-xs text-primary hover:text-primary font-medium disabled:opacity-40"
                        >Set</button>
                        <button onClick={() => { setResetUserId(null); setResetPass(''); setResetErr(null) }}
                          className="text-xs text-muted-foreground">✕</button>
                        {resetErr && <span className="text-xs text-red-600 dark:text-red-400">{resetErr}</span>}
                      </div>
                    ) : (
                      <button
                        onClick={() => { setResetUserId(u.id); setResetPass('') }}
                        title="Reset password"
                        className="p-1 text-muted-foreground hover:text-primary"
                      >
                        <KeyRound className="h-3.5 w-3.5" />
                      </button>
                    )}
                    {/* Toggle active */}
                    <button
                      onClick={() => toggleActiveMut.mutate({ id: u.id, is_active: !u.is_active })}
                      title={u.is_active ? 'Deactivate user' : 'Activate user'}
                      className={`p-1 ${u.is_active ? 'text-muted-foreground hover:text-red-500 dark:text-red-400' : 'text-muted-foreground hover:text-emerald-600 dark:text-emerald-400'}`}
                    >
                      {u.is_active ? <ShieldOff className="h-3.5 w-3.5" /> : <ShieldCheck className="h-3.5 w-3.5" />}
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
