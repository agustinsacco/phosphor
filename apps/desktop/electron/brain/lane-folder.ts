import { realpathSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type {
  BrainCuratorLaunch,
  BrainRecallLaunch,
  BrainService,
} from '@phosphor/brain-runtime/types'
import { ensureBrainLane } from '@phosphor/brain-runtime/agent/rules'

const real = (path: string): string | null => {
  try {
    return realpathSync.native(path)
  } catch {
    return null
  }
}

/**
 * The Brain lane's folder, `<userData>/brain/Brain`, as a real path: pi names a lane's
 * transcript folder after its real cwd, and Brain never reads a lane there. Before the folder
 * exists, the real userData path with the two names Phosphor creates under it.
 */
export function brainLaneFolder(userData: string): string {
  const folder = join(userData, 'brain', 'Brain')
  return real(folder) ?? join(real(userData) ?? resolve(userData), 'brain', 'Brain')
}

/** Whether a lane in `cwd` is the Brain lane: real paths compared. */
export function isBrainLaneFolder(cwd: string, folder: string): boolean {
  return (real(cwd) ?? resolve(cwd)) === folder
}

/**
 * Whether `cwd` is exactly this Desktop's Brain lane folder, `<real userData>/brain/Brain`, by real
 * path; a symlink in its place fails closed. It is Desktop-private, so it is the one in-app lane
 * daemon mode starts (registry.ts) and the one folder migration never plans.
 */
export function isDesktopBrainLane(
  cwd: string,
  userData: string,
  realpath: (path: string) => string | null = real,
): boolean {
  const root = realpath(userData)
  return root !== null && realpath(cwd) === join(root, 'brain', 'Brain')
}

/**
 * What a lane starting in `workspacePath` gets from Brain: Brain Agent's tools (and its default
 * rules, if AGENTS.md is missing) in the Brain lane, recall in every other lane.
 */
export async function laneBrainLaunch(
  workspacePath: string,
  folder: string,
  service: () => Promise<Pick<BrainService, 'recallLaunch' | 'curatorLaunch'>>,
): Promise<BrainRecallLaunch | BrainCuratorLaunch | undefined> {
  if (!isBrainLaneFolder(workspacePath, folder)) return (await service()).recallLaunch()
  const brain = await service()
  await ensureBrainLane(folder)
  return brain.curatorLaunch()
}
