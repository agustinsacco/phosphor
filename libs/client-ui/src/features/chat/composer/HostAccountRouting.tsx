import { useCallback, useEffect, useRef, useState } from 'react'
import type { ClaudeSessionAccount } from '@shared/models'
import { confirmSettingsAccess } from '@/features/settings/machine/settingsAccess'
import { laneAccountId, machineCandidate, moveTargets } from '@/lib/claudeGateway'
import {
  forgetHostProviders,
  readHostProviders,
  type HostProviders,
} from '@/stores/hostProvidersCache'
import { machineReadGeneration } from '@/stores/machineReadGeneration'
import { machineLabel, useRemoteLanesStore } from '@/stores/remoteLanes'
import { useSessionsStore } from '@/stores/sessions'
import { AccountSwitcher, accountSwitcherSummary } from './AccountSwitcher'

/**
 * A Host lane's account switcher: the same control as This Mac's, fed by the
 * Host. The Host does the move (`claude.account`: stop, rebind, resume under the
 * lane's fence), so it needs lane control plus the Host's configuration grant,
 * which it asks for with the dialog Settings uses.
 *
 * With the grant already held, the Host's accounts give it This Mac's gate and
 * wording (`accountSwitcherSummary`). Without it, nothing is read until the user
 * opens the picker and grants access, so the summary stays neutral.
 *
 * Granting access reconnects the Host, and a reconnecting Host has not said yet
 * whether it can be configured. The switcher stays mounted through that, on the
 * last answer the Host gave, so the picker the user opened is still open, and
 * its accounts are read once the grant is live.
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
  const ready = host?.state === 'ready'
  const supported = useRef<boolean | undefined>(undefined)
  if (ready) supported.current = host.configurationSupported === true
  const configurable = ready && host.capabilities.includes('machine.configure')
  const held =
    ready &&
    host.capabilities.includes('sessions.control') &&
    host.lanes.find((l) => l.laneId === laneId)?.control.controller?.self === true
  const lane = useHostLaneAccount(hostId, laneId, configurable)

  const load = useCallback(async () => {
    if (!hostId || !laneId) return []
    forgetHostProviders(hostId)
    const { accounts } = await readHostProviders(hostId)
    return moveTargets(accounts.map(machineCandidate), laneAccountId(accounts, laneId))
  }, [hostId, laneId])

  if (!hostId || !laneId || !host || supported.current !== true) return null
  // Read: This Mac's gate and wording. Not read (no grant) or a failed read: neutral.
  if (lane.status === 'loading') return null
  const account = lane.status === 'read' ? lane.account : undefined
  const shown = account ? accountSwitcherSummary(account) : undefined
  if (account === null || shown === null) return null
  const label = machineLabel(hostId)
  return (
    <AccountSwitcher
      summary={shown?.summary ?? `Move this lane to another Claude account on ${label}.`}
      warn={shown?.warn ?? false}
      nextId={account?.alternative?.id}
      blocked={
        !ready
          ? `Reconnecting to ${label}…`
          : held
            ? undefined
            : 'Take control of this lane to move it to another account.'
      }
      where={label}
      ready={configurable}
      beforeOpen={async () => {
        if (configurable) return true
        if (!(await confirmSettingsAccess(label))) return false
        await window.phosphor.invoke('hosts:settingsAccess', hostId)
        return true
      }}
      load={load}
      move={async (accountId) => {
        // Usage is re-read even when the move is not confirmed: the Host may
        // have moved the lane before the link changed.
        try {
          await window.phosphor.invoke('hosts:claudeAccount', hostId, laneId, accountId)
        } finally {
          forgetHostProviders(hostId)
          lane.reload()
          onMoved()
        }
      }}
    />
  )
}

type HostLaneAccount =
  | { status: 'unread' | 'loading' | 'failed'; reload: () => void }
  | { status: 'read'; account: ClaudeSessionAccount | null; reload: () => void }

/** The account a Host lane spends, from the Host's providers, only where the grant is held. */
function useHostLaneAccount(
  hostId: string | undefined,
  laneId: string | undefined,
  configurable: boolean,
): HostLaneAccount {
  const generation = useRemoteLanesStore(() => (hostId ? machineReadGeneration(hostId) : 0))
  const [version, setVersion] = useState(0)
  // Hidden until the first answer, as This Mac's is; a later read (a reconnect,
  // a move) keeps what is on screen, so a picker the user opened stays open.
  const [state, setState] = useState<
    { status: 'unread' | 'loading' | 'failed' } | { status: 'read'; providers: HostProviders }
  >(() => ({ status: configurable ? 'loading' : 'unread' }))
  useEffect(() => {
    if (!hostId || !laneId || !configurable) {
      setState({ status: 'unread' })
      return
    }
    let current = true
    void readHostProviders(hostId).then(
      (providers) => current && setState({ status: 'read', providers }),
      () => current && setState({ status: 'failed' }),
    )
    return () => {
      current = false
    }
  }, [hostId, laneId, configurable, generation, version])
  const reload = useCallback(() => setVersion((n) => n + 1), [])
  if (state.status === 'read' && laneId)
    return { status: 'read', account: hostSessionAccount(state.providers, laneId), reload }
  return { status: state.status === 'read' ? 'unread' : state.status, reload }
}

/**
 * A Host lane's account as This Mac's `claude:sessionAccount` describes one. The
 * alternative follows the session runtime's rule (`alternativeTo`): the first
 * other account not itself on hold.
 */
function hostSessionAccount(
  providers: HostProviders,
  laneId: string,
  nowMs = Date.now(),
): ClaudeSessionAccount | null {
  const { accounts } = providers
  const account = accounts.find((a) => a.id === laneAccountId(accounts, laneId))
  if (!account) return null
  const holding = (until: number | null) => until !== null && until > nowMs
  const other = accounts.find((a) => a.id !== account.id && !holding(a.cooldownUntil))
  return {
    id: account.id,
    label: account.label,
    ...(account.email ? { email: account.email } : {}),
    ...(account.plan ? { plan: account.plan } : {}),
    total: accounts.length,
    mode: providers.mode,
    cooldownUntil: holding(account.cooldownUntil) ? account.cooldownUntil : null,
    alternative: other ? { id: other.id, label: other.email ?? other.label } : null,
  }
}
