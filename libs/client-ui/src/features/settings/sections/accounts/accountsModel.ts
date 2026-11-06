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
import type { SectionStatus } from '../sectionStatus'

/** How one machine's accounts differ; everything else is the same on every machine. */
export interface AccountsCaps {
  /** In the app (This Mac) or in a private terminal on the machine (a Host). */
  signIn: 'in-app' | 'terminal'
  /** A package job, or a reviewed task that can also install the CLI. */
  install: 'package' | 'task'
  /** An account lists its live sessions, or its saved and running lanes. */
  lanes: 'live' | 'saved'
}

/** One pi provider; `requires`, `caveat` and `billing` come from the shared catalogue. */
export interface ProviderRow extends Partial<Omit<SubscriptionProvider, 'id'>> {
  id: string
  name: string
  status: 'ready' | 'not_ready' | 'unknown'
  /** Whose account; never on a Host. */
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
  signIn?: (id: string) => void
  cancel?: (id: string) => void
  /** pi's own login terminal, for a provider the in-app flow cannot drive. */
  terminal?: { ptyId: string | null; open: () => void; close: () => void }
}

export interface ClaudeAccountLane {
  id: string
  title: string
  active: boolean
  folder?: string
  /** False until there is a session file to resume: a restart would lose the lane. */
  resumable: boolean
}

export interface ClaudeAccountModel {
  id: string
  label: string
  /** What a move to this account calls it: the composer's name for it on this machine. */
  moveLabel: string
  /** Email, plan and organization, as far as the machine knows them. */
  detail: string
  /** `null`: the machine could not verify the sign-in. */
  signedIn: boolean | null
  cooldownUntil: number | null
  usage: ClaudeUsageSnapshot | null
  lanes: ClaudeAccountLane[]
}

export interface ClaudeAccountsSource {
  status: SectionStatus
  caps: AccountsCaps
  health: ClaudeHealthModel
  jobs: HealthJob[]
  /** The one-click end-to-end test, where the machine runs it. */
  proof?: { job: HealthJob; test: () => void }
  accounts: ClaudeAccountModel[]
  mode: ClaudeRoutingMode
  pinnedId?: string
  /** A change, a sign-in or a reviewed task is in flight. */
  busy: boolean
  /** Why accounts cannot be added right now, when they cannot. */
  addBlocked: string | null
  login: ClaudeLoginState | null
  add: () => void
  reauth: (id: string) => void
  /** Rejects with the machine's reason when it refuses (an account live sessions use). */
  remove: (id: string) => Promise<void>
  reorder: (ids: string[]) => void
  route: (mode: ClaudeRoutingMode, pinnedId?: string) => void
  refreshUsage: () => void
  /** One account's usage; `force` asks the CLI again. `null`: no reading yet, not zero. */
  usage: (id: string, force: boolean) => Promise<ClaudeUsageSnapshotResult | null>
  /**
   * A lane may move to any other account not known to be signed out
   * (`signedIn !== false`), unverified ones included, as in the composer
   * (`moveTargets`).
   */
  moveLane: (laneId: string, accountId: string) => Promise<void>
  /** Why lanes cannot be restarted or moved from here, when they cannot. */
  moveBlocked?: string | null
  openLane: (laneId: string) => void
  submitCode?: (code: string) => void
  cancelLogin?: () => void
  install: (what: ClaudeInstallable) => void
  update: (what: ClaudeInstallable) => void
}

/** One word set for every sign-in state, on every machine. */
export const SIGN_IN_LABEL = {
  ready: 'Signed in',
  not_ready: 'Not signed in',
  unknown: 'Could not verify',
} as const

export const signInState = (signedIn: boolean | null): keyof typeof SIGN_IN_LABEL =>
  signedIn === true ? 'ready' : signedIn === false ? 'not_ready' : 'unknown'

export const accountDetail = (...parts: (string | undefined)[]): string =>
  parts.filter(Boolean).join(' · ')

/** The account `specific` routing uses: the pinned one while it exists, else the first. */
export const primaryAccountId = (accounts: readonly { id: string }[], pinnedId?: string) =>
  pinnedId && accounts.some((a) => a.id === pinnedId) ? pinnedId : accounts[0]?.id
