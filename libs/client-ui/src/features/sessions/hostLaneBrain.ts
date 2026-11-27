import { brainTitleNeverRead } from '@shared/brain'
import type { HostBrainLaneState, HostBrainStatus } from '@shared/host-brain'
import type { LaneActionContext } from './laneActions'

type Read = NonNullable<HostBrainLaneState['lastRead']>

/** Read again is destructive only after a successful replacement, never at queue time. */
export function hostLaneReadSummary({
  memories,
  replaceable,
}: Pick<Read, 'memories' | 'replaceable'>): string {
  const shared = memories - replaceable
  return `The ${replaceable} unshared current memories stay until the new read is saved. Then they are replaced.${shared > 0 ? ` ${shared} shared current memories are kept.` : ''}`
}

/** Combine Host-projected eligibility with its title rules; provenance is not a lane ID. */
export function hostLaneBrainContext(
  status: HostBrainStatus,
  lane: HostBrainLaneState,
  title: string,
): Pick<LaneActionContext, 'knowledge' | 'brainExclusion'> {
  if (!status.prefs.enabled) return {}
  return {
    knowledge: lane.activeJob ? 'cancel' : lane.lastRead ? 'new' : 'queue',
    brainExclusion: brainTitleNeverRead(status.prefs.neverRead, title)
      ? 'title'
      : lane.excluded
        ? 'lane'
        : null,
  }
}
