import { app } from 'electron'
import type {
  SpawnContribution,
  SpawnInputs,
} from '@phosphor/session-runtime/pi/spawn-contributions'
import { isDesktopBrainLane } from '../../brain/lane-folder'

/** Brain for a lane in `workspacePath` (resolved), or undefined when off. */
export type DesktopBrainLaunch = (workspacePath: string) => Promise<
  | (Pick<SpawnInputs, 'extensions' | 'skills'> & {
      connection?: NonNullable<SpawnInputs['brainConnection']>
    })
  | undefined
>

let launch: DesktopBrainLaunch | undefined
/** Installed after startup, so opening a lane needn't eagerly import Brain. */
export function setSessionRecall(value: DesktopBrainLaunch): void {
  launch = value
}

/**
 * Recall's resources for an ordinary lane, whose Brain calls go over its op channel; Brain
 * Agent's tools for the Brain lane (brain/lane-folder.ts picks which). Only the exact Brain lane
 * folder gets the private bridge connection, as a typed spawn field, never env.
 */
export function createBrainContribution(): SpawnContribution {
  return {
    name: 'brain',
    async spawn(_execution, { options }) {
      const resources = await launch?.(options.workspacePath)
      if (!resources) return undefined
      const brainLane =
        resources.connection && isDesktopBrainLane(options.workspacePath, app.getPath('userData'))
      return {
        ...(brainLane ? { brainConnection: resources.connection } : {}),
        extensions: resources.extensions ?? [],
        skills: resources.skills ?? [],
      }
    },
  }
}
