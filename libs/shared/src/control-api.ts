/**
 * The control plane's wire contract: phosphor.saccolabs.com/api/v1, shared by
 * its server (apps/control), Hosts (apps/host), Desktop and later the PWA.
 *
 * The control plane knows who you are, which machines you have and whether
 * they are up. It never sees lanes, prompts, transcripts, paths or provider
 * tokens. Lanes travel from a machine to a client over Tailscale, never here.
 *
 * Pure on purpose: no node:, no electron, no fetch, no crypto. Hashing,
 * signing and transport live at each edge; this module only fixes the shapes,
 * limits and byte-exact strings both sides must agree on.
 *
 * Parsers keep known fields only and ignore unknown ones, so a newer peer can
 * add a field without breaking an older one, and nothing unknown is stored.
 */

import { GRANT_LIMITS, GRANT_PREFIX, type GrantClient } from './host-grant'

export const CONTROL_API_VERSION = 1
export const CONTROL_API_PREFIX = '/api/v1'
export const DEFAULT_CONTROL_URL = 'https://phosphor.saccolabs.com'

/** Logging metadata only. These headers never authorize a request. */
export const CONTROL_TRACE_HEADERS = {
  client: 'x-phosphor-client',
  trace: 'x-phosphor-trace',
} as const
export const isControlClient = (value: unknown): value is string =>
  typeof value === 'string' && /^(desktop|host)\/[0-9A-Za-z.+-]{1,40}$/.test(value)
export const isControlTrace = (value: unknown): value is string =>
  typeof value === 'string' && /^[0-9a-f]{16}$/.test(value)

export const CONTROL_LIMITS = {
  /** Largest request body any API route accepts. */
  bodyBytes: 16 * 1024,
  labelChars: 80,
  hostnameChars: 253,
  enrollmentTtlSec: 600,
  enrollmentPollSec: 5,
  heartbeatSec: 30,
  /** A machine with no beat for this long is down. */
  downAfterSec: 90,
  /** The server refuses beats closer together than this. */
  heartbeatMinSec: 10,
  /** How far a signed request's timestamp may drift from the server's clock. */
  signatureSkewSec: 60,
  maxHostsPerAccount: 20,
  maxLanes: 10_000,
} as const

export const CONTROL_ROUTES = {
  /** GET, public: process and configuration health. */
  health: `${CONTROL_API_PREFIX}/health`,
  /** GET, user: who the control plane thinks you are. */
  me: `${CONTROL_API_PREFIX}/me`,
  /** POST, signed by the new key (x-phosphor-key): start enrolling a Host. */
  enrollments: `${CONTROL_API_PREFIX}/enrollments`,
  /** POST, signed by the enrolling key: has the user approved yet? */
  enrollmentPoll: `${CONTROL_API_PREFIX}/enrollments/poll`,
  /** POST, user: what is this code? Shown before approving. */
  enrollmentLookup: `${CONTROL_API_PREFIX}/enrollments/lookup`,
  /** POST, user: approve the code; the Host becomes yours. */
  enrollmentApprove: `${CONTROL_API_PREFIX}/enrollments/approve`,
  /** GET, user: your machines and their latest state. */
  machines: `${CONTROL_API_PREFIX}/machines`,
  /** POST, user: register a Desktop install. */
  clients: `${CONTROL_API_PREFIX}/clients`,
  /** POST, user: short-lived Host permission. */
  grants: `${CONTROL_API_PREFIX}/grants`,
  /** GET, public: verification keys for Host grants. */
  grantKeys: `${CONTROL_API_PREFIX}/grant-keys`,
  /** GET, signed by an enrolled Host (x-phosphor-host): its own record. */
  hostSelf: `${CONTROL_API_PREFIX}/hosts/self`,
  /** POST, Host-signed: the 30-second heartbeat. */
  hostHeartbeat: `${CONTROL_API_PREFIX}/hosts/self/heartbeat`,
  /** POST, Host-signed: `phosphor logout`. */
  hostRevoke: `${CONTROL_API_PREFIX}/hosts/self/revoke`,
} as const

/** PATCH {label} renames, DELETE revokes. User-authenticated. */
export function machineRoute(machineId: string): string {
  return `${CONTROL_ROUTES.machines}/${machineId}`
}

