import { appendFile, chmod, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { RoutineRepository } from '../../../../libs/session-runtime/src/routines/repository'
import { newRoutine } from '../../../../libs/shared/src/routines'
import {
  indexSessionFile,
  writeIndex,
} from '../../../../libs/session-runtime/src/artifacts/artifact-indexer'
import { writeFixtureLane } from './migration-fixture'

export const savedTitle = 'Saved by the service'
export const folderName = 'service-folder'

/** Seed different, genuinely readable stores on either side of the owner socket. */
export async function seedWorld(agent: string, cwd: string, data: string, service: boolean) {
  const prefix = service ? 'Service' : 'Frozen Desktop'
  const id = randomUUID()
  const lane = await writeFixtureLane(agent, id, cwd, service ? savedTitle : 'Frozen Desktop lane')
  await seedArtifact(data, lane.transcript, id, `${prefix} artifact`)
  const skills = join(agent, 'skills', service ? 'host-only' : 'frozen-skill')
  await mkdir(skills, { recursive: true, mode: 0o700 })
  await writeFile(
    join(skills, 'SKILL.md'),
    `---\nname: ${service ? 'host-only' : 'frozen-skill'}\ndescription: ${prefix} skill\n---\n${prefix} instructions\n`,
  )
  const routines = service ? join(data, 'routines') : data
  await mkdir(routines, { recursive: true, mode: 0o700 })
  const dbPath = join(routines, service ? 'state.sqlite' : 'routines.sqlite')
  await seedRoutine(dbPath, cwd, `${prefix} routine`)
}

export async function seedArtifact(
  data: string,
  transcript: string,
  id: string,
  title: string,
  deleted = false,
) {
  await appendFile(
    transcript,
    JSON.stringify({
      type: 'custom',
      id: 'saved-card',
      parentId: `${id.slice(0, 4)}0002`,
      customType: 'phosphor-saved-artifact',
      timestamp: '2026-09-01T00:00:04Z',
      data: {
        id: 'card',
        title: title,
        version: 1,
        type: 'markdown',
        content: `${title} body`,
      },
    }) + '\n',
  )
  const artifacts = join(data, 'artifacts')
  const index = await indexSessionFile(artifacts, transcript, null)
  if (!index?.artifacts.card) throw new Error('Missing fixture artifact')
  await writeIndex(artifacts, { ...index, deleted })
}

export async function seedRoutine(dbPath: string, cwd: string, name: string) {
  const db = new RoutineRepository(dbPath)
  try {
    db.save(
      {
        ...newRoutine(cwd),
        name: name,
        instructions: 'Report only.',
        provider: 'fake',
        model: 'fake-model',
        enabled: false,
        trusted: false,
      },
      Date.now(),
    )
  } finally {
    db.close()
  }
  await chmod(dbPath, 0o600)
}
