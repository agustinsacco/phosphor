import type {
  SpawnContribution,
  SpawnInputs,
} from '@phosphor/session-runtime/pi/spawn-contributions'

/** Brain for a lane in `workspacePath` (resolved), or undefined when off. */
export type DesktopBrainLaunch = (
  workspacePath: string,
) => Promise<Pick<SpawnInputs, 'env' | 'extensions' | 'skills'> | undefined>

let launch: DesktopBrainLaunch | undefined
/** Installed after startup, so opening a lane needn't eagerly import Brain. */
export function setSessionRecall(value: DesktopBrainLaunch): void {
  launch = value
}

/**
 * Recall's resources for an ordinary lane, whose Brain calls go over its op channel; Brain
 * Agent's tools for the Brain lane, whose launch alone carries env: the private bridge's
 * endpoint and curator token (brain/lane-folder.ts picks which).
 */
export function createBrainContribution(): SpawnContribution {
  return {
    name: 'brain',
    async spawn(_execution, { options }) {
      const resources = await launch?.(options.workspacePath)
      if (!resources) return undefined
      return {
        ...(resources.env ? { env: resources.env } : {}),
        extensions: resources.extensions ?? [],
        skills: resources.skills ?? [],
      }
    },
  }
}
