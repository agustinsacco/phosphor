import { realpathSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type {
  BrainCuratorLaunch,
  BrainRecallLaunch,
  BrainService,
} from '@phosphor/brain-runtime/types'

/** Brain Agent's working rules until the owner changes them. Written once, never overwritten. */
export const BRAIN_AGENT_RULES = `# Brain Agent

## Defrag
Decide everything that's waiting, in this order: reads, people and things,
repeats and disagreements, flags. End with a short summary.

## Reads
- Reject reads of lanes Brain never reads.
- Keep memories a future lane would act on. Leave out status, near-term plans
  and remarks about a person.
- Answer identity questions from evidence. If nothing links two records,
  they are different.

## People and things
- Merge only on real evidence: the same Slack, Linear or GitHub identity, the
  same role, or shared links. A name alone is never enough.
- Check Slack, Linear and GitHub when Brain alone can't tell.

## Memories
- Fold repeats and keep the one with more quotes.
- If a source shows which is newer, replace the older one. If both could be
  true, keep both as disputed.
- If Linear, Notion, Slack or GitHub states the new truth, correct the
  memory and cite the source.
- Erase a memory when you're confident it was superseded or won't help
  anything in the future.

## Flags
- Check each flag against sources. Fix, fold or erase. If the flag is wrong,
  keep the memory.

## Changing these rules
When the owner says to work differently, update this file. Keep it short.
`

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

const rulesPath = (folder: string): string => join(folder, 'AGENTS.md')

/** The folder, and the default rules when AGENTS.md is missing; the owner's rules stay as they are. */
export async function ensureBrainLane(folder: string): Promise<void> {
  await mkdir(folder, { recursive: true })
  await writeFile(rulesPath(folder), BRAIN_AGENT_RULES, { flag: 'wx' }).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code !== 'EEXIST') throw error
    },
  )
}

/** The rules as saved now, or null while the file is gone. */
export function readBrainRules(folder: string): Promise<string | null> {
  return readFile(rulesPath(folder), 'utf8').catch(() => null)
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
  await ensureBrainLane(folder)
  return (await service()).curatorLaunch()
}
