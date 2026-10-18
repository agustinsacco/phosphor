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
 *
 * This entry names every public export of the private modules in
 * ./control-api/; parser helpers stay private to those modules.
 */

export {
  CONTROL_API_PREFIX,
  CONTROL_API_VERSION,
  DEFAULT_CONTROL_URL,
} from './control-api/constants'
export { CONTROL_ERROR_STATUS, CONTROL_LIMITS, CONTROL_ROUTES } from './control-api/constants'
export { CONTROL_TRACE_HEADERS, isControlClient, isControlTrace } from './control-api/constants'
export { machineRoute } from './control-api/constants'
export type { ControlErrorBody, ControlErrorCode } from './control-api/constants'

export { HOST_HEADERS, HOST_SIGNATURE_SCHEME, hostSigningString } from './control-api/signing'
export { isNonce, isPublicKey, isSha256Hex, isSignature } from './control-api/signing'
export { parseTimestamp, withinSkew } from './control-api/signing'
export { formatKeyFingerprint, isKeyFingerprint } from './control-api/signing'
export type { HostSigningInput } from './control-api/signing'

export { USER_CODE_ALPHABET, USER_CODE_LENGTH, userCodeFromBytes } from './control-api/codes'
export { formatUserCode, normalizeUserCode } from './control-api/codes'

export { ARCHES, PLATFORMS } from './control-api/types'
export type { AccountHandle, Arch, LaneCounts, MachineState } from './control-api/types'
export type { Platform, Readiness } from './control-api/types'
export type { EnrollmentApproveRequest, EnrollmentApproveResponse } from './control-api/types'
export type { EnrollmentCreateRequest, EnrollmentCreateResponse } from './control-api/types'
export type { EnrollmentLookupRequest, EnrollmentLookupResponse } from './control-api/types'
export type { EnrollmentPollRequest, EnrollmentPollResponse } from './control-api/types'
export type { MachineRenameRequest, MachinesResponse, MachineView } from './control-api/types'
export type { HeartbeatRequest, HeartbeatResponse, HostSelfResponse } from './control-api/types'
export type { HealthResponse, MeResponse } from './control-api/types'
export type { ClientRegisterRequest, ClientRegisterResponse } from './control-api/types'
export type { GrantIssueRequest, GrantIssueResponse, HostRevocations } from './control-api/types'

export { isEndpoint, isHostname, isIsoTime, isUuid, isVersion } from './control-api/fields'
export { normalizeLabel } from './control-api/fields'
export type { Parsed } from './control-api/fields'

export {
  parseEnrollmentCreateRequest,
  parseEnrollmentCreateResponse,
} from './control-api/enrollment'
export { parseEnrollmentPollRequest, parseEnrollmentPollResponse } from './control-api/enrollment'
export {
  parseEnrollmentLookupRequest,
  parseEnrollmentLookupResponse,
} from './control-api/enrollment'
export {
  parseEnrollmentApproveRequest,
  parseEnrollmentApproveResponse,
} from './control-api/enrollment'

export { parseMachineRenameRequest, parseMachineView } from './control-api/machines'
export { parseMachinesResponse, parseMeResponse } from './control-api/machines'
export { parseHostSelfResponse } from './control-api/machines'
export { parseHeartbeatRequest, parseHeartbeatResponse } from './control-api/machines'

export { parseClientRegisterRequest, parseClientRegisterResponse } from './control-api/grants'
export { parseGrantIssueRequest, parseGrantIssueResponse } from './control-api/grants'
export { parseHostRevocations } from './control-api/grants'

export { isControlErrorCode, parseControlError, parseHealthResponse } from './control-api/status'
export { machineStatus } from './control-api/status'
export type { MachineStatus } from './control-api/status'
