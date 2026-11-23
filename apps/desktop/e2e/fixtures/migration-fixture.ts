import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { assertScratchRoots } from './assert-scratch'

/**
 * A Desktop world as This Mac holds it before the move to the Phosphor
 * service: one repository in the recents with a lane in the checkout, one in
 * a live worktree and one whose worktree was removed, each a pi transcript in
 * the agent dir's mangled session folder. The migration specs seed it, move
 * it and compare the sidebar and the `transcriptWitness` before and after.
 */

export interface MigrationWorldRoots {
  /** The scratch folder every other root lies in (`localDaemonFixture().root`). */
  root: string
  userData: string
  agentDir: string
}

export interface MigrationLane {
  name: string
  cwd: string
  transcript: string
}

export interface MigrationWorld {
  repository: string
  lanes: { checkout: MigrationLane; worktree: MigrationLane; removedWorktree: MigrationLane }
}

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim()

/** pi's session folder for `cwd`; the same rule as `sessionDirNameForCwd` and the pi stub. */
const sessionFolder = (agentDir: string, cwd: string) =>
  join(agentDir, 'sessions', `--${cwd.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`)

export async function writeFixtureLane(agentDir: string, id: string, cwd: string, name: string) {
  const folder = sessionFolder(agentDir, cwd)
  await mkdir(folder, { recursive: true })
  const transcript = join(folder, `2026-09-01T00-00-00-000Z_${id}.jsonl`)
  const entries = [
    { type: 'session', version: 3, id, cwd, timestamp: '2026-09-01T00:00:00Z' },
    {
      type: 'session_info',
      id: `${id.slice(0, 4)}0001`,
      parentId: null,
      name,
      timestamp: '2026-09-01T00:00:01Z',
    },
    {
      type: 'message',
      id: `${id.slice(0, 4)}0002`,
      parentId: `${id.slice(0, 4)}0001`,
      timestamp: '2026-09-01T00:00:02Z',
      message: { role: 'user', content: `${name}: keep this conversation.` },
    },
  ]
  await writeFile(transcript, entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n')
  return { name, cwd, transcript }
}

/** Writes the world into `roots`; refuses before any write when a root is outside scratch. */
export async function migrationFixtureWorld(roots: MigrationWorldRoots): Promise<MigrationWorld> {
  const { root, userData, agentDir } = roots
  const repository = join(root, 'repository')
  assertScratchRoots({ userData, agentDir, repository }, [root])
  await mkdir(repository)
  git(repository, 'init', '-q', '-b', 'main')
  git(repository, 'config', 'user.name', 'Fixture')
  git(repository, 'config', 'user.email', 'fixture@example.invalid')
  await writeFile(join(repository, 'readme'), 'migration fixture\n')
  git(repository, 'add', '.')
  git(repository, 'commit', '-qm', 'seed')
  const worktree = join(repository, '.phosphor', 'worktrees', 'research')
  const removed = join(repository, '.phosphor', 'worktrees', 'spike')
  git(repository, 'worktree', 'add', '-q', '-b', 'research', worktree, 'main')
  git(repository, 'worktree', 'add', '-q', '-b', 'spike', removed, 'main')
  git(repository, 'worktree', 'remove', removed)
  const lanes = {
    checkout: await writeFixtureLane(
      agentDir,
      'checkout-lane',
      repository,
      'Checkout migration lane',
    ),
    worktree: await writeFixtureLane(
      agentDir,
      'worktree-lane',
      worktree,
      'Worktree migration lane',
    ),
    removedWorktree: await writeFixtureLane(
      agentDir,
      'removed-lane',
      removed,
      'Removed worktree lane',
    ),
  }
  await mkdir(userData, { recursive: true, mode: 0o700 })
  await writeFile(
    join(userData, 'config.json'),
    JSON.stringify({
      lastWorkspacePath: repository,
      recentWorkspaces: [{ path: repository, name: 'repository' }],
      // No background reclaim may touch the fixture's worktrees mid-test.
      maintenance: { enabled: false },
    }),
  )
  return { repository, lanes }
}

/**
 * SHA-256 of each fixture lane's transcript, keyed by lane, or `missing`.
 * Only the seeded files: a run may add transcripts of its own beside them.
 */
export async function transcriptWitness(world: MigrationWorld): Promise<Record<string, string>> {
  const witness: Record<string, string> = {}
  for (const [key, lane] of Object.entries(world.lanes))
    witness[key] = await readFile(lane.transcript).then(
      (bytes) => createHash('sha256').update(bytes).digest('hex'),
      () => 'missing',
    )
  return witness
}
