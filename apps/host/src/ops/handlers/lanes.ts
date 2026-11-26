import { requestPage } from '@phosphor/session-runtime/ops/ports'
import { OPS_LIMITS } from '@phosphor/shared/host-protocol-ops'
import { OpRefusal } from '@phosphor/session-runtime/ops/builtins'
import {
  op,
  dataResult,
  pageInventory,
  pageLimit,
  rowTime,
  surfaceInventory,
} from '@phosphor/session-runtime/ops/results'
import type { OpHandlerContext, OpHandlerResult } from '@phosphor/session-runtime/ops/types'
import { PAGED_LANES_LIMITS } from '@phosphor/shared/host-protocol-paged-lanes'
import { matchesLaneState } from '@phosphor/shared/host-protocol/lanes'
import { laneRefFor } from '../lane-ref'
import type { DaemonHandlerDeps } from './index'
import { artifactList, contentPage } from './artifacts'
import { archiveCommand } from './archives'
import { laneChange } from './lane-undo'
import { laneId, laneCall, commandClient, laneCommand } from './lane-ports'
import { afterLaneSettles } from '../binding'
import { folderFilter, MODEL_HINT, requireFolder } from './lane-folder'

const jobs = new Set([
  'lane.create',
  'lane.resume',
  'lane.archive',
  'lane.delete',
  'archive.restore',
])
export function laneJob(name: string, self: boolean) {
  return jobs.has(name) && !(name === 'lane.archive' && self)
}
type Filter = { folder?: string; state?: string; q?: string }
function listLanes(deps: DaemonHandlerDeps, { folder, state, q }: Filter, c: OpHandlerContext) {
  const rows = deps.daemonLanes
    .list()
    .filter(
      (l) =>
        (!folder || l.repositoryId === folder || l.cwd === folder) &&
        matchesLaneState(l.activity, state) &&
        (!q ||
          [l.laneId, l.title, l.cwd, l.branch].some((s) =>
            s?.toLowerCase().includes(q.toLowerCase()),
          )),
    )
  return pageInventory(
    rows.map((l) => ({ ...l, ref: laneRefFor(deps.selfIds(), l.laneId) })),
    c,
    {
      ref: (l) => l.ref,
      title: (l) => l.title,
      state: (l) => l.activity,
      branch: (l) => l.branch,
      updated: (l) => rowTime(l.updatedAt),
    },
    {
      surface: { limit: PAGED_LANES_LIMITS.lanesPerPage, shrink: true },
      wrap: (lanes, next) => ({ lanes, next: next ?? null }),
    },
  )
}
async function readLane(
  deps: DaemonHandlerDeps,
  { part, messages = 20 }: { part?: string; messages?: number },
  c: OpHandlerContext,
) {
  const id = laneId(deps, c)
  if (part === 'artifacts') return artifactList(deps, id, c)
  if (part === 'messages') {
    const result = (await laneCall(deps, 'lane.messages', { laneId: id }, c)) as {
      messages: unknown[]
    }
    return messagePage(result.messages, surfaceInventory(c) ? messages : pageLimit(c, messages), c)
  }
  if (part === 'debug') return dataResult(await laneCall(deps, 'lane.state', { laneId: id }, c))
  const summary = deps.daemonLanes.summary(id)
  return dataResult(part === 'prs' ? (summary?.pullRequests ?? {}) : summary)
}

type Create = {
  folder: string
  worktree?: string
  fresh?: boolean
  name?: string
  model?: string
  thinking?: string
  prompt?: string
}
async function create(deps: DaemonHandlerDeps, a: Create, c: OpHandlerContext) {
  if (a.fresh && !a.worktree)
    throw new OpRefusal('bad-request', '--fresh needs --worktree <branch>.')
  const repo = requireFolder(deps.store.listRepositories(), a.folder)
  const slash = a.model?.indexOf('/') ?? -1
  const client = commandClient(c)
  const receipt = await laneCommand(deps, client, {
    type: 'lane.create',
    repositoryId: repo.id,
    worktree: a.worktree ? { branch: a.worktree, ...(a.fresh ? { fresh: true } : {}) } : null,
    name: a.name,
    model: slash < 0 ? a.model : a.model?.slice(slash + 1),
    provider: slash < 0 ? undefined : a.model?.slice(0, slash),
    thinkingLevel: a.thinking,
  }).catch((error: unknown) => {
    // pi resolves a bare ID only sometimes, and the Host keeps start failures generic.
    if (error instanceof OpRefusal && a.model && slash < 0)
      throw new OpRefusal(error.code, `${error.message} ${MODEL_HINT}`)
    throw error
  })
  const id = receipt.laneId
  if (!id || !receipt.fence) throw new OpRefusal('unavailable', 'Creation returned no lane.')
  const target = { laneId: id, fence: receipt.fence }
  try {
    deps.recordCreator(id, c.principal)
    if (a.prompt) await laneCommand(deps, client, { type: 'prompt', message: a.prompt }, target)
  } catch (error) {
    throw new Error(`Created ${id}, but initialization failed: ${String(error)}`, { cause: error })
  } finally {
    if (c.principal.kind !== 'surface')
      await laneCommand(deps, client, { type: 'control.release' }, target)
  }
  return laneChange(deps, id, `Created ${id}.`, { ref: id })
}

