import type { ConfirmInfo } from '../ops'
import type { BrainAccess } from '../brain-access'
import type { HostBrainMethod, HostBrainMap } from '../host-brain'
import type { HostBrainRequest } from '../host-brain-request'

/** The token is the view's connection incarnation, not a credential. */
export interface BrainSurfaceScope {
  hostId: string
  connectionToken: string
}

/** Desktop and browser bind the same selected Host, never an implicit local Brain. */
export type BrainApproval = Pick<ConfirmInfo, 'confirmId' | 'title' | 'message' | 'expiresAt'>

export interface BrainSurfacePort {
  access(scope: BrainSurfaceScope, rights: readonly BrainAccess[]): Promise<void>
  approvals(scope: BrainSurfaceScope): Promise<BrainApproval[]>
  answer(scope: BrainSurfaceScope, id: string, approved: boolean): Promise<void>
  invoke<K extends HostBrainMethod>(
    scope: BrainSurfaceScope,
    request: HostBrainRequest<K>,
  ): Promise<HostBrainMap[K]['result']>
}
