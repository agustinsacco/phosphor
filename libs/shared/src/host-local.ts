/**
 * The machine's local socket: the credential a same-user client presents on it,
 * where the socket lives, the daemon's sidecar files and the grant shape Desktop
 * builds for its own daemon. Pure: hashing, signing and file IO stay at each edge.
 *
 *   phosphor-local.v1.<base64url(payload JSON bytes)>.<base64url(signature) | "">
 *
 * An `owner` credential is signed with a key whose public half `setup --local`
 * wrote to `owner-clients.json`; a `local` one is unsigned. The TCP listener
 * refuses this prefix and the socket refuses `phosphor-grant.`. The client takes
 * a fresh nonce from `GET /v1/hello` on the socket before it builds each one.
 *
 * Living contract: docs/remote-protocol.md ("The local socket").
 */
import {
  isPublicKey,
  isUuid,
  isVersion,
  normalizeLabel,
  type GrantIssueResponse,
  type Parsed,
} from './control-api'
import {
  GRANT_LIMITS,
  decodeBase64url,
  encodeBase64url,
  grantUtf8,
  grantUtf8Decode,
} from './host-grant'
import { integer, record, utf8Length } from './host-protocol/primitives'
import { keys } from './machine-settings-fields'

export const LOCAL_CREDENTIAL_PREFIX = 'phosphor-local.v1.'

export const LOCAL_LIMITS = {
  /** UTF-8 bytes. macOS `sun_path` holds 104 with the terminator; Linux 108. */
  socketPathBytes: 103,
  nonceTtlMs: 60_000,
  noncesOutstanding: 64,
  iatSkewSec: 60,
  grantTtlSec: 300,
  ownerClients: 8,
} as const

/** `GrantIssueResponse.host.endpoint` for a machine's own socket; never a network address. */
export const LOCAL_ENDPOINT_PREFIX = 'phosphor-local:'
export const localEndpoint = (machineId: string): string => `${LOCAL_ENDPOINT_PREFIX}${machineId}`
export const isLocalEndpoint = (v: unknown): v is string =>
  typeof v === 'string' &&
  v.startsWith(LOCAL_ENDPOINT_PREFIX) &&
  isUuid(v.slice(LOCAL_ENDPOINT_PREFIX.length))

export interface LocalCredentialPayload {
  readonly v: 1
  readonly kind: 'owner' | 'local'
  /** Must equal the daemon's `local-identity.json` machineId. */
  readonly machineId: string
  readonly client: { readonly id: string; readonly label: string }
  /** 64 lowercase hex, single use, from the socket's hello. */
  readonly nonce: string
  /** Unix seconds. */
  readonly iat: number
  /** `local` only: the caller's PI_SESSION_ID. Attribution and a downgrade, never authority. */
  readonly lane?: string
}

function fail<T>(reason: string): Parsed<T> {
  return { ok: false, reason }
}

function payload(v: unknown): Parsed<LocalCredentialPayload> {
  if (
    !record(v) ||
    v.v !== 1 ||
    !keys(v, ['v', 'kind', 'machineId', 'client', 'nonce', 'iat', 'lane'])
  )
    return fail('version')
  if (v.kind !== 'owner' && v.kind !== 'local') return fail('kind')
  if (!isUuid(v.machineId)) return fail('machine')
  if (
    !record(v.client) ||
    !isUuid(v.client.id) ||
    typeof v.client.label !== 'string' ||
    normalizeLabel(v.client.label) !== v.client.label
  )
    return fail('client')
  if (typeof v.nonce !== 'string' || !/^[0-9a-f]{64}$/.test(v.nonce)) return fail('nonce')
  if (!integer(v.iat) || v.iat > 253402300799) return fail('time')
  if (
    v.lane !== undefined &&
    (v.kind !== 'local' || typeof v.lane !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(v.lane))
  )
    return fail('lane')
  return {
    ok: true,
    value: {
      v: 1,
      kind: v.kind,
      machineId: v.machineId,
      client: { id: v.client.id, label: v.client.label },
      nonce: v.nonce,
      iat: v.iat,
      ...(v.lane !== undefined ? { lane: v.lane } : {}),
    },
  }
}

/** Signs an owner credential; a local credential is encoded unsigned. Throws on an invalid payload. */
export function encodeLocalCredential(
  p: LocalCredentialPayload,
  sign?: (bytes: Uint8Array) => Uint8Array,
): string {
  const parsed = payload(p)
  if (!parsed.ok) throw new Error('Invalid local credential payload')
  if ((parsed.value.kind === 'owner') !== (sign !== undefined))
    throw new Error('An owner credential is signed; a local one is not')
  const bytes = grantUtf8(JSON.stringify(parsed.value))
  const signature = sign ? sign(bytes) : null
  if (signature && signature.length !== 64) throw new Error('Invalid local credential signature')
  const token = `${LOCAL_CREDENTIAL_PREFIX}${encodeBase64url(bytes)}.${signature ? encodeBase64url(signature) : ''}`
  if (token.length > GRANT_LIMITS.tokenChars) throw new Error('Local credential too large')
  return token
}