// ---------------------------------------------------------------- Host signing

export const HOST_SIGNATURE_SCHEME = 'phosphor-host-v1'

/** Lowercase, as HTTP header names are compared case-insensitively. */
export const HOST_HEADERS = {
  /** An enrolled Host's id. Mutually exclusive with `key`. */
  host: 'x-phosphor-host',
  /** The Ed25519 public key, before enrollment completes. */
  key: 'x-phosphor-key',
  timestamp: 'x-phosphor-timestamp',
  nonce: 'x-phosphor-nonce',
  signature: 'x-phosphor-signature',
} as const

export interface HostSigningInput {
  readonly method: string
  /** Path only: signed routes take no query string. */
  readonly path: string
  /** The host id or the public key, whichever header the request carries. */
  readonly identity: string
  /** Unix seconds, as sent in x-phosphor-timestamp. */
  readonly timestamp: string
  readonly nonce: string
  /** Lowercase hex SHA-256 of the exact body bytes (of '' for no body). */
  readonly bodySha256: string
}

/**
 * The exact bytes an Ed25519 Host signature covers. Binding the identity, the
 * route and the body hash means a captured signature cannot be replayed on
 * another route, for another Host, or with another body; the timestamp and
 * nonce bound replays of the same request.
 */
export function hostSigningString(input: HostSigningInput): string {
  return [
    HOST_SIGNATURE_SCHEME,
    input.method.toUpperCase(),
    input.path,
    input.identity,
    input.timestamp,
    input.nonce,
    input.bodySha256,
  ].join('\n')
}

const BASE64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'

/**
 * Exactly `bytes` bytes as unpadded base64url, in its one canonical spelling:
 * the bits the last character carries beyond the data must be zero. Without
 * that, one key has up to 16 spellings (ElmQ, ElmR, ElmS, ElmT decode alike),
 * and a uniqueness rule on the text would not be one on the key.
 */
function isBase64url(value: unknown, bytes: number): value is string {
  const chars = Math.ceil((bytes * 8) / 6)
  if (typeof value !== 'string' || value.length !== chars) return false
  for (const char of value) if (!BASE64URL.includes(char)) return false
  const unusedBits = chars * 6 - bytes * 8
  return BASE64URL.indexOf(value.charAt(chars - 1)) % 2 ** unusedBits === 0
}

/** Raw 32-byte Ed25519 public key, base64url without padding (43 chars). */
export const isPublicKey = (value: unknown): value is string => isBase64url(value, 32)
/** 64-byte Ed25519 signature, base64url without padding (86 chars). */
export const isSignature = (value: unknown): value is string => isBase64url(value, 64)
/** 16 random bytes, base64url without padding (22 chars). */
export const isNonce = (value: unknown): value is string => isBase64url(value, 16)
export const isSha256Hex = (value: unknown): value is string =>
  typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)

/** Unix seconds as decimal digits, no sign, no leading zero. */
export function parseTimestamp(value: unknown): number | null {
  if (typeof value !== 'string' || !/^[1-9][0-9]{0,11}$/.test(value)) return null
  return Number(value)
}

/** True when a signed request's timestamp is within the allowed skew. */
export function withinSkew(timestampSec: number, nowMs: number): boolean {
  return Math.abs(nowMs / 1000 - timestampSec) <= CONTROL_LIMITS.signatureSkewSec
}

/**
 * The fingerprint people compare between a Host's terminal and the approving
 * screen: the first 8 bytes of SHA-256(raw public key), as four hex groups.
 */
export function formatKeyFingerprint(sha256OfKey: Uint8Array): string {
  if (sha256OfKey.length < 8) throw new Error('fingerprint needs 8 digest bytes')
  const hex = Array.from(sha256OfKey.subarray(0, 8), (b) => b.toString(16).padStart(2, '0'))
  return [0, 2, 4, 6].map((i) => `${hex[i]}${hex[i + 1]}`).join('-')
}

export const isKeyFingerprint = (value: unknown): value is string =>
  typeof value === 'string' && /^[0-9a-f]{4}(?:-[0-9a-f]{4}){3}$/.test(value)

// ------------------------------------------------------------------ User codes

