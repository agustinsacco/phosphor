import { realpathSync } from 'node:fs'
import { join } from 'node:path'
import type { HostStore } from '../lanes/store'
import { hostStateDirectory } from '../lanes/state-dir'
import type { FeatureContext, HostFeature } from './feature'
import { createLaneExportFeature } from './lane-transfer/export'
import { createLaneImportFeature } from './lane-transfer/import'
import { createStaging } from './lane-transfer/staging'

export interface LaneTransferLive {
  sessionFor(laneId: string): string | null
  /** Publish one lane's current summary to every subscriber. */
  announce(laneId: string): void
}

/**
 * Moving lanes off and onto this Host. The two halves are separate features
 * because they need different authority: reading a lane, or creating one.
 */
export function createLaneTransferFeatures(
  context: FeatureContext,
  store: Pick<
    HostStore,
    'listRepositories' | 'ensureLane' | 'bindSessionFile' | 'setLaneMarks' | 'markRemoved'
  >,
  live: LaneTransferLive,
): HostFeature[] {
  const state = realpathSync(hostStateDirectory(context.env, context.home))
  const attachmentsRoot = join(state, 'attachments')
  const root = join(state, 'lane-transfer')
  return [
    createLaneExportFeature(context, {
      staging: createStaging(join(root, 'exports')),
      attachmentsRoot,
      sessionFor: live.sessionFor,
    }),
    createLaneImportFeature(context, {
      staging: createStaging(join(root, 'imports')),
      attachmentsRoot,
      store,
      published: live.announce,
    }),
  ]
}
