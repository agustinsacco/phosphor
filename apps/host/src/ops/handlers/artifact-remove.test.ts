import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { readIndex } from '@phosphor/session-runtime/artifacts/artifact-indexer'
import { ArtifactLibrary } from '@phosphor/session-runtime/artifacts/artifact-library'
import { OpRefusal } from '@phosphor/session-runtime/ops/builtins'
import { openStore, type HostStore } from '../../lanes/store'
import { ARTIFACT_REMOVE_REFUSALS, removeArtifact } from './artifact-remove'
import type { DaemonHandlerDeps } from './index'

const uid = process.getuid?.()
let root: string
let store: HostStore
let deps: DaemonHandlerDeps
let repositoryId: string
beforeEach(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'p4b-artifact-remove-')))
  store = await openStore(join(root, 'state'), uid)
  mkdirSync(join(root, 'repo'))
  repositoryId = store.syncRepositories([join(root, 'repo')])[0]!.id
  deps = { store, stateDirectory: join(root, 'state') } as unknown as DaemonHandlerDeps
})
afterEach(() => {
  store.close()
  rmSync(root, { recursive: true, force: true })
})

/** A pi session that saved one artifact, indexed into the daemon's store. */
async function sessionWithArtifact(): Promise<{ file: string; sessionId: string }> {
  const sessionId = randomUUID()
  const file = join(root, 'sessions', '--repo--', `2026-01-01T00-00-00-000Z_${sessionId}.jsonl`)
  mkdirSync(join(root, 'sessions', '--repo--'), { recursive: true })
  const lines = [
    { type: 'session', version: 3, id: sessionId, timestamp: 't', cwd: join(root, 'repo') },
    {
      type: 'message',
      id: 'e1',
      parentId: null,
      timestamp: '2026-01-01T00:00:00.000Z',
      message: {
        role: 'toolResult',
        toolName: 'artifact_create',
        toolCallId: 'call-notes-1',
        details: { id: 'notes', title: 'Notes', type: 'markdown', content: '# Hi', version: 1 },
      },
    },
  ]
  writeFileSync(file, lines.map((l) => `${JSON.stringify(l)}\n`).join(''))
  await new ArtifactLibrary(() => join(root, 'state', 'artifacts')).indexFile(file)
  return { file, sessionId }
}

const lane = (file: string) =>
  store.ensureLane({ repositoryId, cwd: join(root, 'repo'), sessionFile: file })
const index = (sessionId: string) => readIndex(join(root, 'state', 'artifacts'), sessionId)
const refusal = (code: string, text: string) => new OpRefusal(code as never, text)

it('removes a deleted lane’s artifact by the lane id artifact.list names, with no Undo', async () => {
  const { file, sessionId } = await sessionWithArtifact()
  const removed = lane(file)
  store.markRemoved(removed.laneId)
  rmSync(file)
  await expect(removeArtifact(deps, `${removed.laneId}/notes`)).resolves.toEqual({
    text: `Removed artifact ${removed.laneId}/notes.`,
    undo: false,
  })
  expect(index(sessionId)).toBeNull()
})

it('removes a deleted conversation’s artifact by This Mac’s session-id key', async () => {
  const { file, sessionId } = await sessionWithArtifact()
  rmSync(file)
  await removeArtifact(deps, `${sessionId}/notes`)
  expect(index(sessionId)).toBeNull()
})

it('refuses a live lane’s artifact under either key: it goes with the lane', async () => {
  const { file, sessionId } = await sessionWithArtifact()
  const live = lane(file)
  const refused = refusal('forbidden', ARTIFACT_REMOVE_REFUSALS.live)
  await expect(removeArtifact(deps, `${live.laneId}/notes`)).rejects.toEqual(refused)
  await expect(removeArtifact(deps, `${sessionId}/notes`)).rejects.toEqual(refused)
  expect(ARTIFACT_REMOVE_REFUSALS.live).toBe(
    'That artifact belongs to a live lane; it goes with the lane.',
  )
  expect(index(sessionId)?.artifacts.notes).toBeDefined()
})

it('refuses a conversation still on disk, an unknown artifact and a malformed key', async () => {
  const { sessionId } = await sessionWithArtifact()
  const missing = refusal('bad-request', ARTIFACT_REMOVE_REFUSALS.missing)
  await expect(removeArtifact(deps, `${sessionId}/notes`)).rejects.toEqual(missing)
  await expect(removeArtifact(deps, `${randomUUID()}/notes`)).rejects.toEqual(missing)
  await expect(removeArtifact(deps, 'notes')).rejects.toEqual(
    refusal('bad-request', ARTIFACT_REMOVE_REFUSALS.key),
  )
  await expect(removeArtifact(deps, '../x/notes')).rejects.toEqual(
    refusal('bad-request', ARTIFACT_REMOVE_REFUSALS.key),
  )
})