/** No vowels (no words), no 0/O/1/I look-alikes. 20 letters, 8 of them: ~2.6e10. */
export const USER_CODE_ALPHABET = 'BCDFGHJKLMNPQRSTVWXZ'
export const USER_CODE_LENGTH = 8

/**
 * A code from random bytes by rejection sampling (bytes >= 240 are skipped, so
 * every letter is equally likely). Returns null when the bytes run out; 32
 * bytes fail with probability below 1e-20.
 */
export function userCodeFromBytes(bytes: Uint8Array): string | null {
  let code = ''
  for (const byte of bytes) {
    if (byte >= 240) continue
    code += USER_CODE_ALPHABET[byte % USER_CODE_ALPHABET.length]
    if (code.length === USER_CODE_LENGTH) return code
  }
  return null
}

/** BCDFGHJK → BCDF-GHJK, for display. */
export function formatUserCode(code: string): string {
  return `${code.slice(0, 4)}-${code.slice(4)}`
}

/**
 * What a person typed → the canonical 8 letters, or null. Case, spaces and
 * dashes are forgiven; anything else is not. Hash this value, never the input.
 */
export function normalizeUserCode(input: unknown): string | null {
  if (typeof input !== 'string' || input.length > 32) return null
  const code = input.toUpperCase().replace(/[\s-]/g, '')
  if (code.length !== USER_CODE_LENGTH) return null
  for (const char of code) if (!USER_CODE_ALPHABET.includes(char)) return null
  return code
}

// ----------------------------------------------------------------------- Types

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

// ---------------------------------------------------------------------- Errors

export const CONTROL_ERROR_STATUS = {
  'bad-request': 400,
  unauthenticated: 401,
  forbidden: 403,
  'not-found': 404,
  conflict: 409,
  /** A revoked Host, or an enrollment that can no longer complete. */
  gone: 410,
  'payload-too-large': 413,
  'unsupported-media-type': 415,
  'too-many-requests': 429,
  internal: 500,
  unavailable: 503,
} as const

export type ControlErrorCode = keyof typeof CONTROL_ERROR_STATUS

export interface ControlErrorBody {
  readonly error: { readonly code: ControlErrorCode; readonly message: string }
}

// --------------------------------------------------------------------- Parsing

export type Parsed<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly reason: string }

const ok = <T>(value: T): Parsed<T> => ({ ok: true, value })
const fail = <T>(reason: string): Parsed<T> => ({ ok: false, reason })

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
export const isUuid = (value: unknown): value is string =>
  typeof value === 'string' && uuid.test(value)

// eslint-disable-next-line no-control-regex
const control = /[\u0000-\u001f\u007f-\u009f]/
/** Bidi controls reorder what is shown, and line separators split it. */
const invisible = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069\u2028\u2029]/

/** Trimmed, 1-80 characters, no control characters. */
export function normalizeLabel(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const label = value.trim()
  if (
    label.length < 1 ||
    label.length > CONTROL_LIMITS.labelChars ||
    control.test(label) ||
    invisible.test(label)
  )
    return null
  return label
}

const hostnamePattern = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,252})$/
export const isHostname = (value: unknown): value is string =>
  typeof value === 'string' && hostnamePattern.test(value)

const versionPattern = /^\d{1,6}\.\d{1,6}\.\d{1,6}(?:[-+][0-9A-Za-z.-]{1,64})?$/
export const isVersion = (value: unknown): value is string =>
  typeof value === 'string' && versionPattern.test(value)

const endpointPattern = /^https:\/\/[a-z0-9](?:[a-z0-9.-]{0,252})(?::([1-9][0-9]{0,4}))?$/
/** A bare HTTPS origin such as https://bee1.tail9f6158.ts.net: no path, no credentials. */
export function isEndpoint(value: unknown): value is string {
  if (typeof value !== 'string') return false
  const match = endpointPattern.exec(value)
  return match !== null && (match[1] === undefined || Number(match[1]) <= 65_535)
}

const isoPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/
/**
 * A UTC time exactly as toISOString() writes it, the one form every side
 * sends. Date.parse alone is not enough: it takes '1', and it reads a time
 * without a zone as local time, which would skew every up/down judgement.
 */
