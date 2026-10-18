import type { KeyObject } from 'node:crypto'
import type { rename } from 'node:fs/promises'
import type { EnrollmentCreateResponse } from '@phosphor/shared/control-api'

/** host.json: the committed enrollment. Its key lives in host-key.<hostId>.pem. */
export interface HostIdentity {
  version: 1
  controlUrl: string
  hostId: string
  label: string
  ownerLogin: string | null
  savedAt: string
}

/** pending.json: an enrollment that is waiting for approval, with pending-key.pem. */
export interface PendingEnrollment extends EnrollmentCreateResponse {
  version: 1
  controlUrl: string
  savedAt: string
}

/** The rename every publication goes through, injectable so tests can interrupt it. */
export interface IdentityPorts {
  rename: typeof rename
}

/** One identity directory, the uid that must own it, and its ports. */
export interface IdentityLocation {
  directory: string
  uid: number | undefined
  ports: IdentityPorts
}

export interface LoadedIdentity {
  identity: HostIdentity
  key: KeyObject
}

export interface LoadedPending {
  enrollment: PendingEnrollment
  key: KeyObject
}
