import { join } from 'node:path'
import { parseArtifactParams } from '@phosphor/shared/host-protocol-artifacts'
import { hostStateDirectory } from '../lanes/state-dir'
import { FeatureFailure, featureError } from './machine'
import type { HostStore } from '../lanes/store'
import type { FeatureContext, FeatureOutcome, HostFeature } from './feature'
import { listArtifacts, type ArtifactLanePorts } from './artifacts/query'
import { readArtifact } from './artifacts/read'

interface ArtifactQueue {
  pending: number
  tail: Promise<void>
}

async function artifactCall(
  queue: ArtifactQueue,
  root: string,
  lanes: ArtifactLanePorts,
  method: string,
  params: unknown,
): Promise<FeatureOutcome> {
  const parsed = parseArtifactParams(method, params)
  if (!parsed) return featureError(new FeatureFailure('bad-request'))
  // One active call plus eight FIFO waiters. Call errors have no busy code.
  if (queue.pending >= 9) return featureError(new FeatureFailure('internal'))
  queue.pending++
  const previous = queue.tail
  let release = () => {}
  queue.tail = new Promise<void>((resolve) => {
    release = resolve
  })
  await previous
  try {
    return method === 'artifacts.list'
      ? await listArtifacts(root, lanes, parsed.laneId)
      : await readArtifact(root, lanes, parsed)
  } catch (error) {
    return featureError(
      error instanceof Error && error.message === 'session-too-large'
        ? new FeatureFailure('too-large')
        : error,
    )
  } finally {
    queue.pending--
    release()
  }
}

export function createArtifactsFeature(
  context: FeatureContext & { store: FeatureContext['store'] & Pick<HostStore, 'listLanes'> },
): HostFeature {
  const root = join(hostStateDirectory(context.env, context.home), 'artifacts')
  const queue: ArtifactQueue = { pending: 0, tail: Promise.resolve() }
  const lanes: ArtifactLanePorts = {
    store: context.store,
    admitted(laneId) {
      const lane = context.store.getLane(laneId)
      return !!lane && lane.removedAt === null
    },
    requireLane(laneId) {
      if (!lanes.admitted(laneId)) throw new FeatureFailure('unknown-lane')
    },
  }
  return {
    capability: 'artifacts.read',
    methods: ['artifacts.list', 'artifacts.read'],
    call: (method, params) => artifactCall(queue, root, lanes, method, params),
  }
}
