/** Wire compatibility is independent of the desktop and daemon release versions. */
export const HOST_PROTOCOL_VERSION = 1

export const HOST_CAPABILITIES = [
  'sessions.read',
  'sessions.control',
  'workspaces.read',
  'workspaces.write',
  'artifacts.read',
  'skills.read',
  'terminal',
  'routines',
  'machine.configure',
] as const

/** Keep the legacy grant array consumable by old Hosts. New authority is opt-in. */
export const LEGACY_HOST_CAPABILITIES = HOST_CAPABILITIES.filter(
  (cap) => cap !== 'machine.configure',
)

export type HostCapability = (typeof HOST_CAPABILITIES)[number]

/** Local execution remains independent of host enrollment and cloud login. */
export type HostTarget =
  { readonly kind: 'local' } | { readonly kind: 'remote'; readonly hostId: string }

export type HostResourceKind = 'workspace' | 'session' | 'pty' | 'artifact'

export interface HostHello {
  hostId: string
  hostVersion: string
  protocolVersion: typeof HOST_PROTOCOL_VERSION
  /** Changes whenever the daemon restarts; never use it as a durable lane ID. */
  runtimeEpoch: string
  /** Feature availability only, never an authorization decision. */
  capabilities: HostCapability[]
}

export type HostHelloResult =
  | { ok: true; hello: HostHello }
  | { ok: false; reason: 'invalid-handshake' | 'unsupported-protocol' | 'host-mismatch' }

const identifier = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const knownCapabilities = new Set<string>(HOST_CAPABILITIES)

function isIdentifier(value: unknown): value is string {
  return typeof value === 'string' && value === value.trim() && identifier.test(value)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/**
 * Validate an authenticated host's hello against its enrolled identity.
 * This is shape/compatibility checking, NOT token or host-key verification.
 * Unknown additive fields and capabilities are ignored for rolling upgrades.
 * Transport adapters must separately limit the incoming frame's byte size.
 */
export function validateHostHello(value: unknown, expectedHostId: string): HostHelloResult {
  if (
    !isIdentifier(expectedHostId) ||
    !isRecord(value) ||
    !isIdentifier(value.hostId) ||
    !isIdentifier(value.runtimeEpoch) ||
    typeof value.hostVersion !== 'string' ||
    value.hostVersion !== value.hostVersion.trim() ||
    !/^[A-Za-z0-9][A-Za-z0-9.+_-]{0,127}$/.test(value.hostVersion) ||
    typeof value.protocolVersion !== 'number' ||
    !Number.isSafeInteger(value.protocolVersion) ||
    value.protocolVersion < 1 ||
    !Array.isArray(value.capabilities) ||
    value.capabilities.length > 64 ||
    !value.capabilities.every(isIdentifier)
  ) {
    return { ok: false, reason: 'invalid-handshake' }
  }
  if (value.hostId !== expectedHostId) return { ok: false, reason: 'host-mismatch' }
  if (value.protocolVersion !== HOST_PROTOCOL_VERSION)
    return { ok: false, reason: 'unsupported-protocol' }

  return {
    ok: true,
    hello: {
      hostId: value.hostId,
      hostVersion: value.hostVersion,
      protocolVersion: HOST_PROTOCOL_VERSION,
      runtimeEpoch: value.runtimeEpoch,
      capabilities: [...new Set(value.capabilities)].filter(
        (capability): capability is HostCapability => knownCapabilities.has(capability),
      ),
    },
  }
}

/**
 * A client projection key, not a disk path, credential, or live-process ID.
 * Keep remote IDs opaque: path normalization belongs to the execution host.
 * A tuple avoids delimiter collisions and isolates identically named resources
 * on different hosts. Existing local store keys are not migrated by this helper.
 */
export function hostResourceKey(
  target: HostTarget,
  kind: HostResourceKind,
  resourceId: string,
): string {
  if (target.kind === 'remote' && !isIdentifier(target.hostId)) {
    throw new Error('Invalid host ID')
  }
  if (!resourceId || resourceId.length > 4096) throw new Error('Invalid resource ID')
  return JSON.stringify([
    target.kind,
    target.kind === 'remote' ? target.hostId : null,
    kind,
    resourceId,
  ])
}
