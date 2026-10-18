import type { AttachmentOp } from '@phosphor/shared/host-protocol-attachments'
import {
  createAttachmentState,
  type AttachmentOwner,
  type AttachmentPorts,
} from './attachments/state'
import { abort, close, directory, remove, startSweep, sweep } from './attachments/storage'
import { execute } from './attachments/upload'

/** State directories are private, not a sandbox against the machine's owner.
 * Node has no portable openat; ancestor swaps by the same user remain possible.
 */
export function createAttachments(ports: AttachmentPorts) {
  const state = createAttachmentState(ports)
  directory(state.root)
  directory(state.temporary)
  startSweep(state)
  return {
    abort: (laneId: string) => abort(state, laneId),
    remove: (laneId: string) => remove(state, laneId),
    sweep: () => sweep(state),
    close: () => close(state),
    execute: (owner: AttachmentOwner, input: AttachmentOp) => execute(state, owner, input),
  }
}
export type HostAttachments = ReturnType<typeof createAttachments>
