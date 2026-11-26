import type { FileRead } from '@phosphor/shared/host-protocol-files'
import type { FileWriteOp } from '@phosphor/shared/host-protocol-writes'
import { OpRefusal } from '@phosphor/session-runtime/ops/builtins'
import { dataResult, op, pageInventory } from '@phosphor/session-runtime/ops/results'
import type { OpHandler } from '@phosphor/session-runtime/ops/types'
import type { WriteOutcome } from '../../features/writes'
import type { DaemonHandlerDeps } from './index'
import { laneCall, refusal, targetLane } from './lane-target'

/** The Host's file writes in a lane's folder: the same guards as a surface's edits. */
export interface DaemonFileWrites {
  execute(laneId: string, op: FileWriteOp): Promise<WriteOutcome>
}

type Path = { path: string }

/** Under `path`, or the whole lane for `.` or an empty path. */
function under(files: readonly string[], path: string): string[] {
  const folder = path.replace(/^\.\/?/, '').replace(/\/+$/, '')
  return folder === ''
    ? [...files]
    : files.filter((f) => f === folder || f.startsWith(`${folder}/`))
}

/**
 * Files in a lane's folder, read and changed through the Host's own file
 * feature and writes, so the same path guards and size limits apply.
 * `files.mkdir` is a directory `files.create`; `files.trash` is the Host's
 * `files.delete`, which moves the entry to the trash.
 */
export function fileHandlers(deps: DaemonHandlerDeps): Readonly<Record<string, OpHandler>> {
  const write = async (laneId: string, change: FileWriteOp, done: string) => {
    if (!deps.writes) throw new OpRefusal('unavailable', 'This machine does not change files yet.')
    const outcome = await deps.writes.execute(laneId, change)
    if (!outcome.ok) throw refusal(outcome.code)
    return { text: done, ...(outcome.data !== undefined ? { data: outcome.data } : {}) }
  }
  return {
    'files.list': op<Path>(async ({ path }, ctx) => {
      const { laneId } = targetLane(ctx)
      const listed = (await laneCall(deps.lanes, 'files.list', { laneId })) as { files: string[] }
      return pageInventory(under(listed.files, path), ctx, { path: (p) => p })
    }),
    'files.read': op<Path>(async ({ path }, ctx) => {
      const { laneId } = targetLane(ctx)
      const read = (await laneCall(deps.lanes, 'files.read', { laneId, path })) as FileRead
      const result = dataResult(read)
      if (read.binary) return { ...result, text: `${path} is binary (${read.size} bytes).` }
      return { ...result, text: read.content === '' ? `${path} is empty.` : read.content }
    }),
    'files.write': op<Path & { content?: string; expected: string | null }>(
      ({ path, content, expected }, ctx) =>
        write(
          targetLane(ctx).laneId,
          { type: 'files.write', path, content: content ?? '', expected },
          `Wrote ${path}.`,
        ),
    ),
    'files.create': op<Path & { content?: string }>(({ path, content }, ctx) => {
      const { laneId } = targetLane(ctx)
      // A new file with a body is a write that expects no file there.
      return content
        ? write(laneId, { type: 'files.write', path, content, expected: null }, `Created ${path}.`)
        : write(laneId, { type: 'files.create', path, kind: 'file' }, `Created ${path}.`)
    }),
    'files.mkdir': op<Path>(({ path }, ctx) =>
      write(
        targetLane(ctx).laneId,
        { type: 'files.create', path, kind: 'directory' },
        `Created folder ${path}.`,
      ),
    ),
    'files.trash': op<Path>(({ path }, ctx) =>
      write(targetLane(ctx).laneId, { type: 'files.delete', path }, `Moved ${path} to the trash.`),
    ),
    'files.rename': op<{ from: string; to: string }>(({ from, to }, ctx) =>
      write(
        targetLane(ctx).laneId,
        { type: 'files.rename', from, to },
        `Renamed ${from} to ${to}.`,
      ),
    ),
    'files.transfer': op<{ source: string; directory: string; mode: 'copy' | 'move' }>(
      ({ source, directory, mode }, ctx) =>
        write(
          targetLane(ctx).laneId,
          { type: 'files.transfer', source, directory, mode },
          `${mode === 'copy' ? 'Copied' : 'Moved'} ${source} into ${directory}.`,
        ),
    ),
  }
}
