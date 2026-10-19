/**
 * Control-plane wire types: the request and response bodies every route
 * carries, and the platform and architecture unions a Host reports. Parsers
 * that produce these shapes live in the domain modules beside this one.
 */

import type { GrantClient } from '../host-grant'

export const PLATFORMS = ['linux', 'darwin', 'win32'] as const
export type Platform = (typeof PLATFORMS)[number]
export const ARCHES = ['x64', 'arm64'] as const
export type Arch = (typeof ARCHES)[number]

export interface AccountHandle {
  /** GitHub login, shown as @login. Null if the provider gave none. */
  readonly login: string | null
}

export interface Readiness {
  readonly pi: 'ok' | 'missing' | 'outdated' | 'unknown'
  readonly claude: 'ok' | 'missing' | 'signed-out' | 'unknown'
  readonly tailscale: 'ok' | 'missing' | 'stopped' | 'no-https' | 'unknown'
}

export interface LaneCounts {
  readonly running: number
  readonly waiting: number
}

export type MachineState = 'running' | 'stopping'

export interface EnrollmentCreateRequest {
  readonly publicKey: string
  readonly hostname: string
  readonly platform: Platform
  readonly arch: Arch
  readonly hostVersion: string
}

export interface EnrollmentCreateResponse {
  readonly enrollmentId: string
  /** Canonical 8 letters; display with formatUserCode. */
  readonly userCode: string
  readonly keyFingerprint: string
  readonly expiresAt: string
  readonly pollIntervalSec: number
}

export interface EnrollmentPollRequest {
  readonly enrollmentId: string
}

export type EnrollmentPollResponse =
  | { readonly status: 'pending' }
  | {
      readonly status: 'approved'
      readonly hostId: string
      readonly label: string
      readonly owner: AccountHandle
    }
  | { readonly status: 'expired' }

export interface EnrollmentLookupRequest {
  readonly userCode: string
}

export interface EnrollmentLookupResponse {
  readonly hostname: string
  readonly platform: Platform
  readonly arch: Arch
  readonly hostVersion: string
  readonly keyFingerprint: string
  readonly expiresAt: string
}

export interface EnrollmentApproveRequest {
  readonly userCode: string
  readonly label: string
}

export interface MachineView {
  readonly id: string
  readonly label: string
  readonly hostname: string
  readonly platform: Platform
  readonly arch: Arch
  readonly hostVersion: string | null
  readonly keyFingerprint: string
  readonly enrolledAt: string
  /** Server time of the latest accepted beat. */
  readonly lastSeenAt: string | null
  readonly state: MachineState | null
  readonly readiness: Readiness | null
  readonly lanes: LaneCounts | null
  /** The Host's private HTTPS address as it reported it. Never fetched by the server. */
  readonly endpoint: string | null
}

export interface EnrollmentApproveResponse {
  readonly machine: MachineView
}

export interface MachinesResponse {
  readonly machines: readonly MachineView[]
  /** Lets a client correct its own clock before judging up or down. */
  readonly serverTime: string
}

export interface MachineRenameRequest {
  readonly label: string
}

export interface MeResponse {
  readonly account: AccountHandle
  /** False when the account is suspended: every other user route answers 403. */
  readonly enabled: boolean
  readonly maxHosts: number
}

export interface HostSelfResponse {
  readonly hostId: string
  readonly label: string
  readonly owner: AccountHandle
  readonly enrolledAt: string
  readonly lastSeenAt: string | null
}

export interface HeartbeatRequest {
  /** Strictly increasing per Host, persisted by the Host across restarts. */
  readonly seq: number
  readonly state: MachineState
  readonly hostVersion: string
  readonly uptimeSec: number
  readonly readiness: Readiness
  readonly lanes: LaneCounts
  readonly endpoint: string | null
}

export interface ClientRegisterRequest {
  readonly label: string
}
export interface ClientRegisterResponse {
  readonly client: GrantClient
}
export interface GrantIssueRequest {
  readonly hostId: string
  readonly clientId: string
  /** Owner-authorized machine administration, independent of lane control. */
  readonly configure?: true
}
export interface GrantIssueResponse {
  readonly grant: string
  readonly expiresAt: string
  readonly host: {
    readonly id: string
    readonly endpoint: string | null
    readonly publicKey: string
  }
}
export interface HostRevocations {
  readonly epoch: number
  readonly ownerId: string
  readonly revoked: { readonly sessions: readonly string[]; readonly clients: readonly string[] }
}

export interface HeartbeatResponse {
  readonly accepted: true
  readonly nextInSec: number
  readonly epoch?: number
  readonly ownerId?: string
  readonly revoked?: HostRevocations['revoked']
}

export interface HealthResponse {
  readonly ok: true
  readonly version: string
  /** False when the server has no Supabase secret: every non-health route answers 503. */
  readonly configured: boolean
}
