import { useEffect, useState } from 'react'
import { TooltipButton } from '@/components/Tooltip'
import { Spinner } from '@/components/icons'
import { confirmSettingsAccess } from '@/features/machines/settingsAccess'
import { machineLabel, useRemoteLanesStore } from '@/stores/remoteLanes'
import { useSessionsStore } from '@/stores/sessions'
import { errorText } from '@shared/errors'
import type { MachineAccount } from '@shared/machine-settings'

/** Signed-in Host accounts other than the one the lane bills now. */
function targets(accounts: MachineAccount[], laneId: string): MachineAccount[] {
  return accounts.filter((a) => a.loggedIn === true && !a.lanes.some((l) => l.id === laneId))
}

/**
 * The Host lane's counterpart of the local account switcher. The Host does the
 * move (`claude.account`: stop, rebind, resume under the lane's fence), so this
 * needs lane control plus the Host's configuration grant, the same authority
 * Machines → Host → Settings asks for. Accounts are read only when the picker opens.
 */
export function HostAccountRouting({
  sessionId,
  onMoved,
}: {
  sessionId: string
  onMoved: () => void
}): React.JSX.Element | null {
  const live = useSessionsStore((s) => s.live[sessionId])
  const hostId = live?.target?.kind === 'remote' ? live.target.hostId : undefined
  const laneId = live?.laneId
  const host = useRemoteLanesStore((s) => (hostId ? s.hosts[hostId] : undefined))
  const [picking, setPicking] = useState(false)
  const [list, setList] = useState<MachineAccount[] | null>(null)
  const [moving, setMoving] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const ready = host?.state === 'ready'
  const configurable = ready && host.capabilities.includes('machine.configure')
  const held =
    ready &&
    host.capabilities.includes('sessions.control') &&
    host.lanes.find((l) => l.laneId === laneId)?.control.controller?.self === true

  // Loads once the grant is there, including when it arrives after the access prompt.
  useEffect(() => {
    if (!picking || !configurable || list !== null || !hostId) return
    let cancelled = false
    window.phosphor
      .invoke('hosts:settingsRead', hostId, 'providers')
      .then((data) => {
        if (!cancelled) setList(data.providers?.accounts ?? [])
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(errorText(e))
      })
    return () => {
      cancelled = true
    }
  }, [picking, configurable, list, hostId])

  if (!hostId || !laneId || host?.configurationSupported !== true) return null
  const label = machineLabel(hostId)

  const open = async (): Promise<void> => {
    setError(null)
    if (picking) return setPicking(false)
    if (!configurable) {
      if (!(await confirmSettingsAccess(label))) return
      try {
        await window.phosphor.invoke('hosts:settingsAccess', hostId)
      } catch (e) {
        return setError(errorText(e))
      }
    }
    setList(null)
    setPicking(true)
  }

  const move = async (accountId: string): Promise<void> => {
    setMoving(accountId)
    setError(null)
    try {
      await window.phosphor.invoke('hosts:claudeAccount', hostId, laneId, accountId)
      setPicking(false)
      onMoved()
    } catch (e) {
      setError(errorText(e))
    } finally {
      setMoving(null)
    }
  }

  const options = list ? targets(list, laneId) : null
  return (
    <div className="mt-1.5 text-sm">
      <div className="flex items-start justify-between gap-2">
        <span className="text-text-tertiary flex-1 leading-snug">
          {held
            ? `Move this lane to another Claude account on ${label}.`
            : 'Take control of this lane to move it to another account.'}
        </span>
        <TooltipButton
          onClick={() => void open()}
          disabled={!held}
          className="text-accent shrink-0 hover:underline disabled:opacity-50"
          aria-expanded={picking}
        >
          {picking ? 'Cancel' : 'Switch account'}
        </TooltipButton>
      </div>
      {error && <div className="text-danger mt-1 leading-snug">{error}</div>}
      {picking && (
        <div className="border-border/60 mt-1.5 space-y-0.5 rounded-md border p-1">
          {options === null ? (
            <div className="text-text-tertiary flex items-center gap-1.5 px-1 py-0.5">
              <Spinner className="text-text-tertiary" /> Reading accounts on {label}…
            </div>
          ) : options.length === 0 ? (
            <div className="text-text-tertiary px-1 py-0.5">
              No other signed-in Claude account on {label}.
            </div>
          ) : (
            <>
              {options.map((target) => (
                <TooltipButton
                  key={target.id}
                  disabled={moving !== null}
                  onClick={() => void move(target.id)}
                  className="hover:bg-bg-secondary flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-left transition-colors disabled:opacity-50"
                >
                  <span className="flex h-3.5 w-3.5 shrink-0 items-center justify-center">
                    {moving === target.id && <Spinner className="text-accent" />}
                  </span>
                  <span className="text-text flex-1 truncate">{target.email ?? target.label}</span>
                  {target.cooldownUntil !== null && (
                    <span className="text-warning shrink-0 text-2xs">held</span>
                  )}
                </TooltipButton>
              ))}
              <div className="text-text-tertiary px-1.5 pt-0.5 text-2xs leading-snug">
                Stops and resumes this lane on the chosen account: same session, one full re-read of
                the thread. In-flight work is interrupted.
              </div>
            </>
          )}
        </div>
      )}
    </div>
  )
}
