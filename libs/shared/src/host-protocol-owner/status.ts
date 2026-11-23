/**
 * Owner protocol results: the machine's local status, the owner index, the
 * transcript page and the account folder. Reached through `../host-protocol-owner`.
 */
import type { HostReleaseFeature } from '../host-release'

export type ServicePauseState =
  | { readonly kind: 'none' }
  | {
      readonly kind: 'pausing'
      readonly purpose: 'update'
      readonly since: string
      readonly deadline: string
      /**
       * Sub-agent work counts only for lanes that report it over the op channel
       * (`lane.liveness`); the others wait for their turn only.
       */
      readonly waitingOn: {
        readonly turns: number
        readonly subagents: number
        readonly routines: number
      }
    }
  | { readonly kind: 'paused'; readonly purpose: 'update'; readonly since: string }

export type LocalMode = 'local' | 'enrolling' | 'enrolled' | 'removed'

export interface OwnerLockStatus {
  readonly held: boolean
  readonly holder: 'daemon' | 'desktop' | null
  readonly pid: number | null
  /** The standby marker exists: the daemon serves the socket and nothing else. */
  readonly standby: boolean
}

/** `machine.local`. Every field after `mode` is owner-only and omitted for a `local` principal. */
export interface LocalStatus {
  /** The socket's identity, stable across sign-in and removal. */
  readonly machineId: string
  readonly hostVersion: string
  readonly mode: LocalMode
  readonly features?: readonly HostReleaseFeature[]
  readonly enrolled?: {
    readonly hostId: string
    readonly label: string
    readonly ownerLogin: string | null
  } | null
  readonly enrolling?: {
    readonly userCode: string
    readonly fingerprint: string
    readonly expiresAt: string
  }
  readonly ownerLock?: OwnerLockStatus
  readonly api?: { readonly port: number; readonly state: 'off' | 'listening' | 'busy' }
  readonly pause?: ServicePauseState
  readonly lastUpdate?: {
    readonly from: string
    readonly to: string
    readonly outcome: 'updated' | 'rolled-back' | 'failed'
    readonly at: string
  } | null
  readonly appServices?: { readonly brain: 'registered' | 'known' | 'none' }
}

export interface OwnerLaneRow {
  readonly laneId: string
  readonly sessionFile: string | null
  readonly sessionId: string | null
  readonly cwd: string
  readonly repositoryId: string
}

/** `owner.index`: what Desktop's remaining machine work (maintenance, leases) reads. */
export interface OwnerIndex {
  readonly machineId: string
  readonly enrolledHostId?: string
  readonly agentDir: string
  readonly sessionsRoot: string
  /** False while in standby. */
  readonly owning: boolean
  readonly migrateLevel: 1
  readonly lanes: readonly OwnerLaneRow[]
  /** Pass as the next call's `after`; absent on the last page. */
  readonly next?: string
}

export type MigrationState = 'none' | 'staged' | 'committed' | 'aborted'

export type LeaseRefusal = 'live-lane' | 'routine' | 'archive' | 'busy'

/**
 * `owner.transcript.page`: complete LF-terminated JSONL lines of a lane's
 * session file from `offset`, so a transcript too large for `lane.messages`
 * opens as it does in Desktop. Restart from 0 when `fingerprint` changes.
 */
export interface OwnerTranscriptPage {
  readonly size: number
  readonly offset: number
  readonly nextOffset: number
  readonly text: string
  readonly eof: boolean
  /** Changes when the file is replaced or rewritten, not when it grows. */
  readonly fingerprint: string
}

/** `owner.account.prepare`: an empty account folder under the daemon's account root. */
export interface OwnerAccountFolder {
  readonly accountId: string
  readonly credentialDir: string
}

export interface AppServiceRegistration {
  readonly service: 'brain'
  /** Loopback HTTP only: `http://127.0.0.1:<port>`. */
  readonly endpoint: string
  readonly token: string
  readonly recall: boolean
}
