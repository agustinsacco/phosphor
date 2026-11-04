import { useCallback, useEffect, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import type {
  ClaudeAccountSessions,
  ClaudeAccountsResult,
  ClaudeLoginState,
  ClaudeStatus,
  ClaudeUsageSnapshotResult,
  PiPackageEntry,
} from '@shared/models'
import { MIN_CLAUDE_CONTEXT_VERSION } from '@shared/models'
import { errorText } from '@shared/errors'
import { isNewerVersion, meetsMinimum } from '@shared/version'
import { basename } from '@/lib/path'
import { sessionTitle } from '@/lib/sessionTitle'
import { viewCandidate } from '@/lib/claudeGateway'
import { useChatStore } from '@/stores/chat'
import { useSessionsStore } from '@/stores/sessions'
import { navigateToLane } from '@/stores/remoteLanes'
import { usePackageJob } from '../../usePackageJob'
import {
  accountDetail,
  type ClaudeAccountLane,
  type ClaudeAccountModel,
  type ClaudeAccountsSource,
} from '../accounts/accountsModel'
import type { ClaudeHealthModel, ClaudeInstallable } from './ClaudeHealth'

const CLAUDE_PROVIDER_SPEC = 'npm:@saccolabs/pi-claude-cli'

interface LocalClaudeState {
  pkg: PiPackageEntry | null | undefined
  status: ClaudeStatus | null
  accounts: ClaudeAccountsResult | null
  latest: string | null
  cliLatest: string | null
}

/** This Mac's provider package, CLI and accounts, read together and again on demand. */
function useLocalClaudeState() {
  const [state, setState] = useState<LocalClaudeState>({
    pkg: undefined,
    status: null,
    accounts: null,
    latest: null,
    cliLatest: null,
  })
  const [error, setError] = useState<string | null>(null)
  const refresh = useCallback(async (): Promise<void> => {
    try {
      const [entries, status, accounts] = await Promise.all([
        window.phosphor.invoke('packages:list'),
        window.phosphor.invoke('packages:claudeStatus'),
        window.phosphor.invoke('claude:accounts'),
      ])
      const pkg = entries.find((e) => e.spec.includes('pi-claude-cli')) ?? null
      setError(null)
      setState((s) => ({ ...s, pkg, status, accounts }))
      // Both version checks hit the network, so neither blocks the health rows.
      if (pkg)
        void window.phosphor
          .invoke('packages:checkUpdates')
          .then((map) => setState((s) => ({ ...s, latest: map[pkg.spec] ?? null })))
          .catch(() => setState((s) => ({ ...s, latest: null })))
      void window.phosphor
        .invoke('packages:claudeCliLatest')
        .then((cliLatest) => setState((s) => ({ ...s, cliLatest })))
        .catch(() => setState((s) => ({ ...s, cliLatest: null })))
    } catch (caught) {
      setError(errorText(caught))
    }
  }, [])
  useEffect(() => {
    void refresh()
  }, [refresh])
  return { state, setState, error, refresh }
}

const newer = (latest: string | null, current: string | undefined): string | null =>
  latest !== null && current !== undefined && isNewerVersion(latest, current) ? latest : null

function healthOf({ pkg, status, latest, cliLatest }: LocalClaudeState): ClaudeHealthModel {
  // Main refuses a Claude session on a copy this old, so the row must not read
  // as healthy beside it. Same rule as the refusal (provider-detect.ts).
  const tooOld = pkg?.installed === true && !meetsMinimum(pkg.version, MIN_CLAUDE_CONTEXT_VERSION)
  const cliVersion = status?.binary.version
  return {
    provider:
      pkg === undefined
        ? 'checking'
        : pkg === null
          ? 'missing'
          : !pkg.installed
            ? 'declared'
            : tooOld
              ? 'outdated'
              : 'installed',
    ...(pkg ? { package: { name: pkg.name, version: pkg.version, scope: pkg.scope } } : {}),
    providerLatest: newer(latest, pkg?.version),
    cli: status === null ? 'checking' : status.binary.found ? 'installed' : 'missing',
    cliVersion,
    cliPath: status?.binary.path,
    cliLatest: newer(cliLatest, cliVersion),
  }
}

/**
 * The live sessions spending each account, read again on every change to the
 * live set, which is also what a move produces: the moved lane is a new
 * session id on a new account.
 */
function useLiveLanes(): Record<string, ClaudeAccountLane[]> {
  const [sessions, setSessions] = useState<ClaudeAccountSessions>({})
  const liveKey = useSessionsStore((s) => Object.keys(s.live).sort().join(','))
  useEffect(() => {
    void window.phosphor
      .invoke('claude:accountSessions')
      .then(setSessions)
      .catch(() => setSessions({}))
  }, [liveKey])
  const ids = Object.values(sessions).flat()
  const titles = useChatStore(
    useShallow((s) =>
      ids.map((id) => {
        const chat = s.sessions[id]
        const first = chat?.items.find((item) => item.kind === 'user')
        const firstUserText = first?.kind === 'user' ? first.text : undefined
        return sessionTitle({ explicitName: chat?.meta?.sessionName, firstUserText })
      }),
    ),
  )
  const live = useSessionsStore((s) => s.live)
  const laneOf = (id: string): ClaudeAccountLane => {
    const folder = live[id]?.workspacePath
    return {
      id,
      title: titles[ids.indexOf(id)] ?? 'Untitled session',
      active: true,
      ...(folder ? { folder: basename(folder) } : {}),
      // No session file means no turn has ended: a restart would lose the lane.
      resumable: Boolean(live[id]?.diskPath),
    }
  }
  return Object.fromEntries(
    Object.entries(sessions).map(([accountId, sessionIds]) => [accountId, sessionIds.map(laneOf)]),
  )
}

/** Sign-in progress is an event: the middle of it is a human in a browser. */
function useLoginState(refresh: () => Promise<void>) {
  const [login, setLogin] = useState<ClaudeLoginState | null>(null)
  // Terminal phases re-read the accounts, so a row shows the account that is
  // actually live, not the one we hoped for.
  useEffect(
    () =>
      window.phosphor.onClaudeLoginState((state) => {
        const ended = state.phase === 'signed-in' || state.phase === 'cancelled'
        setLogin(ended ? null : state)
        if (ended) void refresh()
      }),
    [refresh],
  )
  const start = async (accountId?: string): Promise<void> => {
    setLogin({ phase: 'starting' })
    try {
      await window.phosphor.invoke('claude:startLogin', accountId)
    } catch (caught) {
      setLogin({ phase: 'error', message: errorText(caught) })
    }
  }
  return { login, setLogin, start }
}

/** The provider's package jobs: install, update (provider or CLI) and the end-to-end proof. */
function usePackageActions(pkg: PiPackageEntry | null | undefined, after: () => void) {
  const providerJob = usePackageJob(after)
  const cliJob = usePackageJob(after)
  const proof = usePackageJob()
  const run = (what: 'install' | 'update') =>
    void providerJob.start(() =>
      window.phosphor.invoke(
        'packages:run',
        what,
        pkg?.spec ?? CLAUDE_PROVIDER_SPEC,
        'global',
        undefined,
      ),
    )
  return {
    jobs: [providerJob, cliJob],
    proof: {
      job: proof,
      test: () => void proof.start(() => window.phosphor.invoke('packages:testClaudeProvider')),
    },
    running: providerJob.running || cliJob.running,
    install: () => run('install'),
    update: (what: ClaudeInstallable) =>
      what === 'cli'
        ? void cliJob.start(() => window.phosphor.invoke('packages:updateClaudeCli'))
        : run('update'),
  }
}

const accountsOf = (
  accounts: ClaudeAccountsResult | null,
  lanes: Record<string, ClaudeAccountLane[]>,
): ClaudeAccountModel[] =>
  (accounts?.views ?? []).map((view) => {
    const { account, auth, usage, cooldownUntil } = view
    return {
      id: account.id,
      label: account.label,
      moveLabel: viewCandidate(view).label,
      detail: accountDetail(
        auth.email ?? account.email,
        auth.plan ?? account.plan,
        auth.organization ?? account.organization,
      ),
      signedIn: auth.loggedIn ?? null,
      cooldownUntil,
      usage,
      lanes: lanes[account.id] ?? [],
    }
  })

/**
 * Stable, so an open account row reads its usage once. Main caches each reading
 * ~60 s; `force` (Check again) skips the cache.
 */
const readUsage = (id: string, force: boolean): Promise<ClaudeUsageSnapshotResult> =>
  window.phosphor.invoke('claude:usageSnapshot', id, force)

/** This Mac's Claude Code page: package jobs, in-app sign-in, live sessions per account. */
export function useLocalClaudeAccounts(): ClaudeAccountsSource {
  const { state, setState, error, refresh } = useLocalClaudeState()
  const lanes = useLiveLanes()
  const { login, setLogin, start } = useLoginState(refresh)
  const [busy, setBusy] = useState(false)
  const moveSessionToAccount = useSessionsStore((s) => s.moveSessionToAccount)
  const after = (): void => void refresh()
  const packages = usePackageActions(state.pkg, after)
  const mutate = async (run: () => Promise<unknown>): Promise<void> => {
    setBusy(true)
    try {
      await run()
    } finally {
      setBusy(false)
      after()
    }
  }
  const health = healthOf(state)
  const prefs = state.accounts?.prefs
  return {
    status: error ? { error, retry: after } : state.accounts === null ? 'loading' : 'ready',
    caps: { signIn: 'in-app', install: 'package', lanes: 'live' },
    health,
    ...packages,
    accounts: accountsOf(state.accounts, lanes),
    mode: prefs?.mode ?? 'ordered',
    pinnedId: prefs?.pinnedId,
    busy: busy || login !== null || packages.running,
    addBlocked: health.cli === 'missing' ? 'Install the claude CLI first' : null,
    login,
    add: () => void start(),
    reauth: (id) => void start(id),
    remove: (id) => mutate(() => window.phosphor.invoke('claude:removeAccount', id)),
    reorder: (ids) => void mutate(() => window.phosphor.invoke('claude:reorderAccounts', ids)),
    route: (mode, pinnedId) =>
      void mutate(() => window.phosphor.invoke('claude:setRouting', mode, pinnedId)),
    refreshUsage: () =>
      void mutate(async () => {
        const accounts = await window.phosphor.invoke('claude:refreshAccountUsage')
        setState((s) => ({ ...s, accounts }))
      }),
    usage: readUsage,
    moveLane: async (laneId, accountId) => void (await moveSessionToAccount(laneId, accountId)),
    openLane: (laneId) => void navigateToLane({ sessionId: laneId }),
    submitCode: (code) =>
      void window.phosphor
        .invoke('claude:submitCode', code)
        .catch((caught: unknown) => setLogin({ phase: 'error', message: errorText(caught) })),
    cancelLogin: () => {
      void window.phosphor.invoke('claude:cancelLogin').catch(() => undefined)
      setLogin(null)
    },
  }
}