export function isIsoTime(value: unknown): value is string {
  if (typeof value !== 'string' || !isoPattern.test(value)) return false
  const time = Date.parse(value)
  return Number.isFinite(time) && new Date(time).toISOString() === value
}
const isIso = isIsoTime

const isCount = (value: unknown, max: number): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= max

const oneOf = <T extends string>(options: readonly T[], value: unknown): value is T =>
  typeof value === 'string' && (options as readonly string[]).includes(value)

const READINESS = {
  pi: ['ok', 'missing', 'outdated', 'unknown'],
  claude: ['ok', 'missing', 'signed-out', 'unknown'],
  tailscale: ['ok', 'missing', 'stopped', 'no-https', 'unknown'],
} as const

function readiness(value: unknown): Readiness | null {
  if (!isRecord(value)) return null
  if (!oneOf(READINESS.pi, value.pi)) return null
  if (!oneOf(READINESS.claude, value.claude)) return null
  if (!oneOf(READINESS.tailscale, value.tailscale)) return null
  return { pi: value.pi, claude: value.claude, tailscale: value.tailscale }
}

function lanes(value: unknown): LaneCounts | null {
  if (!isRecord(value)) return null
  if (!isCount(value.running, CONTROL_LIMITS.maxLanes)) return null
  if (!isCount(value.waiting, CONTROL_LIMITS.maxLanes)) return null
  return { running: value.running, waiting: value.waiting }
}

function account(value: unknown): AccountHandle | null {
  if (!isRecord(value)) return null
  if (value.login === null) return { login: null }
  if (typeof value.login !== 'string' || !/^[A-Za-z0-9-]{1,39}$/.test(value.login)) return null
  return { login: value.login }
}

const optional = <T>(value: unknown, check: (v: unknown) => v is T): T | null | undefined =>
  value === null ? null : check(value) ? value : undefined

export function parseEnrollmentCreateRequest(value: unknown): Parsed<EnrollmentCreateRequest> {
  if (!isRecord(value)) return fail('body must be an object')
  if (!isPublicKey(value.publicKey)) return fail('publicKey')
  if (!isHostname(value.hostname)) return fail('hostname')
  if (!oneOf(PLATFORMS, value.platform)) return fail('platform')
  if (!oneOf(ARCHES, value.arch)) return fail('arch')
  if (!isVersion(value.hostVersion)) return fail('hostVersion')
  return ok({
    publicKey: value.publicKey,
    hostname: value.hostname,
    platform: value.platform,
    arch: value.arch,
    hostVersion: value.hostVersion,
  })
}

export function parseEnrollmentCreateResponse(value: unknown): Parsed<EnrollmentCreateResponse> {
  if (!isRecord(value)) return fail('body must be an object')
  if (!isUuid(value.enrollmentId)) return fail('enrollmentId')
  const userCode = normalizeUserCode(value.userCode)
  if (userCode === null || userCode !== value.userCode) return fail('userCode')
  if (!isKeyFingerprint(value.keyFingerprint)) return fail('keyFingerprint')
  if (!isIso(value.expiresAt)) return fail('expiresAt')
  if (!isCount(value.pollIntervalSec, 60) || value.pollIntervalSec < 1)
    return fail('pollIntervalSec')
  return ok({
    enrollmentId: value.enrollmentId,
    userCode,
    keyFingerprint: value.keyFingerprint,
    expiresAt: value.expiresAt,
    pollIntervalSec: value.pollIntervalSec,
  })
}

export function parseEnrollmentPollRequest(value: unknown): Parsed<EnrollmentPollRequest> {
  if (!isRecord(value) || !isUuid(value.enrollmentId)) return fail('enrollmentId')
  return ok({ enrollmentId: value.enrollmentId })
}

export function parseEnrollmentPollResponse(value: unknown): Parsed<EnrollmentPollResponse> {
  if (!isRecord(value)) return fail('body must be an object')
  if (value.status === 'pending' || value.status === 'expired') return ok({ status: value.status })
  if (value.status !== 'approved') return fail('status')
  const label = normalizeLabel(value.label)
  const owner = account(value.owner)
  if (!isUuid(value.hostId)) return fail('hostId')
  if (label === null || label !== value.label) return fail('label')
  if (!owner) return fail('owner')
  return ok({ status: 'approved', hostId: value.hostId, label, owner })
}

