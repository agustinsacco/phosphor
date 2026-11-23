import { basename } from 'node:path'
import type { LiveSession } from '@phosphor/session-runtime/pi/session-registry'
import type { LaneFacts, OpHandlerContext } from '@phosphor/session-runtime/ops/types'
import { OpRefusal } from '@phosphor/session-runtime/ops/builtins'
import type { BrainOpsPort } from '@phosphor/session-runtime/ops/types'
import type { SessionMeta } from '@shared/models'

interface Entry {
  session: LiveSession
  title: string
  unattended: boolean
  brain?: BrainOpsPort
}
const entries = new Map<string, Entry>()
export const localLaneRef = (id: string) => `local/session:${id}`
export function rememberOpLane(
  session: LiveSession,
  title: string | undefined,
  unattended: boolean,
) {
  entries.set(session.sessionId, {
    session,
    title: title || basename(session.workspacePath),
    unattended,
  })
  return () => {
    entries.delete(session.sessionId)
  }
}
export const liveOpLane = (id: string) => entries.get(id)
export const liveOpLanes = () => Array.from(entries.values()).map((e) => liveFacts(e))
export interface DesktopLane extends LaneFacts {
  path?: string
  meta?: SessionMeta
}
function liveFacts({ session, title }: Entry): DesktopLane {
  return {
    ref: localLaneRef(session.sessionId),
    sessionId: session.sessionId,
    title,
    cwd: session.workspacePath,
    busy: session.client.activity.busy,
    controller: null,
    path: session.client.sessionFile,
  }
}
export function resolveLiveLane(ref: string): DesktopLane | null {
  const entry = entries.get(ref.replace(/^local\/session:/, ''))
  return entry ? liveFacts(entry) : null
}
export function targetLane(ctx: OpHandlerContext): DesktopLane {
  if (!ctx.lane) throw new OpRefusal('bad-request', 'Name a local lane.')
  return ctx.lane
}
export function lanePath(ctx: OpHandlerContext) {
  const path = targetLane(ctx).path
  if (!path) throw new OpRefusal('unavailable', 'This lane has no saved conversation yet.')
  return path
}
export function projectFolders(cwd?: string) {
  return import('../store').then(({ getPrefs }) =>
    Array.from(
      new Set([
        ...getPrefs().recentWorkspaces.map((w) => w.path),
        ...Array.from(entries.values(), (e) => e.session.workspacePath),
        ...(cwd ? [cwd] : []),
      ]),
    ),
  )
}
export async function diskLanes(folder?: string): Promise<DesktopLane[]> {
  const folders = await projectFolders()
  if (folder && !folders.includes(folder))
    throw new OpRefusal('bad-request', 'Unknown local workspace.')
  const { listSessions } = await import('../pi/session-scanner')
  const live = liveOpLanes()
  const byPath = new Map(live.map((l) => [l.path, l]))
  const result = new Map<string, DesktopLane>()
  for (const cwd of folder ? [folder] : folders)
    for (const meta of await listSessions(cwd)) {
      const lane = byPath.get(meta.path) ?? {
        ref: localLaneRef(meta.sessionId),
        sessionId: null,
        cwd,
        title: meta.name || meta.firstUserText?.slice(0, 120) || basename(cwd),
        busy: false,
        controller: null,
        path: meta.path,
      }
      result.set(lane.ref, { ...lane, meta })
    }
  for (const l of live)
    if ((!folder || l.cwd === folder) && !result.has(l.ref)) result.set(l.ref, l)
  return [...result.values()]
}
export async function findDiskLane(ref: string) {
  return (
    (await diskLanes()).find((l) => l.ref === ref || l.meta?.sessionId === ref || l.path === ref) ??
    null
  )
}
