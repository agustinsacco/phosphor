import type { KeyObject } from 'node:crypto'
import {
  isIsoTime,
  isUuid,
  parseEnrollmentCreateResponse,
  parseHostSelfResponse,
} from '@phosphor/shared/control-api'
import type { HostIdentity, PendingEnrollment } from './identity-types'
import { publicIdentity } from './signer'
import { isControlUrl } from './url'

/** Every identity refusal the CLI shows. `incomplete` is metadata whose key could not be used. */
export class IdentityFailure extends Error {
  constructor(
    message: string,
    readonly incomplete?: HostIdentity,
  ) {
    super(message)
  }
}

export const unsafeIdentity = () =>
  new IdentityFailure(
    'Unsafe identity storage. Use files owned by you, no symlinks, chmod 600 host-key.*.pem host.json and chmod 700 identity.',
  )
const invalidIdentity = () =>
  new IdentityFailure('Invalid identity. Run phosphor logout --local, then phosphor setup.')
export const incompleteIdentity = (identity: HostIdentity) =>
  new IdentityFailure(
    'Identity incomplete. Use an owned regular key, no symlink, chmod 600 host-key.*.pem; run phosphor setup.',
    identity,
  )

export function parsePending(value: unknown): PendingEnrollment {
  if (
    value === null ||
    typeof value !== 'object' ||
    !('version' in value) ||
    value.version !== 1 ||
    !('controlUrl' in value) ||
    !isControlUrl(value.controlUrl) ||
    !('savedAt' in value) ||
    !isIsoTime(value.savedAt)
  )
    throw new IdentityFailure('Invalid pending enrollment.')
  const parsed = parseEnrollmentCreateResponse(value)
  if (!parsed.ok) throw new IdentityFailure('Invalid pending enrollment.')
  return { version: 1, controlUrl: value.controlUrl, savedAt: value.savedAt, ...parsed.value }
}

export function parseIdentity(value: unknown): HostIdentity {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !('version' in value) ||
    value.version !== 1 ||
    !('controlUrl' in value) ||
    !isControlUrl(value.controlUrl) ||
    !('savedAt' in value) ||
    !isIsoTime(value.savedAt) ||
    !('ownerLogin' in value)
  )
    throw invalidIdentity()
  const parsed = parseHostSelfResponse({
    ...value,
    owner: { login: value.ownerLogin },
    enrolledAt: value.savedAt,
    lastSeenAt: null,
  })
  if (!parsed.ok) throw invalidIdentity()
  return {
    version: 1,
    controlUrl: value.controlUrl,
    hostId: parsed.value.hostId,
    label: parsed.value.label,
    ownerLogin: parsed.value.owner.login,
    savedAt: value.savedAt,
  }
}

/** host.json text as an identity: malformed JSON and a bad shape are the same refusal. */
export function parseIdentityText(text: string): HostIdentity {
  try {
    const value: unknown = JSON.parse(text)
    return parseIdentity(value)
  } catch {
    throw invalidIdentity()
  }
}

/** The key file an identity names. Parsed host ids are UUIDs, so the name cannot escape. */
export const keyFileName = (hostId: string) => `host-key.${hostId}.pem`

/** Cleanup removes only host-key.<uuid>.pem: never pending-key.pem or another name. */
export const isHostKeyFile = (name: string) => isUuid(/^host-key\.(.+)\.pem$/.exec(name)?.[1])

export const exportKeyPem = (key: KeyObject) =>
  key.export({ type: 'pkcs8', format: 'pem' }).toString()

/** A pending key belongs to its enrollment when the fingerprints agree. */
export const pendingKeyMatches = (enrollment: PendingEnrollment, key: KeyObject) =>
  publicIdentity(key).keyFingerprint === enrollment.keyFingerprint

/**
 * Reuse only an identical orphan left by a crash before the commit point: byte
 * for byte the PEM this key exports, and no host.json yet. `committed` is
 * asked only once the bytes match; its own errors pass through.
 */
export async function assertReusableOrphan(
  stored: string,
  pem: string,
  committed: () => Promise<boolean>,
): Promise<void> {
  if (stored !== pem) throw unsafeIdentity()
  if (await committed()) throw unsafeIdentity()
}

/** A cancelled save removes the key it wrote, but never once host.json committed it. */
export const discardsUncommittedKey = (save: {
  written: boolean
  committed: boolean
  aborted: boolean
}) => save.written && !save.committed && save.aborted

/** Save reports its own refusals as they are and anything else as one retry hint. */
export const saveFailure = (error: unknown) =>
  error instanceof IdentityFailure
    ? error
    : new IdentityFailure('Identity save failed. Run phosphor status before retrying.')
