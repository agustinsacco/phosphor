import type { ArtifactListing, ArtifactSnapshot } from '@shared/artifacts'
import {
  ARTIFACT_LIMITS,
  parseArtifactList,
  parseArtifactRead,
  parseArtifactParams,
  type ArtifactMeta,
} from '@shared/host-protocol-artifacts'
import type { HostCapability } from '@shared/remote-host'
import type { HostFrame } from '@shared/host-protocol'
import { utf8Length } from '@shared/host-protocol'
import { REMOTE_UNAVAILABLE } from './lane-ops'
import type { ReadLane } from './read-features'

export interface ArtifactHost {
  hostId: string
  label: string
  call(method: string, params: unknown): Promise<unknown>
}
interface ArtifactConnection {
  snapshot(): { state: string; capabilities: HostCapability[] }
  call(method: string, params: unknown): Promise<Extract<HostFrame, { type: 'result' }>>
}
export function createArtifactHost(
  hostId: string,
  label: string,
  c: ArtifactConnection,
  current: () => ArtifactConnection | undefined,
): ArtifactHost {
  const available = () =>
    current() === c &&
    c.snapshot().state === 'ready' &&
    c.snapshot().capabilities.includes('artifacts.read')
  return {
    hostId,
    label,
    async call(method, params) {
      const parsed = parseArtifactParams(method, params)
      if (!parsed || !available()) throw new Error(REMOTE_UNAVAILABLE)
      try {
        const result = await c.call(method, parsed)
        if (!available() || !result.ok) throw new Error(REMOTE_UNAVAILABLE)
        return result.data
      } catch {
        throw new Error(REMOTE_UNAVAILABLE)
      }
    },
  }
}
function listing(host: ArtifactHost, a: ArtifactMeta): ArtifactListing {
  const latest = a.versions.at(-1)
  if (!latest) throw new Error(REMOTE_UNAVAILABLE)
  const session = `host:${host.hostId}/lane:${a.laneId}`
  return {
    key: `${session}/artifact:${a.slug}`,
    sessionId: session,
    id: a.slug,
    sessionFile: session,
    cwd: session,
    title: a.title,
    type: a.type,
    language: a.language,
    version: latest.version,
    versionCount: a.versions.length,
    updatedAt: latest.createdAt,
    revision: `${session}/${a.slug}/${latest.version}`,
    sessionDeleted: false,
    workspaceExists: false,
    machine: host.label,
  }
}
async function list(host: ArtifactHost, laneId?: string) {
  const data = parseArtifactList(await host.call('artifacts.list', laneId ? { laneId } : {}))
  if (!data || (laneId && data.some((a) => a.laneId !== laneId)))
    throw new Error(REMOTE_UNAVAILABLE)
  return data
}
async function snapshots(host: ArtifactHost, items: ArtifactMeta[]): Promise<ArtifactSnapshot[]> {
  let bytes = 0
  const result: ArtifactSnapshot[] = []
  if (items.reduce((sum, a) => sum + a.versions.length, 0) > ARTIFACT_LIMITS.callVersions)
    throw new Error(REMOTE_UNAVAILABLE)
  // Check declared sizes before sending any content calls, then count actual UTF-8 bytes too.
  if (
    items.reduce((sum, a) => sum + a.versions.reduce((s, v) => s + v.bytes, 0), 0) >
    ARTIFACT_LIMITS.callBytes
  )
    throw new Error(REMOTE_UNAVAILABLE)
  for (const a of items) {
    const versions: ArtifactSnapshot['versions'] = []
    for (const v of a.versions) {
      const read = parseArtifactRead(
        await host.call('artifacts.read', { laneId: a.laneId, slug: a.slug, version: v.version }),
      )
      if (!read || read.version !== v.version || utf8Length(read.content) !== v.bytes)
        throw new Error(REMOTE_UNAVAILABLE)
      bytes += utf8Length(read.content)
      if (bytes > ARTIFACT_LIMITS.callBytes) throw new Error(REMOTE_UNAVAILABLE)
      versions.push({
        version: v.version,
        title: v.title,
        createdAt: v.createdAt,
        content: read.content,
      })
    }
    result.push({ id: a.slug, title: a.title, type: a.type, language: a.language, versions })
  }
  return result
}
export async function remoteSessionArtifacts(lane: ReadLane): Promise<ArtifactSnapshot[]> {
  const host: ArtifactHost = {
    hostId: '',
    label: '',
    call: (method, params) => lane.call('artifacts.read', method, params),
  }
  return snapshots(host, await list(host, lane.laneId))
}
export async function remoteArtifactListings(hosts: ArtifactHost[]): Promise<ArtifactListing[]> {
  const rows: ArtifactListing[] = []
  for (const host of hosts) {
    rows.push(...(await list(host)).map((a) => listing(host, a)))
    if (rows.length > ARTIFACT_LIMITS.count) throw new Error(REMOTE_UNAVAILABLE)
  }
  return rows
}
export async function remoteArtifactRead(key: string, hosts: ArtifactHost[]) {
  const match = /^host:([^/]+)\/lane:([^/]+)\/artifact:([a-z0-9-]+)$/.exec(key)
  const host = hosts.find((h) => h.hostId === match?.[1])
  if (!host || !match?.[2]) throw new Error(REMOTE_UNAVAILABLE)
  const a = (await list(host, match[2])).find((a) => a.slug === match[3])
  if (!a) return null
  const artifact = (await snapshots(host, [a]))[0]
  return artifact ? { listing: listing(host, a), artifact } : null
}
