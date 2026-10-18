import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { isUtf8 } from 'node:buffer'
import { blobFile } from '@phosphor/session-runtime/artifacts/artifact-indexer'
import { ARTIFACT_LIMITS, type parseArtifactParams } from '@phosphor/shared/host-protocol-artifacts'
import type { FeatureOutcome } from '../feature'
import { FeatureFailure } from '../machine'
import { indexArtifacts, type ArtifactLanePorts } from './query'

export async function readArtifact(
  root: string,
  ports: ArtifactLanePorts,
  parsed: NonNullable<ReturnType<typeof parseArtifactParams>>,
): Promise<FeatureOutcome> {
  if (!parsed.laneId || !parsed.slug) throw new FeatureFailure('bad-request')
  const saved = await indexArtifacts(root, ports.store, parsed.laneId)
  ports.requireLane(parsed.laneId)
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
  const fd = await open(blobFile(root, version.sha256), constants.O_RDONLY | constants.O_NOFOLLOW)
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
  ports.requireLane(parsed.laneId)
  return { ok: true, data: { version: version.version, content } }
}
