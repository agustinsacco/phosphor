/** The lanes topic: control, summaries, repositories, lane lists, deltas and attention. */
import { isIsoTime, isUuid } from '../control-api'
import { isLaneMarker } from '../host-protocol-lane-marks'
import { HOST_LIMITS } from './constants'
import type { HostFrame } from './frames'
import type { LaneControl, LaneSummary, RepositorySummary } from './lanes'
import {
  cursor,
  frameId,
  hex,
  integer,
  isLaneBranchName,
  label,
  member,
  record,
  text,
} from './primitives'

type Frame<T extends HostFrame['type']> = Extract<HostFrame, { type: T }>

export function parseLaneControl(v: unknown): LaneControl | null {
  if (!record(v) || !integer(v.fence, 1)) return null
  if (v.controller === null) return { fence: v.fence, controller: null }
  const c = v.controller
  return record(c) && isUuid(c.clientId) && label(c.label) && typeof c.connected === 'boolean'
    ? {
        fence: v.fence,
        controller: { clientId: c.clientId, label: c.label, connected: c.connected },
      }
    : null
}

/** A lane's summary; its read counter can never pass its attention counter. */
export function parseLaneSummary(v: unknown): LaneSummary | null {
  if (!record(v)) return null
  const c = parseLaneControl(v.control)
  if (
    !isUuid(v.laneId) ||
    !hex(v.repositoryId) ||
    !text(v.cwd, HOST_LIMITS.outboundFrameBytes) ||
    (v.title !== null && !label(v.title)) ||
    (v.branch !== null && !isLaneBranchName(v.branch)) ||
    typeof v.worktree !== 'boolean' ||
    (v.model !== null &&
      (!record(v.model) || !text(v.model.provider, 200) || !text(v.model.id, 200))) ||
    !member(v.activity, ['stopped', 'idle', 'working', 'needs-input', 'failed']) ||
    !isIsoTime(v.createdAt) ||
    !isIsoTime(v.updatedAt) ||
    !integer(v.attention) ||
    !integer(v.read) ||
    v.read > v.attention ||
    !c
  )
    return null
  return {
    laneId: v.laneId,
    repositoryId: v.repositoryId,
    cwd: v.cwd,
    title: v.title,
    branch: v.branch,
    worktree: v.worktree,
    model:
      record(v.model) && text(v.model.provider, 200) && text(v.model.id, 200)
        ? { provider: v.model.provider, id: v.model.id }
        : null,
    activity: v.activity,
    createdAt: v.createdAt,
    updatedAt: v.updatedAt,
    attention: v.attention,
    read: v.read,
    control: c,
    // Additive marks: an invalid one is dropped, never the whole summary.
    ...(v.pinned === true ? { pinned: true as const } : {}),
    ...(isLaneMarker(v.marker) ? { marker: v.marker } : {}),
  }
}

/** At most `max` items, each parsed; null when the list or any item is invalid. */
export function boundedList<T>(
  v: unknown,
  max: number,
  parse: (item: unknown) => T | null,
): T[] | null {
  if (!Array.isArray(v) || v.length > max) return null
  const out: T[] = []
  for (const item of v) {
    const p = parse(item)
    if (p === null) return null
    out.push(p)
  }
  return out
}

function repository(v: unknown): RepositorySummary | null {
  return record(v) &&
    hex(v.id) &&
    text(v.name, HOST_LIMITS.outboundFrameBytes) &&
    text(v.path, HOST_LIMITS.outboundFrameBytes) &&
    (v.git === undefined || typeof v.git === 'boolean')
    ? { id: v.id, name: v.name, path: v.path, ...(v.git === undefined ? {} : { git: v.git }) }
    : null
}

export function parseLanesFrame(v: Record<string, unknown>): Frame<'lanes'> | null {
  const c = cursor(v.cursor),
    r = boundedList(v.repositories, HOST_LIMITS.repositoriesPerHost, repository),
    l = boundedList(v.lanes, HOST_LIMITS.lanesPerHost, parseLaneSummary)
  return frameId(v.id) && c && r && l
    ? { type: 'lanes', id: v.id, cursor: c, repositories: r, lanes: l }
    : null
}

export function parseLanesDeltaFrame(v: Record<string, unknown>): Frame<'lanes-delta'> | null {
  const c = cursor(v.cursor, 1),
    u = boundedList(v.upsert, HOST_LIMITS.lanesPerHost, parseLaneSummary),
    r = boundedList(v.remove, HOST_LIMITS.lanesPerHost, (x) => (isUuid(x) ? x : null))
  return frameId(v.id) && c && u && r
    ? { type: 'lanes-delta', id: v.id, cursor: c, upsert: u, remove: r }
    : null
}

/** The one lanes-topic frame with an exact key set: any other key refuses it. */
export function parseRoutinesChangedFrame(
  v: Record<string, unknown>,
): Frame<'routines-changed'> | null {
  const c = cursor(v.cursor, 1)
  return frameId(v.id) && c && Object.keys(v).every((key) => ['type', 'id', 'cursor'].includes(key))
    ? { type: 'routines-changed', id: v.id, cursor: c }
    : null
}

/** An attention event's id is `${laneId}:${attention}`, the same on every surface. */
export function parseAttentionFrame(v: Record<string, unknown>): Frame<'attention'> | null {
  const c = cursor(v.cursor, 1),
    e = v.event
  if (
    !frameId(v.id) ||
    !c ||
    !record(e) ||
    !isUuid(e.laneId) ||
    !integer(e.attention, 1) ||
    e.id !== `${e.laneId}:${e.attention}` ||
    !member(e.kind, ['finished', 'needs-input', 'failed', 'routine-finished', 'routine-paused']) ||
    !isIsoTime(e.at) ||
    (e.title !== null && !label(e.title))
  )
    return null
  return {
    type: 'attention',
    id: v.id,
    cursor: c,
    event: {
      id: e.id,
      laneId: e.laneId,
      kind: e.kind,
      attention: e.attention,
      at: e.at,
      title: e.title,
    },
  }
}