/** Shape only: the daemon still checks the signature, machine id, nonce and iat. */
export function parseLocalCredential(token: string): Parsed<{
  payload: LocalCredentialPayload
  payloadBytes: Uint8Array
  signature: Uint8Array | null
}> {
  if (token.length > GRANT_LIMITS.tokenChars || !token.startsWith(LOCAL_CREDENTIAL_PREFIX))
    return fail('token')
  const parts = token.slice(LOCAL_CREDENTIAL_PREFIX.length).split('.')
  if (parts.length !== 2 || !parts[0] || parts[1] === undefined) return fail('parts')
  const bytes = decodeBase64url(parts[0])
  const signature = parts[1] === '' ? null : decodeBase64url(parts[1])
  if (!bytes || (parts[1] !== '' && signature?.length !== 64)) return fail('encoding')
  let value: unknown
  try {
    value = JSON.parse(grantUtf8Decode(bytes))
  } catch {
    return fail('payload')
  }
  const parsed = payload(value)
  if (!parsed.ok) return parsed
  if ((parsed.value.kind === 'owner') !== (signature !== null)) return fail('signature')
  return { ok: true, value: { payload: parsed.value, payloadBytes: bytes, signature } }
}

/** The nonce a socket hello carries beside `hello` and `proof`, or null. */
export function localHelloNonce(v: unknown): string | null {
  return record(v) && typeof v.nonce === 'string' && /^[0-9a-f]{64}$/.test(v.nonce) ? v.nonce : null
}

/** What Desktop's grant port returns for its own daemon (`host.publicKey` is the raw Ed25519 key). */
export function localGrantIssueResponse(i: {
  machineId: string
  credential: string
  expiresAt: string
  publicKey: string
}): GrantIssueResponse {
  return {
    grant: i.credential,
    expiresAt: i.expiresAt,
    host: { id: i.machineId, endpoint: localEndpoint(i.machineId), publicKey: i.publicKey },
  }
}

const trimmed = (path: string): string => path.replace(/\/+$/, '') || '/'

/** Socket paths in order of preference. Pick one with `chooseLocalSocket` before binding. */
export function localSocketCandidates(i: {
  platform: 'darwin' | 'linux'
  stateDir: string
  runtimeDir?: string
  uid: number
  /** First 16 hex of SHA-256 over the state folder's path. */
  stateHash16: string
}): string[] {
  const out: string[] = []
  if (i.platform === 'linux' && i.runtimeDir?.startsWith('/'))
    out.push(`${trimmed(i.runtimeDir)}/phosphor-host/phosphor.sock`)
  out.push(`${trimmed(i.stateDir)}/run/phosphor.sock`)
  out.push(`/tmp/phosphor-${i.uid}/${i.stateHash16}.sock`)
  return out
}

/**
 * The first candidate within `socketPathBytes` UTF-8 bytes. Node 22 silently
 * truncates a longer path at bind and Node 24 throws, so measure first.
 */
export function chooseLocalSocket(candidates: readonly string[]): string | null {
  return candidates.find((path) => utf8Length(path) <= LOCAL_LIMITS.socketPathBytes) ?? null
}

/** POSIX `path.join` without Node: segments joined by `/`, then `.` and `..` resolved. */
function joinPosix(...segments: string[]): string {
  const joined = segments.filter((s) => s.length > 0).join('/')
  if (!joined) return '.'
  const absolute = joined.startsWith('/')
  const out: string[] = []
  for (const part of joined.split('/')) {
    if (part === '' || part === '.') continue
    if (part !== '..') out.push(part)
    else if (out.length && out[out.length - 1] !== '..') out.pop()
    else if (!absolute) out.push('..')
  }
  return (absolute ? '/' : '') + out.join('/') || (absolute ? '/' : '.')
}

type HostEnv = Readonly<Record<string, string | undefined>>

/** An XDG base folder; a relative value is ignored, as the XDG spec asks. */
function xdgBase(value: string | undefined, home: string, fallback: string): string {
  return value?.startsWith('/') ? value : joinPosix(home, fallback)
}

/**
 * `${XDG_CONFIG_HOME:-~/.config}/phosphor-host`, on Linux and macOS alike: the
 * folder of `config.json` and the sidecars beside it (`local-identity.json`).
 */