export function parseEnrollmentLookupRequest(value: unknown): Parsed<EnrollmentLookupRequest> {
  const code = isRecord(value) ? normalizeUserCode(value.userCode) : null
  return code ? ok({ userCode: code }) : fail('userCode')
}

export function parseEnrollmentLookupResponse(value: unknown): Parsed<EnrollmentLookupResponse> {
  if (!isRecord(value)) return fail('body must be an object')
  if (!isHostname(value.hostname)) return fail('hostname')
  if (!oneOf(PLATFORMS, value.platform)) return fail('platform')
  if (!oneOf(ARCHES, value.arch)) return fail('arch')
  if (!isVersion(value.hostVersion)) return fail('hostVersion')
  if (!isKeyFingerprint(value.keyFingerprint)) return fail('keyFingerprint')
  if (!isIso(value.expiresAt)) return fail('expiresAt')
  return ok({
    hostname: value.hostname,
    platform: value.platform,
    arch: value.arch,
    hostVersion: value.hostVersion,
    keyFingerprint: value.keyFingerprint,
    expiresAt: value.expiresAt,
  })
}

export function parseEnrollmentApproveRequest(value: unknown): Parsed<EnrollmentApproveRequest> {
  if (!isRecord(value)) return fail('body must be an object')
  const code = normalizeUserCode(value.userCode)
  const label = normalizeLabel(value.label)
  if (!code) return fail('userCode')
  if (label === null) return fail('label')
  return ok({ userCode: code, label })
}

export function parseMachineRenameRequest(value: unknown): Parsed<MachineRenameRequest> {
  const label = isRecord(value) ? normalizeLabel(value.label) : null
  return label === null ? fail('label') : ok({ label })
}

export function parseMachineView(value: unknown): Parsed<MachineView> {
  if (!isRecord(value)) return fail('machine must be an object')
  const label = normalizeLabel(value.label)
  if (!isUuid(value.id)) return fail('id')
  if (label === null || label !== value.label) return fail('label')
  if (!isHostname(value.hostname)) return fail('hostname')
  if (!oneOf(PLATFORMS, value.platform)) return fail('platform')
  if (!oneOf(ARCHES, value.arch)) return fail('arch')
  const hostVersion = optional(value.hostVersion, isVersion)
  if (hostVersion === undefined) return fail('hostVersion')
  if (!isKeyFingerprint(value.keyFingerprint)) return fail('keyFingerprint')
  if (!isIso(value.enrolledAt)) return fail('enrolledAt')
  const lastSeenAt = optional(value.lastSeenAt, isIso)
  if (lastSeenAt === undefined) return fail('lastSeenAt')
  const state =
    value.state === null
      ? null
      : oneOf(['running', 'stopping'] as const, value.state)
        ? value.state
        : undefined
  if (state === undefined) return fail('state')
  const ready = value.readiness === null ? null : readiness(value.readiness)
  if (ready === null && value.readiness !== null) return fail('readiness')
  const counts = value.lanes === null ? null : lanes(value.lanes)
  if (counts === null && value.lanes !== null) return fail('lanes')
  const endpoint = optional(value.endpoint, isEndpoint)
  if (endpoint === undefined) return fail('endpoint')
  return ok({
    id: value.id,
    label,
    hostname: value.hostname,
    platform: value.platform,
    arch: value.arch,
    hostVersion,
    keyFingerprint: value.keyFingerprint,
    enrolledAt: value.enrolledAt,
    lastSeenAt,
    state,
    readiness: ready,
    lanes: counts,
    endpoint,
  })
}

export function parseMachinesResponse(value: unknown): Parsed<MachinesResponse> {
  if (!isRecord(value) || !Array.isArray(value.machines)) return fail('machines')
  if (!isIso(value.serverTime)) return fail('serverTime')
  if (value.machines.length > CONTROL_LIMITS.maxHostsPerAccount * 5) return fail('machines')
  const machines: MachineView[] = []
  for (const entry of value.machines) {
    const parsed = parseMachineView(entry)
    if (!parsed.ok) return fail(`machines: ${parsed.reason}`)
    machines.push(parsed.value)
  }
  return ok({ machines, serverTime: value.serverTime })
}

