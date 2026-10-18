import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { sessionFixture } from './__fixtures__/session-runtime'

const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

it('refuses unavailable native-model fallback to Claude before any prompt or account attribution', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'startup-account-'))
  directories.push(directory)
  const path = join(directory, 'session.jsonl')
  await writeFile(
    path,
    [
      { type: 'session', version: 3, id: 'saved', cwd: directory },
      {
        type: 'model_change',
        id: 'model',
        parentId: null,
        provider: 'native',
        modelId: 'unavailable',
      },
    ]
      .map((entry) => JSON.stringify(entry))
      .join('\n'),
  )
  const h = sessionFixture()
  h.runtime.policy.strictAccountSelection = true
  vi.mocked(h.runtime.policy.defaultProvider).mockResolvedValue('pi-claude-cli')
  vi.mocked(h.runtime.policy.account).mockResolvedValue({
    id: 'private',
    env: { CLAUDE_SECURESTORAGE_CONFIG_DIR: '/private' },
  })
  h.registry.on('created', () => {
    h.clients[0]!.request.mockResolvedValue({
      success: true,
      data: { autoCompactionEnabled: true, model: { provider: 'pi-claude-cli' } },
    })
  })

  try {
    await expect(h.spawn({ workspacePath: directory, sessionPath: path }, h.sink)).rejects.toThrow(
      'verified Claude account',
    )
    expect(h.runtime.policy.account).not.toHaveBeenCalled()
    expect(h.clients[0]!.request.mock.calls.map(([command]) => command.type)).toEqual(['get_state'])
    expect(h.runtime.accounts.remember).not.toHaveBeenCalled()
    expect(h.runtime.recordWorkspace).not.toHaveBeenCalled()
    expect(h.registry.list()).toEqual([])
    expect(h.clients[0]!.dispose).toHaveBeenCalledOnce()
  } finally {
    await h.registry.disposeAll()
  }
})
