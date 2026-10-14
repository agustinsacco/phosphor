import { utf8Length } from './host-protocol'
import { machineRecord } from './host-protocol-machine'

export const ARTIFACT_LIMITS = {
  count: 2000,
  metadataBytes: 4 * 1024 * 1024,
  versions: 1000,
  contentBytes: 2 * 1024 * 1024,
  callVersions: 1000,
  callBytes: 8 * 1024 * 1024,
  sessionBytes: 32 * 1024 * 1024,
} as const
export interface ArtifactMeta {
  laneId: string
  slug: string
  title: string
  type: string
  language?: string
  versions: { version: number; title: string; createdAt: number; bytes: number }[]
}
const uuid = (v: unknown): v is string =>
  typeof v === 'string' &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(v)
const text = (v: unknown, max: number): v is string =>
  typeof v === 'string' && v.length <= max && !v.includes('\0')
const slug = (v: unknown): v is string => text(v, 200) && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(v)
const integer = (v: unknown): v is number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= 0
const keys = (v: Record<string, unknown>, allowed: string[]) =>
  Object.keys(v).every((k) => allowed.includes(k))
export function parseArtifactParams(
  method: string,
  v: unknown,
): {
  laneId?: string
  slug?: string
  version?: number
} | null {
  if (!machineRecord(v)) return null
  if (method === 'artifacts.list') {
    if (!keys(v, ['laneId']) || (v.laneId !== undefined && !uuid(v.laneId))) return null
    return typeof v.laneId === 'string' ? { laneId: v.laneId } : {}
  }
  if (
    method !== 'artifacts.read' ||
    !keys(v, ['laneId', 'slug', 'version']) ||
    !uuid(v.laneId) ||
    !slug(v.slug) ||
    (v.version !== undefined && (!integer(v.version) || v.version < 1))
  )
    return null
  return {
    laneId: v.laneId,
    slug: v.slug,
    ...(typeof v.version === 'number' ? { version: v.version } : {}),
  }
}
export function parseArtifactList(v: unknown): ArtifactMeta[] | null {
  if (!Array.isArray(v) || v.length > ARTIFACT_LIMITS.count) return null
  const result: ArtifactMeta[] = []
  let bytes = 0
  const seen = new Set<string>()
  for (const a of v) {
    if (
      !machineRecord(a) ||
      !keys(a, ['laneId', 'slug', 'title', 'type', 'language', 'versions']) ||
      !uuid(a.laneId) ||
      !slug(a.slug) ||
      !text(a.title, 1000) ||
      !text(a.type, 32) ||
      (a.language !== undefined && !text(a.language, 100)) ||
      !Array.isArray(a.versions) ||
      a.versions.length === 0 ||
      a.versions.length > ARTIFACT_LIMITS.versions
    )
      return null
    const key = `${a.laneId}/${a.slug}`
    if (seen.has(key)) return null
    seen.add(key)
    const versions: ArtifactMeta['versions'] = []
    let previous = 0
    for (const v of a.versions) {
      if (
        !machineRecord(v) ||
        !keys(v, ['version', 'title', 'createdAt', 'bytes']) ||
        !integer(v.version) ||
        v.version <= previous ||
        !text(v.title, 1000) ||
        !integer(v.createdAt) ||
        !integer(v.bytes) ||
        v.bytes > ARTIFACT_LIMITS.contentBytes
      )
        return null
      previous = v.version
      versions.push({ version: v.version, title: v.title, createdAt: v.createdAt, bytes: v.bytes })
    }
    const parsed: ArtifactMeta = {
      laneId: a.laneId,
      slug: a.slug,
      title: a.title,
      type: a.type,
      ...(typeof a.language === 'string' ? { language: a.language } : {}),
      versions,
    }
    bytes += utf8Length(JSON.stringify(parsed))
    if (bytes > ARTIFACT_LIMITS.metadataBytes) return null
    result.push(parsed)
  }
  return result
}
export function parseArtifactRead(v: unknown): { version: number; content: string } | null {
  if (
    !machineRecord(v) ||
    !keys(v, ['version', 'content']) ||
    !integer(v.version) ||
    v.version < 1 ||
    typeof v.content !== 'string' ||
    utf8Length(v.content) > ARTIFACT_LIMITS.contentBytes
  )
    return null
  return { version: v.version, content: v.content }
}
