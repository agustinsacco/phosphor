import {
  ARTIFACT_LIMITS,
  parseArtifactList,
  type ArtifactMeta,
} from '@phosphor/shared/host-protocol-artifacts'
import { utf8Length } from '@phosphor/shared/host-protocol'
import { machineRecord } from '@phosphor/shared/host-protocol-machine'
import type { OpsRunRequest, OpsRunResult } from '@phosphor/shared/host-protocol-ops'
import { REMOTE_UNAVAILABLE } from './lane-ops'

export type OwnerArtifactOp = (
  req: OpsRunRequest,
) => Promise<Extract<OpsRunResult, { status: 'ok' }>>
export type LibraryItem = ArtifactMeta & { sessionDeleted?: true }
const invalid = () => new Error(REMOTE_UNAVAILABLE)

/** Ops rows additionally have a store key. For a deleted session its id is not a navigable lane. */
function item(raw: unknown): LibraryItem {
  if (!machineRecord(raw) || typeof raw.key !== 'string') throw invalid()
  const { key, sessionDeleted, ...rest } = raw
  const id = key.split('/')[0]
  if (sessionDeleted !== undefined && typeof sessionDeleted !== 'boolean') throw invalid()
  if (sessionDeleted && !rest.laneId) rest.laneId = id
  const parsed = parseArtifactList([rest])?.[0]
  if (!parsed || key !== `${parsed.laneId}/${parsed.slug}`) throw invalid()
  return sessionDeleted ? { ...parsed, sessionDeleted: true } : parsed
}
export async function ownerLibrary(run: OwnerArtifactOp) {
  const rows: LibraryItem[] = []
  const keys = new Set<string>()
  let page: string | undefined,
    bytes = 0
  do {
    const result = await run({ op: 'artifact.list', args: {}, ...(page ? { page } : {}) })
    if (!Array.isArray(result.data) || rows.length + result.data.length > ARTIFACT_LIMITS.count)
      throw invalid()
    for (const raw of result.data) {
      const a = item(raw),
        key = `${a.laneId}/${a.slug}`
      bytes += utf8Length(JSON.stringify(a))
      if (keys.has(key) || bytes > ARTIFACT_LIMITS.metadataBytes) throw invalid()
      rows.push(a)
      keys.add(key)
    }
    page = result.next
    if (page !== undefined && (!result.data.length || page !== String(rows.length))) throw invalid()
  } while (page !== undefined)
  return rows
}
export async function ownerVersion(
  run: OwnerArtifactOp,
  a: LibraryItem,
  v: ArtifactMeta['versions'][number],
) {
  const key = `${a.laneId}/${a.slug}`
  let content = '',
    bytes = 0,
    page: string | undefined
  do {
    const result = await run({
      op: 'artifact.read',
      args: { key, version: v.version },
      ...(page ? { page } : {}),
    })
    const d = result.data
    if (
      !machineRecord(d) ||
      d.key !== key ||
      d.version !== v.version ||
      typeof d.content !== 'string'
    )
      throw invalid()
    bytes += utf8Length(d.content)
    if (bytes > v.bytes) throw invalid()
    content += d.content
    page = result.next
    if (page !== undefined && (!d.content.length || page !== String(content.length)))
      throw invalid()
  } while (page !== undefined)
  return { version: v.version, content }
}