export function hostConfigDirectory(env: HostEnv, home: string): string {
  return joinPosix(xdgBase(env.XDG_CONFIG_HOME, home, '.config'), 'phosphor-host')
}

/** `${XDG_STATE_HOME:-~/.local/state}/phosphor-host`, on Linux and macOS alike (`local.json`). */
export function hostStateDirectory(env: HostEnv, home: string): string {
  return joinPosix(xdgBase(env.XDG_STATE_HOME, home, '.local/state'), 'phosphor-host')
}

/** `<state>/local.json`: written once the socket accepts connections. */
export interface LocalRunFile {
  version: 1
  pid: number
  hostVersion: string
  machineId: string
  socket: string
  startedAt: number
  localReadyAt: number
}
/** `<config>/local-mode.json`: the marker that makes a Host a machine's local daemon. */
export interface LocalModeFile {
  version: 1
  enabledAt: string
  shellEnvironment: boolean
}
/** `<config>/local-identity.json`, beside `local-key.pem` (0600). */
export interface LocalIdentityFile {
  version: 1
  machineId: string
  createdAt: string
  /** The local Ed25519 key's raw public half, base64url (JWK `x`). */
  publicKey: string
}
/** `<config>/owner-clients.json` (0600): public keys only, written by `setup --local`. */
export interface OwnerClientsFile {
  version: 1
  clients: { id: string; label: string; publicKey: string; addedAt: string }[]
}

export const HOST_SIDECARS = {
  localMode: 'local-mode.json',
  ownerClients: 'owner-clients.json',
  localIdentity: 'local-identity.json',
  localKey: 'local-key.pem',
  agentPolicy: 'agent-policy.json',
  folders: 'folders.json',
  localRun: 'local.json',
  standby: 'owner-standby.json',
  updateResult: 'update-result.json',
  headroom: 'headroom.json',
  appServices: 'app-services.json',
  /** In the state folder: where Claude account metadata lives when it is not `<state>/claude-accounts`. */
  claudeAccounts: 'claude-accounts.json',
} as const

/**
 * The Host's per-user service names: `~/Library/LaunchAgents/<HOST_AGENT>.plist` on macOS and
 * `<XDG_CONFIG_HOME>/systemd/user/<HOST_UNIT>` on Linux. Desktop reads them to spot a source Host.
 */
export const HOST_AGENT = 'com.saccolabs.phosphor-host'
export const HOST_UNIT = 'phosphor-host.service'

/** In pi's agent folder; held by whichever of Desktop and the daemon owns the machine's lanes. */
export const OWNER_LOCK_FILE = '.phosphor-owner.lock'

export function parseLocalRunFile(v: unknown): LocalRunFile | null {
  return record(v) &&
    v.version === 1 &&
    integer(v.pid, 1) &&
    isVersion(v.hostVersion) &&
    isUuid(v.machineId) &&
    typeof v.socket === 'string' &&
    v.socket.startsWith('/') &&
    utf8Length(v.socket) <= LOCAL_LIMITS.socketPathBytes &&
    integer(v.startedAt) &&
    integer(v.localReadyAt)
    ? {
        version: 1,
        pid: v.pid,
        hostVersion: v.hostVersion,
        machineId: v.machineId,
        socket: v.socket,
        startedAt: v.startedAt,
        localReadyAt: v.localReadyAt,
      }
    : null
}

export function parseLocalIdentityFile(v: unknown): LocalIdentityFile | null {
  return record(v) &&
    v.version === 1 &&
    isUuid(v.machineId) &&
    typeof v.createdAt === 'string' &&
    isPublicKey(v.publicKey)
    ? { version: 1, machineId: v.machineId, createdAt: v.createdAt, publicKey: v.publicKey }
    : null
}

/** Null when the file or any entry is invalid, or it lists more than `ownerClients`. */
export function parseOwnerClientsFile(v: unknown): OwnerClientsFile | null {
  if (!record(v) || v.version !== 1 || !Array.isArray(v.clients)) return null
  if (v.clients.length > LOCAL_LIMITS.ownerClients) return null
  const clients: OwnerClientsFile['clients'] = []
  for (const c of v.clients) {
    if (
      !record(c) ||
      !isUuid(c.id) ||
      typeof c.label !== 'string' ||
      normalizeLabel(c.label) !== c.label ||
      !isPublicKey(c.publicKey) ||
      typeof c.addedAt !== 'string' ||
      clients.some((known) => known.id === c.id)
    )
      return null
    clients.push({ id: c.id, label: c.label, publicKey: c.publicKey, addedAt: c.addedAt })
  }
  return { version: 1, clients }
}