export function parseEnrollmentApproveResponse(value: unknown): Parsed<EnrollmentApproveResponse> {
  if (!isRecord(value)) return fail('body must be an object')
  const machine = parseMachineView(value.machine)
  return machine.ok ? ok({ machine: machine.value }) : fail(`machine: ${machine.reason}`)
}

export function parseMeResponse(value: unknown): Parsed<MeResponse> {
  if (!isRecord(value)) return fail('body must be an object')
  const handle = account(value.account)
  if (!handle) return fail('account')
  if (typeof value.enabled !== 'boolean') return fail('enabled')
  if (!isCount(value.maxHosts, 10_000)) return fail('maxHosts')
  return ok({ account: handle, enabled: value.enabled, maxHosts: value.maxHosts })
}

export function parseHostSelfResponse(value: unknown): Parsed<HostSelfResponse> {
  if (!isRecord(value)) return fail('body must be an object')
  const label = normalizeLabel(value.label)
  const owner = account(value.owner)
  if (!isUuid(value.hostId)) return fail('hostId')
  if (label === null || label !== value.label) return fail('label')
  if (!owner) return fail('owner')
  if (!isIso(value.enrolledAt)) return fail('enrolledAt')
  const lastSeenAt = optional(value.lastSeenAt, isIso)
  if (lastSeenAt === undefined) return fail('lastSeenAt')
  return ok({ hostId: value.hostId, label, owner, enrolledAt: value.enrolledAt, lastSeenAt })
}

export function parseHeartbeatRequest(value: unknown): Parsed<HeartbeatRequest> {
  if (!isRecord(value)) return fail('body must be an object')
  if (!isCount(value.seq, Number.MAX_SAFE_INTEGER) || value.seq < 1) return fail('seq')
  if (!oneOf(['running', 'stopping'] as const, value.state)) return fail('state')
  if (!isVersion(value.hostVersion)) return fail('hostVersion')
  if (!isCount(value.uptimeSec, 10 * 366 * 86_400)) return fail('uptimeSec')
  const ready = readiness(value.readiness)
  if (!ready) return fail('readiness')
  const counts = lanes(value.lanes)
  if (!counts) return fail('lanes')
  const endpoint = optional(value.endpoint, isEndpoint)
  if (endpoint === undefined) return fail('endpoint')
  return ok({
    seq: value.seq,
    state: value.state,
    hostVersion: value.hostVersion,
    uptimeSec: value.uptimeSec,
    readiness: ready,
    lanes: counts,
    endpoint,
  })
}

export function parseHeartbeatResponse(value: unknown): Parsed<HeartbeatResponse> {
  if (!isRecord(value) || value.accepted !== true) return fail('accepted')
  if (!isCount(value.nextInSec, 3600) || value.nextInSec < CONTROL_LIMITS.heartbeatMinSec)
    return fail('nextInSec')
  if (value.epoch !== undefined && (!isCount(value.epoch, 2147483647) || value.epoch < 1))
    return fail('epoch')
  if (value.ownerId !== undefined && !isUuid(value.ownerId)) return fail('ownerId')
  const revoked = value.revoked === undefined ? undefined : parseRevoked(value.revoked)
  if (revoked === null) return fail('revoked')
  return ok({
    accepted: true,
    nextInSec: value.nextInSec,
    ...(value.epoch !== undefined ? { epoch: value.epoch } : {}),
    ...(value.ownerId !== undefined ? { ownerId: value.ownerId } : {}),
    ...(revoked !== undefined ? { revoked } : {}),
  })
}

export function parseHealthResponse(value: unknown): Parsed<HealthResponse> {
  if (!isRecord(value) || value.ok !== true) return fail('ok')
  if (typeof value.version !== 'string' || value.version.length > 100) return fail('version')
  if (typeof value.configured !== 'boolean') return fail('configured')
  return ok({ ok: true, version: value.version, configured: value.configured })
}

/** Own keys only: 'constructor' or 'toString' are not error codes. */
export const isControlErrorCode = (value: unknown): value is ControlErrorCode =>
  typeof value === 'string' && Object.hasOwn(CONTROL_ERROR_STATUS, value)

