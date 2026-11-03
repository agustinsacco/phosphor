import { useCallback, useRef } from 'react'
import type { ClaudeRoutingMode, ClaudeUsageSnapshotResult } from '@shared/models'
import type { MachineAccount } from '@shared/machine-settings'
import { machineCandidate } from '@/lib/claudeGateway'
import { openRemoteLane } from '@/stores/remoteLanes'
import { useHostSection } from '../../machine/HostSection'
import {
  accountDetail,
  type ClaudeAccountModel,
  type ClaudeAccountsSource,
} from '../accounts/accountsModel'
import type { ClaudeHealthModel } from './ClaudeHealth'

/** The Host's account bound (`MachineSettings.providers.accounts` is capped on the wire). */
const HOST_ACCOUNT_LIMIT = 16

const accountOf = (account: MachineAccount): ClaudeAccountModel => ({
  id: account.id,
  label: account.label,
  // The Host composer's name for it, so a move reads the same in both places.
  moveLabel: machineCandidate(account).label,
  detail: accountDetail(
    account.email !== account.label ? account.email : undefined,
    account.plan,
    account.organization,
  ),
  signedIn: account.loggedIn,
  cooldownUntil: account.cooldownUntil,
  usage: account.usage,
  // A Host lane is always saved, so a restart or move can always resume it.
  lanes: account.lanes.map((lane) => ({ ...lane, resumable: true })),
})

const snapshotOf = (account: MachineAccount | undefined): ClaudeUsageSnapshotResult | null =>
  account?.usage ? { ok: true, snapshot: account.usage } : null

/**
 * A Host's Claude Code page. Sign-ins and installs run as private programs on
 * the Host (a terminal, a reviewed task); account changes are Host settings
 * changes; a lane move is the Host's fenced `claude.account`.
 */
export function useHostClaudeAccounts(): ClaudeAccountsSource {
  const { machine, settings, programs, connection } = useHostSection()
  const state = settings.data?.providers
  const latest = useRef(settings)
  latest.current = settings
  // Stable: an open account row reads once. The Host keeps the last reading;
  // `force` asks its CLI again.
  const usage = useCallback(async (id: string, force: boolean) => {
    if (!force) return snapshotOf(latest.current.data?.providers?.accounts.find((a) => a.id === id))
    const data = await latest.current.change({ type: 'claude.usage', accountId: id })
    if (!data) return { ok: false, error: 'run-failed' } as const
    return snapshotOf(data.providers?.accounts.find((a) => a.id === id))
  }, [])
  const claude = state?.claude
  const health: ClaudeHealthModel = {
    provider: !claude
      ? 'checking'
      : claude.provider === 'ok'
        ? 'installed'
        : claude.provider === 'outdated'
          ? 'outdated'
          : 'missing',
    cli: !claude ? 'checking' : claude.cli === 'ok' ? 'installed' : 'missing',
  }
  const accounts = (state?.accounts ?? []).map(accountOf)
  const change = settings.change
  const route = (mode: ClaudeRoutingMode, pinnedId?: string): void =>
    void change({ type: 'claude.routing', mode, ...(pinnedId ? { pinnedId } : {}) })
  const install = (what: 'provider' | 'cli'): void =>
    programs.task({ task: what === 'cli' ? 'claude.installCli' : 'claude.installProvider' })
  return {
    status: state ? 'ready' : 'loading',
    caps: { signIn: 'terminal', install: 'task', lanes: 'saved' },
    health,
    jobs: [],
    accounts,
    mode: state?.mode ?? 'ordered',
    pinnedId: state?.pinnedId,
    busy: settings.saving || settings.loading || programs.busy || state?.authenticating === true,
    addBlocked: !programs.available
      ? 'Sign-in needs the private Host terminal'
      : health.cli !== 'installed'
        ? 'Install Claude Code first'
        : accounts.length >= HOST_ACCOUNT_LIMIT
          ? `This Host holds at most ${HOST_ACCOUNT_LIMIT} accounts`
          : null,
    // The Host is still verifying a sign-in that ran in its terminal.
    login: state?.authenticating ? { phase: 'finishing' } : null,
    add: () => programs.login('claude', { addAccount: true }),
    reauth: (id) => programs.login('claude', { accountId: id }),
    remove: async (id) => void (await change({ type: 'claude.remove', accountId: id })),
    reorder: (ids) => void change({ type: 'claude.reorder', ids }),
    route,
    refreshUsage: () => void change({ type: 'claude.refreshUsage' }),
    usage,
    moveLane: settings.moveAccount,
    moveBlocked: connection?.capabilities.includes('sessions.control')
      ? null
      : 'Restarting or moving a lane needs lane control on this Host',
    openLane: (laneId) => void openRemoteLane(machine.id, laneId),
    install,
    // A Host installs the newest provider and CLI, so an update is an install.
    update: install,
  }
}