async function lifecycle(
  deps: DaemonHandlerDeps,
  kind: 'stop' | 'archive' | 'delete' | 'resume',
  c: OpHandlerContext,
  a: { removeWorktree?: boolean; removeBranch?: boolean } = {},
) {
  const id = laneId(deps, c),
    initial = deps.daemonLanes.summary(id),
    services = deps.management
  if (!initial || !services) throw new OpRefusal('unavailable', 'Lane services unavailable.')
  const self = c.principal.kind === 'agent' && c.lane?.sessionId === c.principal.sessionId
  const allowed = () => {
    const lane = deps.daemonLanes.summary(id)
    // Archive/delete also check after their own stop/tombstone. A removed lane has no summary.
    return (
      !c.signal.aborted &&
      (!lane ||
        (lane.control.fence === (c.lane?.controlFence ?? initial.control.fence) &&
          lane.activity !== 'working' &&
          lane.activity !== 'needs-input'))
    )
  }
  const change = async (): Promise<OpHandlerResult> => {
    if (!allowed()) throw new OpRefusal('busy', 'Lane control changed or a turn is running.')
    if (kind === 'archive')
      await archiveCommand(deps, { type: 'lane.archive', laneId: id }, allowed)
    if (kind === 'stop') {
      if (!deps.daemonLanes.sessionFor(id)) return { text: 'Already stopped.', undo: false }
      await services.stopLane(id, allowed)
    }
    if (kind === 'resume') {
      if (deps.daemonLanes.sessionFor(id)) return { text: 'Already running.', undo: false }
      const row = deps.store.getLane(id)
      if (!row || row.removedAt !== null)
        throw new OpRefusal('bad-request', 'Lane is no longer available.')
      if (!services.admitsResume(id)) throw new OpRefusal('busy', 'The machine is paused.')
      await services.resumeLane(row)
    }
    if (kind === 'delete') {
      const result = await services.deleteLane?.(
        {
          type: 'lane.delete',
          laneId: id,
          removeWorktree: a.removeWorktree ?? false,
          removeBranch: a.removeBranch ?? false,
        },
        allowed,
        c.principal.kind === 'surface' && c.principal.via === 'owner',
      )
      if (!result?.ok)
        throw new OpRefusal('unavailable', `Delete refused: ${result?.code ?? 'unsupported'}.`)
      return { text: `Deleted ${id}.`, data: result.data }
    }
    return laneChange(
      deps,
      id,
      `Completed lane.${kind} for ${id}.`,
      kind === 'archive' ? { id } : { ref: id },
    )
  }
  if (self && (kind === 'stop' || kind === 'archive'))
    return afterLaneSettles({ kind }, id, c.lane!.sessionId!, deps.daemonLanes, change)
  return change()
}
export function laneHandlers(deps: DaemonHandlerDeps) {
  const repos = () => deps.store.listRepositories()
  return {
    'lane.list': op<Filter>((a, c) => listLanes(deps, folderFilter(repos(), a), c)),
    'lane.search': op<Filter>((a, c) => listLanes(deps, folderFilter(repos(), a), c)),
    'lane.read': op<{ part?: string; messages?: number }>((a, c) => readLane(deps, a, c)),
    'lane.export': op(async (_, c) => {
      const result = (await laneCall(deps, 'lane.exportHtml', { laneId: laneId(deps, c) }, c)) as {
        html: string
      }
      return contentPage(result.html, { format: 'html' }, c)
    }),
    'lane.create': op<Create>((a, c) => create(deps, a, c)),
    'lane.resume': op((_, c) => lifecycle(deps, 'resume', c)),
    'lane.stop': op((_, c) => lifecycle(deps, 'stop', c)),
    'lane.archive': op((_, c) => lifecycle(deps, 'archive', c)),
    'lane.delete': op<{ removeWorktree?: boolean; removeBranch?: boolean }>((a, c) =>
      lifecycle(deps, 'delete', c, a),
    ),
    'lane.markRead': op(async (_, c) => {
      const id = laneId(deps, c),
        upTo = deps.daemonLanes.summary(id)?.attention
      if (upTo === undefined) throw new OpRefusal('bad-request', 'Lane not found.')
      await laneCommand(deps, commandClient(c), { type: 'lane.markRead', upTo }, { laneId: id })
      return { text: `Marked ${id} read.` }
    }),
  }
}

/** A huge message is still readable: offset identifies the message and a UTF-16 cursor inside its JSON. */
function messagePage(rows: unknown[], count: number, c: OpHandlerContext) {
  const token = requestPage(c) ?? '0'
  const match = /^(\d{1,15})(?:_(\d{1,15}))?$/.exec(token)
  if (!match) throw new OpRefusal('bad-request', 'Invalid message page.')
  const start = Number(match[1]),
    offset = Number(match[2] ?? 0)
  const tool = c.principal.kind === 'agent' || c.principal.kind === 'machine'
  const limit = tool ? 2000 : OPS_LIMITS.callDataBytes
  let end = start
  let bytes = 2
  for (; end < Math.min(rows.length, start + count); end++) {
    const size = Buffer.byteLength(JSON.stringify(rows[end])) + 1
    if (bytes + size > limit) break
    bytes += size
  }
  if (start < rows.length && (end === start || offset)) {
    const chunk = contentPage(
      JSON.stringify(rows[start]),
      { message: start, format: 'json' },
      c,
      offset,
    )
    const next = chunk.next
      ? `${start}_${chunk.next}`
      : start + 1 < rows.length
        ? String(start + 1)
        : undefined
    return { ...chunk, next }
  }
  const data = rows.slice(start, end)
  return { ...dataResult(data), ...(end < rows.length ? { next: String(end) } : {}) }
}
