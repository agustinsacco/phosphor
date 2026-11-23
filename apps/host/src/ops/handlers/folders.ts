import { OpRefusal } from '@phosphor/session-runtime/ops/builtins'
import { dataResult, op, pageOffset } from '@phosphor/session-runtime/ops/results'
import type { OpHandler, OpHandlerContext } from '@phosphor/session-runtime/ops/types'
import type { UndoPorts } from '@phosphor/session-runtime/ops/undo'
import { PAGED_LANES_LIMITS } from '@phosphor/shared/host-protocol-paged-lanes'
import { parseRepositoryOp, type RepositoryOp } from '@phosphor/shared/host-protocol-repositories'
import type { DaemonHandlerDeps } from './index'
import { resourceCall } from './resources-call'

async function change(deps: DaemonHandlerDeps, value: RepositoryOp, ctx: OpHandlerContext) {
  const command = parseRepositoryOp(value)
  if (!command)
    throw new OpRefusal(
      'bad-request',
      'Invalid folder. Use a path relative to home or a listed folder id.',
    )
  if (!deps.repositories) throw new OpRefusal('unavailable', 'Folder changes unavailable.')
  const result = await deps.repositories.execute(command, () => !ctx.signal.aborted)
  if (!result.ok) {
    const { code } = result
    throw new OpRefusal(
      code === 'forbidden' || code === 'busy'
        ? code
        : code === 'too-many-requests'
          ? 'limit'
          : 'bad-request',
      `Folder change refused: ${code}.`,
    )
  }
  return result.data
}
function add(deps: DaemonHandlerDeps, create: boolean) {
  return op<{ path: string }>(async ({ path }, ctx) => {
    if (create) await change(deps, { type: 'host.repositories.createFolder', path }, ctx)
    try {
      const data = await change(deps, { type: 'host.repositories.add', path }, ctx)
      if (!data) throw new Error('No folder returned.')
      return {
        text: `Added ${data.name}. Undo removes it from the list; the folder stays on disk.`,
        data,
        before: { id: data.id },
      }
    } catch (e) {
      if (create)
        throw new Error(
          `Created the folder on disk but could not add it: ${e instanceof Error ? e.message : 'unavailable'}`,
        )
      throw e
    }
  })
}
export function folderUndoCurrent(
  deps: DaemonHandlerDeps,
  entry: Parameters<UndoPorts['isCurrent']>[0],
) {
  const rows = deps.store.listRepositories()
  if (entry.op === 'folder.order')
    return JSON.stringify(rows.map((r) => r.id)) === JSON.stringify(entry.undoRecord.forward?.ids)
  return (
    ['folder.add', 'folder.create'].includes(entry.op) &&
    rows.some((r) => r.id === entry.undoRecord.inverse.args.id)
  )
}
export function folderHandlers(deps: DaemonHandlerDeps): Readonly<Record<string, OpHandler>> {
  return {
    'folder.list': op((_, ctx) => {
      const rows = deps.ownerFolders?.() ?? deps.store.listRepositories()
      const offset = pageOffset(ctx),
        folders = rows.slice(offset, offset + PAGED_LANES_LIMITS.foldersPerPage),
        end = offset + folders.length
      return dataResult({ folders, next: end < rows.length ? String(end) : null })
    }),
    'folder.browse': op<{ path?: string }>(async (args, ctx) =>
      dataResult(await resourceCall(deps, 'machine.folders.list', args, ctx.signal)),
    ),
    'folder.add': add(deps, false),
    'folder.create': add(deps, true),
    'folder.order': op<{ ids: string[] }>(async ({ ids }, ctx) => {
      const before = { ids: deps.store.listRepositories().map((r) => r.id) }
      await change(deps, { type: 'host.repositories.order', repositoryIds: ids }, ctx)
      return { text: 'Reordered folders.', before }
    }),
    'folder.remove': op<{ id: string }>(async ({ id }, ctx) => {
      await change(deps, { type: 'host.repositories.remove', repositoryId: id }, ctx)
      return { text: 'Removed from the list. The folder stays on disk.' }
    }),
  }
}