/** A server error body, or null if the bytes were not one. Messages are capped for display. */
export function parseControlError(value: unknown): ControlErrorBody | null {
  if (!isRecord(value) || !isRecord(value.error)) return null
  const { code, message } = value.error
  if (!isControlErrorCode(code) || typeof message !== 'string') return null
  return { error: { code, message: message.slice(0, 300) } }
}

// ---------------------------------------------------------------------- Status

export type MachineStatus = 'up' | 'down' | 'never-seen'

/**
 * Up or down, judged on the client: the server only records beats, so a
 * machine that stops beating is noticed by the absence of updates.
 * `clockOffsetMs` = serverTime - local time when the list was fetched.
 */
export function machineStatus(
  machine: Pick<MachineView, 'lastSeenAt' | 'state'>,
  nowMs: number,
  clockOffsetMs = 0,
): MachineStatus {
  if (machine.lastSeenAt === null) return 'never-seen'
  if (machine.state !== 'running') return 'down'
  const age = nowMs + clockOffsetMs - Date.parse(machine.lastSeenAt)
  return age <= CONTROL_LIMITS.downAfterSec * 1000 ? 'up' : 'down'
}

// ---------------------------------------------------------- Clients and grants

export function parseClientRegisterRequest(value: unknown): Parsed<ClientRegisterRequest> {
  const label = isRecord(value) ? normalizeLabel(value.label) : null
  return label === null ? fail('label') : ok({ label })
}
export function parseClientRegisterResponse(value: unknown): Parsed<ClientRegisterResponse> {
  if (!isRecord(value) || !isRecord(value.client) || !isUuid(value.client.id)) return fail('client')
  const label = normalizeLabel(value.client.label)
  if (label === null || label !== value.client.label) return fail('label')
  return ok({ client: { id: value.client.id, label } })
}
export function parseGrantIssueRequest(value: unknown): Parsed<GrantIssueRequest> {
  if (!isRecord(value) || !isUuid(value.hostId) || !isUuid(value.clientId)) return fail('ids')
  if (value.configure !== undefined && value.configure !== true) return fail('configure')
  return ok({
    hostId: value.hostId,
    clientId: value.clientId,
    ...(value.configure === true ? { configure: true as const } : {}),
  })
}
export function parseGrantIssueResponse(value: unknown): Parsed<GrantIssueResponse> {
  if (!isRecord(value) || !isRecord(value.host)) return fail('body')
  if (
    typeof value.grant !== 'string' ||
    value.grant.length > GRANT_LIMITS.tokenChars ||
    !value.grant.startsWith(GRANT_PREFIX) ||
    !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{86}$/.test(value.grant.slice(GRANT_PREFIX.length))
  )
    return fail('grant')
  if (!isIso(value.expiresAt)) return fail('expiresAt')
  if (!isUuid(value.host.id) || !isPublicKey(value.host.publicKey)) return fail('host')
  const endpoint = optional(value.host.endpoint, isEndpoint)
  if (endpoint === undefined) return fail('endpoint')
  return ok({
    grant: value.grant,
    expiresAt: value.expiresAt,
    host: { id: value.host.id, endpoint, publicKey: value.host.publicKey },
  })
}
function parseRevoked(value: unknown): HostRevocations['revoked'] | null {
  if (!isRecord(value)) return null
  const lists: string[][] = []
  for (const list of [value.sessions, value.clients]) {
    if (!Array.isArray(list) || list.length > GRANT_LIMITS.revocations) return null
    const ids: string[] = []
    for (const id of list) {
      if (!isUuid(id)) return null
      ids.push(id)
    }
    lists.push(ids)
  }
  const [sessions, clients] = lists
  return sessions && clients ? { sessions, clients } : null
}
export function parseHostRevocations(value: unknown): Parsed<HostRevocations> {
  if (!isRecord(value) || !isUuid(value.ownerId)) return fail('ownerId')
  if (!isCount(value.epoch, 2147483647) || value.epoch < 1) return fail('epoch')
  const revoked = parseRevoked(value.revoked)
  return revoked ? ok({ ownerId: value.ownerId, epoch: value.epoch, revoked }) : fail('revoked')
}
