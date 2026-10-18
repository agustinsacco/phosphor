import { parseFileWriteOp, type FileWriteOp } from '@phosphor/shared/host-protocol-writes'
import { filesystemCode } from '@phosphor/session-runtime/files/mutations'
import type { RejectCode } from '@phosphor/shared/host-protocol'
import type { FeatureContext } from './feature'
import { laneRoot } from './files'
import { WriteFailure } from './writes/guards'
import { writeText } from './writes/text'
import { createEntry, renameEntry, transferEntry } from './writes/entries'
import { trashEntry } from './writes/trash'

export { mutationPath } from './writes/guards'

export type WriteOutcome = { ok: true; data?: unknown } | { ok: false; code: RejectCode }
export function createWrites(context: FeatureContext) {
  return {
    capabilityFor(type: string) {
      return type.startsWith('files.') &&
        ['files.write', 'files.create', 'files.rename', 'files.delete', 'files.transfer'].includes(
          type,
        )
        ? ('workspaces.write' as const)
        : null
    },
    async execute(laneId: string, input: FileWriteOp): Promise<WriteOutcome> {
      const op = parseFileWriteOp(input)
      if (!op) return { ok: false, code: 'bad-request' }
      try {
        const root = await laneRoot(context, laneId)
        switch (op.type) {
          case 'files.write':
            return { ok: true, data: await writeText(root, op) }
          case 'files.create':
            await createEntry(root, op)
            break
          case 'files.rename':
            await renameEntry(root, op)
            break
          case 'files.transfer':
            return { ok: true, data: await transferEntry(root, op) }
          case 'files.delete':
            await trashEntry(context, root, op.path)
        }
        return { ok: true }
      } catch (error) {
        return {
          ok: false,
          code:
            error instanceof WriteFailure
              ? error.code
              : filesystemCode(error) === 'EEXIST'
                ? 'conflict'
                : 'bad-request',
        }
      }
    },
  }
}
