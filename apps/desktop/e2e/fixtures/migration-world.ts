import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import {
  archiveIdFor,
  createLaneArchiveStorage,
} from '../../../../libs/session-runtime/src/lane-archive/storage'
import {
  migrationFixtureWorld,
  writeFixtureLane,
  type MigrationWorldRoots,
} from './migration-fixture'
import { seedArtifact, seedRoutine } from './local-parity-world'

export const draftText = 'Unsent migration note'
export const routineName = 'Weekly migration review'
export const archiveName = 'Parked migration lane'
export const liveArtifact = 'Migration notes'
export const deletedArtifact = 'Kept after deletion'

export async function migrationWorld(roots: MigrationWorldRoots) {
  const world = await migrationFixtureWorld(roots)
  const { userData, agentDir } = roots
  const { checkout, worktree, removedWorktree } = world.lanes
  const sandbox = join(userData, 'sandboxes', 'migration-sandbox')
  await mkdir(sandbox, { recursive: true })
  await mkdir(join(userData, 'claude-accounts'), { mode: 0o700 })
  const sandboxLane = await writeFixtureLane(
    agentDir,
    randomUUID(),
    sandbox,
    'Sandbox migration lane',
  )
  const id = basename(checkout.transcript, '.jsonl').split('_').at(-1)!
  await seedArtifact(userData, checkout.transcript, id, liveArtifact)
  const deletedId = randomUUID()
  const deleted = await writeFixtureLane(agentDir, deletedId, world.repository, 'Deleted lane')
  await seedArtifact(userData, deleted.transcript, deletedId, deletedArtifact, true)
  await rm(deleted.transcript)
  const parked = await writeFixtureLane(agentDir, randomUUID(), world.repository, archiveName)
  const archives = createLaneArchiveStorage(
    join(userData, 'lane-archive'),
    join(agentDir, 'sessions'),
  )
  const archive = await archives.prepare({
    id: archiveIdFor(parked.transcript),
    title: parked.name,
    repository: world.repository,
    cwd: parked.cwd,
    transcript: parked.transcript,
  })
  await archives.archive(archive.id)
  await seedRoutine(join(userData, 'routines.sqlite'), world.repository, routineName)
  const config = join(userData, 'config.json')
  const key = `session:${checkout.transcript}`
  await writeFile(
    config,
    JSON.stringify({
      ...JSON.parse(await readFile(config, 'utf8')),
      lastSessionPath: checkout.transcript,
      pinnedSessions: [worktree.transcript],
      lanes: { markers: 'manual', autoName: false },
      laneMarkers: { [removedWorktree.transcript]: '🔥' },
      sessionOrder: [removedWorktree.transcript, checkout.transcript],
      drafts: {
        [key]: {
          key,
          workspacePath: checkout.cwd,
          text: draftText,
          attachments: [],
          updatedAt: Date.now(),
        },
      },
    }),
  )
  const lanes = { ...world.lanes, sandbox: sandboxLane }
  const files = [
    ...Object.values(lanes).map((l) => l.transcript),
    `${parked.transcript}.archived`,
    join(userData, 'lane-archive', `${archive.id}.json`),
  ]
  for (const part of ['sessions', 'blobs']) {
    const dir = join(userData, 'artifacts', part)
    files.push(...(await readdir(dir)).map((name) => join(dir, name)))
  }
  // Only authored files: live SQLite WAL/shm, window prefs and scan cursors can advance on an ordinary launch.
  const manifest = async () =>
    Object.fromEntries(
      await Promise.all(
        files.map(async (file) => [
          file,
          createHash('sha256')
            .update(await readFile(file))
            .digest('hex'),
        ]),
      ),
    )
  return { ...world, lanes, manifest, deletedId }
}
