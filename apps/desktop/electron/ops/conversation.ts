import { OpRefusal } from '@phosphor/session-runtime/ops/builtins'
import { diskLanes, lanePath, liveOpLanes, targetLane } from './lanes'
import { op, pageRows, dataResult, pageOffset } from './results'

const library = async () => (await import('../artifacts/artifact-sync')).artifactLibrary
async function listings() {
  return (await library()).list(liveOpLanes().flatMap((l) => (l.path ? [l.path] : [])))
}
export const conversationHandlers = {
  'lane.list': op<{ folder?: string; state?: string }>(async ({ folder, state }, c) => {
    const lanes = (await diskLanes(folder)).map(({ ref, title, cwd, busy, sessionId }) => ({
      ref,
      title,
      cwd,
      state: busy ? 'busy' : sessionId ? 'idle' : 'stopped',
    }))
    return pageRows(
      lanes.filter((l) => !state || l.state === state),
      c,
    )
  }),
  'lane.read': op<{ part?: string; messages?: number }>(async ({ part, messages = 20 }, c) => {
    const l = targetLane(c)
    if (part === 'messages')
      return pageRows(
        await (await import('../pi/session-scanner')).readSavedTranscript(lanePath(c)),
        c,
        messages,
      )
    if (part === 'artifacts')
      return pageRows(
        (await listings()).filter((a) => a.sessionFile === lanePath(c)),
        c,
      )
    if (part === 'debug')
      return dataResult({ ref: l.ref, cwd: l.cwd, running: !!l.sessionId, busy: l.busy })
    const meta =
      l.meta ??
      (await (await import('../pi/session-scanner')).listSessions(l.cwd)).find(
        (m) => m.path === l.path,
      )
    return dataResult(
      part === 'prs'
        ? (meta?.pullRequests ?? {})
        : { ref: l.ref, title: l.title, cwd: l.cwd, meta },
    )
  }),
  'archive.list': op<{ measure?: boolean }>(async ({ measure }) => {
    const result = await (await import('../archive/state')).localArchives().inventory.list(measure)
    return dataResult(result)
  }),
  'artifact.list': op<{ lane?: string }>(async ({ lane }, c) =>
    pageRows(
      (await listings()).filter((a) => !lane || a.sessionFile === lanePath(c)),
      c,
    ),
  ),
  'artifact.read': op<{ key: string; lane?: string; version?: number }>(
    async ({ key, lane, version }, c) => {
      const found = await (await library()).read(key)
      if (!found || (lane && found.listing.sessionFile !== lanePath(c)))
        throw new OpRefusal('bad-request', 'Artifact not found.')
      const row = found.artifact.versions.find(
        (v) => v.version === (version ?? found.listing.version),
      )
      if (!row) throw new OpRefusal('bad-request', 'Version not found.')
      const start = pageOffset(c)
      let end = Math.min(start + 12 * 1024, row.content.length)
      if (/[\uD800-\uDBFF]/.test(row.content.charAt(end - 1))) end--
      const content = row.content.slice(start, end)
      return {
        ...dataResult({ key, version: row.version, title: row.title, content }),
        ...(end < row.content.length ? { next: String(end) } : {}),
      }
    },
  ),
}
