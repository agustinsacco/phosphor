import { OpRefusal } from '@phosphor/session-runtime/ops/builtins'
import { op, pageOffset, pageRows } from '@phosphor/session-runtime/ops/results'
import type { OpHandlerContext } from '@phosphor/session-runtime/ops/types'
import { OPS_LIMITS } from '@phosphor/shared/host-protocol-ops'
import { parseArtifactList, parseArtifactRead } from '@phosphor/shared/host-protocol-artifacts'
import { laneCall, laneId } from './lane-ports'
import type { DaemonHandlerDeps } from './index'

/** Bound the serialized data (escaping counts), without splitting a Unicode character. */
export function contentPage(
  content: string,
  fields: Record<string, unknown>,
  c: OpHandlerContext,
  start = pageOffset(c),
) {
  if (start > content.length || /[\uDC00-\uDFFF]/.test(content.charAt(start)))
    throw new OpRefusal('bad-request', 'Invalid content offset.')
  const tool = c.principal.kind === 'agent' || c.principal.kind === 'machine'
  const limit = tool ? 16 * 1024 - 2500 : OPS_LIMITS.callDataBytes
  let low = start,
    high = Math.min(content.length, start + limit)
  while (low < high) {
    const mid = Math.ceil((low + high) / 2)
    const json = JSON.stringify(
      { ...fields, content: content.slice(start, mid) },
      null,
      tool ? 2 : undefined,
    )
    // pi-extensions marks these results untrusted and HTML-escapes the displayed JSON.
    const bytes = Buffer.byteLength(json) + (tool ? (json.match(/["&<>]/g)?.length ?? 0) * 5 : 0)
    if (bytes <= limit) low = mid
    else high = mid - 1
  }
  if (low < content.length && /[\uD800-\uDBFF]/.test(content.charAt(low - 1))) low--
  if (low === start && low < content.length)
    throw new OpRefusal('too-large', 'Result metadata is too large.')
  const data = { ...fields, content: content.slice(start, low) }
  return {
    text: tool ? JSON.stringify(data) : `Read ${low - start} characters.`,
    data,
    ...(low < content.length ? { next: String(low) } : {}),
  }
}
export async function artifactList(
  deps: DaemonHandlerDeps,
  id: string | undefined,
  c: OpHandlerContext,
) {
  const items = parseArtifactList(
    await laneCall(deps, 'artifacts.list', id ? { laneId: id } : {}, c),
  )
  if (!items) throw new OpRefusal('unavailable', 'Invalid artifact list.')
  return pageRows(
    items.map((a) => ({ ...a, key: `${a.laneId}/${a.slug}` })),
    c,
  )
}
export function artifactHandlers(deps: DaemonHandlerDeps) {
  return {
    'artifact.list': op<{ lane?: string }>(({ lane }, c) =>
      artifactList(deps, lane ? laneId(deps, c) : undefined, c),
    ),
    'artifact.read': op<{ key: string; lane?: string; version?: number }>(
      async ({ key, lane, version }, c) => {
        const parts = key.split('/')
        const id = parts.length === 2 ? parts[0] : laneId(deps, c)
        if (parts.length > 2 || (lane && id !== laneId(deps, c)))
          throw new OpRefusal('bad-request', 'Artifact key does not belong to this lane.')
        const result = parseArtifactRead(
          await laneCall(deps, 'artifacts.read', { laneId: id, slug: parts.at(-1), version }, c),
        )
        if (!result) throw new OpRefusal('unavailable', 'Invalid artifact response.')
        return contentPage(result.content, { key, version: result.version }, c)
      },
    ),
  }
}
