import type {
  ClaudeLoginState,
  ClaudeRoutingMode,
  ClaudeUsageSnapshot,
  ClaudeUsageSnapshotResult,
  LoginFlowState,
  SubscriptionProvider,
} from '@shared/models'
import type {
  ClaudeHealthModel,
  ClaudeInstallable,
  HealthJob,
} from '../claude-provider/ClaudeHealth'

/** Whether a section's data has loaded, and how to try again when it has not. */
export type SectionStatus = 'loading' | 'ready' | { error: string; retry: () => void }

/**
 * How one machine's accounts differ. Everything else about Accounts and the
 * Claude Code page is the same on This Mac and on a Host.
 */
export interface AccountsCaps {
  /** Sign-ins run in the app (This Mac) or in a private terminal on the machine (a Host). */
  signIn: 'in-app' | 'terminal'
  /** The provider installs as a package job here, or as a reviewed task that can also install the CLI. */
  install: 'package' | 'task'
  /** Published versions and in-place updates for the provider and the CLI. */
  versions: boolean
  /** The one-click end-to-end provider test. */
  proof: boolean
  /** An account lists its live sessions, or its saved and running lanes. */
  lanes: 'live' | 'saved'
}

/** One pi provider row; `requires`, `caveat` and `billing` come from the shared catalogue. */
export interface ProviderRow extends Partial<Omit<SubscriptionProvider, 'id'>> {
  id: string
  name: string
  status: 'ready' | 'not_ready' | 'unknown'
  /** Whose account: shown only where the machine reads it (never on a Host). */
  account?: string
  reason?: string
  error?: string
}

export interface ProviderAccountsSource {
  status: SectionStatus
  caps: Pick<AccountsCaps, 'signIn'>
  providers: ProviderRow[]
  /** The in-app sign-in under way. */
  flow: LoginFlowState | null
  error: string | null
  /** A sign-in is starting or running: one at a time. */
  busy: boolean
  /** Absent where this client may only read. */
  signIn?: (id: string) => void
  cancel?: (id: string) => void
  /** Absent where the scope line already offers Refresh. */
  refresh?: () => void
  /** pi's own login terminal, for a provider the in-app flow cannot drive. */
  terminal?: { ptyId: string | null; open: () => void; close: () => void }
}

/** One lane billed to a Claude account. */
export interface ClaudeAccountLane {
  id: string
  title: string
  active: boolean
  folder?: string
  /** False until there is a session file to resume: a restart or move would lose it. */
  resumable: boolean
}

export interface ClaudeAccountModel {
  id: string
  label: string
  /** Email, plan and organization, as far as the machine knows them. */
  detail: string
  /** `null`: the machine could not verify the sign-in. */
  signedIn: boolean | null
  cooldownUntil: number | null
  /** The cached reading, when there is one. */
  usage: ClaudeUsageSnapshot | null
  lanes: ClaudeAccountLane[]
}

export interface ClaudeAccountsSource {
  status: SectionStatus
  caps: AccountsCaps
  health: ClaudeHealthModel
  /** Package jobs (install, update) and their output. */
  jobs: HealthJob[]
  proof: HealthJob
  accounts: ClaudeAccountModel[]
  mode: ClaudeRoutingMode
  /** The account `specific` routing uses. */
  pinnedId?: string
  /** A change, a sign-in or a reviewed task is in flight. */
  busy: boolean
  /** Why accounts cannot be added right now, when they cannot. */
  addBlocked: string | null
  /** The in-app sign-in under way. */
  login: ClaudeLoginState | null
  add: () => void
  reauth: (id: string) => void
  /** Rejects with the machine's reason when it refuses (an account live sessions use). */
  remove: (id: string) => Promise<void>
  reorder: (ids: string[]) => void
  route: (mode: ClaudeRoutingMode, pinnedId?: string) => void
  refreshUsage: () => void
  /**
   * One account's own usage, read when its row opens; `force` asks the CLI
   * again. `null`: the machine has no reading yet, which is not zero.
   */
  usage: (id: string, force: boolean) => Promise<ClaudeUsageSnapshotResult | null>
  moveLane: (laneId: string, accountId: string) => Promise<void>
  /** Why lanes cannot be restarted or moved from here, when they cannot. */
  moveBlocked?: string | null
  openLane?: (laneId: string) => void
  submitCode?: (code: string) => Promise<void>
  cancelLogin?: () => void
  install: (what: ClaudeInstallable) => void
  update: (what: ClaudeInstallable) => void
  test: () => void
}

/** One word set for every sign-in state, on every machine. */
export const SIGN_IN_LABEL = {
  ready: 'Signed in',
  not_ready: 'Not signed in',
  unknown: 'Could not verify',
} as const

export const signInState = (signedIn: boolean | null): keyof typeof SIGN_IN_LABEL =>
  signedIn === true ? 'ready' : signedIn === false ? 'not_ready' : 'unknown'

/** "email · plan · organization", skipping what is unknown. */
export const accountDetail = (...parts: (string | undefined)[]): string =>
  parts.filter(Boolean).join(' · ')

/** The account `specific` routing uses: the pinned one while it exists, else the first. */
export function primaryAccountId(
  accounts: readonly { id: string }[],
  pinnedId: string | undefined,
): string | undefined {
  if (pinnedId && accounts.some((a) => a.id === pinnedId)) return pinnedId
  return accounts[0]?.id
}
