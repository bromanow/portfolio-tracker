import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Loader2, RefreshCw } from 'lucide-react'
import { getIBeamStatus, startIBeam, restartIBeam, stopIBeam } from '../../api/client'

// ─── IBeam (Live Data) Tab ─────────────────────────────────────────────────────
export default function IBeamTab() {
  const qc = useQueryClient()
  const [msg, setMsg] = useState<string | null>(null)
  const { data, isLoading, refetch, isFetching } = useQuery({
    queryKey: ['ibeam-status'],
    queryFn: getIBeamStatus,
    refetchInterval: 10_000,
  })

  const withMsg = (label: string, fn: () => Promise<unknown>) => async () => {
    setMsg(`${label}…`)
    try {
      await fn()
      setMsg(`${label} sent.`)
    } catch {
      setMsg(`${label} failed.`)
    } finally {
      setTimeout(() => { refetch(); qc.invalidateQueries({ queryKey: ['ibeam-status'] }) }, 3000)
    }
  }
  const doStart = withMsg('Start', startIBeam)
  const doRestart = withMsg('Restart', restartIBeam)
  const doStop = withMsg('Stop', stopIBeam)

  const container = data?.container
  const containerBad = container?.error || (container && container.status !== 'running')

  return (
    <div className="space-y-4 max-w-2xl">
      <div>
        <h2 className="text-lg font-semibold text-gray-900">IBeam (Live Data)</h2>
        <p className="text-sm text-gray-500 mt-1">
          IBeam is the IBKR Client Portal gateway that powers live option bid/ask, greeks, and
          the covered-call scanner. It's a separate container from IBKR Flex (which imports
          historical transactions/statements) — this tab controls that gateway's lifecycle.
        </p>
      </div>

      {isLoading ? (
        <div className="flex items-center gap-2 text-gray-400 text-sm py-6"><Loader2 className="h-4 w-4 animate-spin" /> Checking…</div>
      ) : !data?.configured ? (
        <div className="bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 text-sm text-amber-800">
          Start/stop control isn't set up (<code className="bg-white px-1 rounded">IBEAM_CONTROL_URL</code> /
          <code className="bg-white px-1 rounded">IBEAM_CONTROL_TOKEN</code> not configured on the backend).
          IBeam runs continuously as it always has — see <code className="bg-white px-1 rounded">ibeam-control/README.md</code> to
          deploy the control service and enable start/stop here.
        </div>
      ) : (
        <>
          <div className="bg-white border border-gray-200 rounded-xl p-5 space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-4 text-sm">
                <span className="flex items-center gap-1.5">
                  <span className={`h-2 w-2 rounded-full ${containerBad ? 'bg-gray-300' : 'bg-emerald-500'}`} />
                  Container: <strong className="text-gray-800">{container?.error ? 'unreachable' : container?.status ?? '—'}</strong>
                </span>
                <span className="flex items-center gap-1.5">
                  <span className={`h-2 w-2 rounded-full ${data.authenticated ? 'bg-emerald-500' : 'bg-gray-300'}`} />
                  IBKR: <strong className="text-gray-800">{data.authenticated ? 'authenticated' : 'not authenticated'}</strong>
                </span>
              </div>
              <button onClick={() => refetch()} disabled={isFetching} className="text-gray-400 hover:text-gray-600">
                <RefreshCw className={`h-4 w-4 ${isFetching ? 'animate-spin' : ''}`} />
              </button>
            </div>
            {container?.error && (
              <p className="text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{container.error}</p>
            )}
            {msg && <p className="text-xs text-gray-600">{msg}</p>}
            <div className="flex items-center gap-2 pt-1">
              <button onClick={doStart} className="px-3 py-1.5 rounded-lg bg-blue-600 text-white text-sm font-medium hover:bg-blue-700">
                Start
              </button>
              <button onClick={doRestart} className="px-3 py-1.5 rounded-lg border border-gray-300 text-gray-700 text-sm font-medium hover:bg-gray-50"
                title="Force a full stop+start — use this if status shows the container running but IBKR not authenticated (a stuck/zombie state that Start alone won't fix)">
                Restart (reconnect)
              </button>
              <button onClick={doStop} className="px-3 py-1.5 rounded-lg border border-gray-300 text-gray-700 text-sm font-medium hover:bg-gray-50">
                Stop
              </button>
            </div>
          </div>
          <p className="text-xs text-gray-400">
            IBeam also starts automatically when anyone logs in, and stops on logout — this
            panel is for checking status and forcing a reconnect if IBKR's own session drops
            (e.g. during their maintenance windows).
          </p>
        </>
      )}
    </div>
  )
}
