/**
 * Control-plane wire constants: the API version and routes, request limits,
 * trace headers and error statuses. Reached through `../control-api`.
 */

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
  /** GET, user: who the control plane thinks you are. DELETE: delete the account. */
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
  /** POST, anonymous, native origin only: the daily usage ping. */
  usagePing: `${CONTROL_API_PREFIX}/usage/ping`,
  /** GET, the one administrator, app origin only: aggregate counts. */
  adminStats: `${CONTROL_API_PREFIX}/admin/stats`,
} as const

/** PATCH {label} renames, DELETE revokes. User-authenticated. */
export function machineRoute(machineId: string): string {
  return `${CONTROL_ROUTES.machines}/${machineId}`
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
