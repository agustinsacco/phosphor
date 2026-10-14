import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { join } from 'node:path'
import { isUtf8 } from 'node:buffer'
import {
  indexSessionFile,
  writeIndex,
  blobFile,
  type SessionArtifactIndex,
} from '@phosphor/session-runtime/artifacts/artifact-indexer'
import {
  ARTIFACT_LIMITS,
  parseArtifactParams,
  parseArtifactList,
  type ArtifactMeta,
} from '@phosphor/shared/host-protocol-artifacts'
import { utf8Length } from '@phosphor/shared/host-protocol'
import { hostStateDirectory } from '../lanes/state-dir'
import { FeatureFailure, featureError } from './machine'
import type { HostStore } from '../lanes/store'
import type { FeatureContext, HostFeature } from './feature'

export function createArtifactsFeature(
  context: FeatureContext & { store: FeatureContext['store'] & Pick<HostStore, 'listLanes'> },
): HostFeature {
  const root = join(hostStateDirectory(context.env, context.home), 'artifacts')
  let pending = 0
  let tail = Promise.resolve()
  function admitted(laneId: string): boolean {
    const lane = context.store.getLane(laneId)
    return !!lane && lane.removedAt === null
  }
  function requireLane(laneId: string): void {
    if (!admitted(laneId)) throw new FeatureFailure('unknown-lane')
  }
  async function index(laneId: string): Promise<SessionArtifactIndex | null> {
    const lane = context.store.getLane(laneId)
    if (!lane || lane.removedAt !== null) throw new FeatureFailure('unknown-lane')
    if (!lane.sessionFile) return null
    const saved = await indexSessionFile(root, lane.sessionFile, null, ARTIFACT_LIMITS.sessionBytes)
    if (saved) await writeIndex(root, saved)
    return saved
  }
  return {
    capability: 'artifacts.read',
    methods: ['artifacts.list', 'artifacts.read'],
    async call(method, params) {
      const parsed = parseArtifactParams(method, params)
      if (!parsed) return featureError(new FeatureFailure('bad-request'))
      // One active call plus eight FIFO waiters. Call errors have no busy code.
      if (pending >= 9) return featureError(new FeatureFailure('internal'))
      pending++
      const previous = tail
      let release = () => {}
      tail = new Promise<void>((resolve) => {
        release = resolve
      })
      await previous
      try {
        if (method === 'artifacts.list') {
          const lanes = parsed.laneId
            ? [parsed.laneId]
            : context.store
                .listLanes()
                .filter((l) => l.removedAt === null)
                .map((l) => l.laneId)
          if (lanes.length > ARTIFACT_LIMITS.count) throw new FeatureFailure('too-large')
          const items: ArtifactMeta[] = []
          let metadataBytes = 0
          for (const laneId of lanes) {
            if (!parsed.laneId && !admitted(laneId)) continue
            const saved = await index(laneId)
            if (!saved) continue
            for (const a of Object.values(saved.artifacts)) {
              const versions = a.versions
                .filter((v) => v.onBranch)
                .sort((a, b) => a.version - b.version)
              if (!versions.length) continue
              const item: ArtifactMeta = {
                laneId,
                slug: a.slug,
                title: a.title,
                type: a.type,
                ...(a.language ? { language: a.language } : {}),
                versions: versions.map((v) => ({
                  version: v.version,
                  title: v.title,
                  createdAt: Date.parse(v.createdAt) || 0,
                  bytes: v.bytes,
                })),
              }
              metadataBytes += utf8Length(JSON.stringify(item))
              if (metadataBytes > ARTIFACT_LIMITS.metadataBytes)
                throw new FeatureFailure('too-large')
              items.push(item)
              if (items.length > ARTIFACT_LIMITS.count) throw new FeatureFailure('too-large')
            }
          }
          if (!parseArtifactList(items)) throw new FeatureFailure('too-large')
          if (parsed.laneId) requireLane(parsed.laneId)
          return { ok: true, data: items.filter((item) => admitted(item.laneId)) }
        }
        if (!parsed.laneId || !parsed.slug) throw new FeatureFailure('bad-request')
        const saved = await index(parsed.laneId)
        requireLane(parsed.laneId)
        const versions = saved?.artifacts[parsed.slug]?.versions
          .filter((v) => v.onBranch)
          .sort((a, b) => a.version - b.version)
        const version =
          parsed.version === undefined
            ? versions?.at(-1)
            : versions?.find((v) => v.version === parsed.version)
        if (!version) throw new FeatureFailure('bad-request')
        if (version.bytes > ARTIFACT_LIMITS.contentBytes) throw new FeatureFailure('too-large')
        let content: string
        const fd = await open(
          blobFile(root, version.sha256),
          constants.O_RDONLY | constants.O_NOFOLLOW,
        )
        try {
          const info = await fd.stat()
          if (!info.isFile() || info.size > ARTIFACT_LIMITS.contentBytes)
            throw new FeatureFailure('too-large')
          const bytes = Buffer.alloc(info.size + 1)
          let length = 0
          while (length < bytes.length) {
            const read = await fd.read(bytes, length, bytes.length - length, null)
            if (!read.bytesRead) break
            length += read.bytesRead
          }
          if (length !== version.bytes || !isUtf8(bytes.subarray(0, length)))
            throw new FeatureFailure('internal')
          content = bytes.subarray(0, length).toString('utf8')
        } finally {
          await fd.close()
        }
        requireLane(parsed.laneId)
        return { ok: true, data: { version: version.version, content } }
      } catch (error) {
        return featureError(
          error instanceof Error && error.message === 'session-too-large'
            ? new FeatureFailure('too-large')
            : error,
        )
      } finally {
        pending--
        release()
      }
    },
  }
}
