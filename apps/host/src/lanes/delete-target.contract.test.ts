import { mkdir, readFile, realpath, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { sessionDirForCwd } from '@phosphor/session-runtime/pi/pi-paths'
import { afterEach, expect, it, vi } from 'vitest'
import { createConfigurationAuthority } from '../api/configuration-authority'
import { createHostRuntime } from '../session/runtime'
import { createCommandsFixture } from './__fixtures__/commands.fixture'
import { createLaneDeletion } from './delete'
import { ownerTrash } from './delete-target'

afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

it.each(['grant-user', 'owner'] as const)(
  'a %s deletion reaches only its permitted target on a local Mac',
  async (kind) => {
    const f = await createCommandsFixture()
    try {
      const repository = await realpath(f.lane.cwd)
      const agent = join(f.root, 'agent')
      vi.stubEnv('PI_CODING_AGENT_DIR', agent)
      vi.stubEnv('PI_CODING_AGENT_SESSION_DIR', undefined)
      vi.stubEnv('PATH', process.env.PATH)
      const folder = sessionDirForCwd(repository)
      await mkdir(folder, { recursive: true })
      const file = join(folder, 'test.jsonl')
      await writeFile(file, 'session')
      f.store.bindSessionFile(f.lane.laneId, file)
      const system = vi.fn(async () => rename(file, join(f.root, 'system-trash')))
      const host = vi.fn(async (path: string) => rename(path, join(f.root, 'host-trash')))
      const runtime = createHostRuntime(
        {
          pi: { binaryPath: process.execPath, prefixArgs: [] },
          env: { HOME: f.root, PATH: process.env.PATH!, PI_CODING_AGENT_DIR: agent },
          resourceRoot: f.root,
          roots: [repository],
          contextBudget: '',
          log: { write: vi.fn(), hide: (text) => text, path: () => null, addSecrets: vi.fn() },
        },
        { trashTranscript: host, ownerTrashTranscript: ownerTrash(true, 'darwin', system) },
      )
      runtime.life.to('validating')
      runtime.life.to('ready')
      f.ports.deleteLane = createLaneDeletion({
        store: f.store,
        remove: runtime.remove,
        stop: async () => {},
        forget: () => {},
      })
      f.store.takeControl(f.lane.laneId, { clientId: f.one.id, label: f.one.label })
      const client = createConfigurationAuthority({
        caps: () => ['workspaces.write', 'sessions.control'],
        open: () => true,
        closed: () => false,
      }).sender(f.one, 'connection', { kind, clientId: f.one.id })
      const frame = f.frame(
        { type: 'lane.delete', laneId: f.lane.laneId, removeWorktree: false, removeBranch: false },
        2,
      )
      await f.service.submit(client, frame)
      expect(f.last(frame.requestId)).toMatchObject({ status: 'done' })
      expect(host).toHaveBeenCalledTimes(kind === 'grant-user' ? 1 : 0)
      expect(system).toHaveBeenCalledTimes(kind === 'owner' ? 1 : 0)
      expect(
        await readFile(join(f.root, kind === 'owner' ? 'system-trash' : 'host-trash'), 'utf8'),
      ).toBe('session')
    } finally {
      f.cleanup()
    }
  },
)
