import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  removeSettingsFixtures,
  settingsServiceFixture as fixture,
} from './__fixtures__/settings-service.fixture'
vi.mock('@phosphor/session-runtime/pi/print-mode', () => ({ runPrintMode: vi.fn() }))
afterEach(removeSettingsFixtures)

describe('agent.patch clears a key with null', () => {
  it('says the Host supports clearing', async () => {
    const f = await fixture()
    expect((await f.read('agent')).agentClearSupported).toBe(true)
  })
  it('deletes pi keys and nested fields, never writing null', async () => {
    const f = await fixture()
    const path = join(f.agentDir, 'settings.json')
    await writeFile(
      path,
      JSON.stringify({
        defaultModel: 'opus',
        hideThinkingBlock: true,
        compaction: { enabled: false, reserveTokens: 4096 },
        retry: { maxRetries: 2 },
        packages: ['npm:keep'],
      }),
      { mode: 0o600 },
    )
    const before = await f.read('agent')
    const result = await f.patch(
      'agent',
      {
        type: 'agent.patch',
        patch: {
          hideThinkingBlock: null,
          defaultModel: null,
          compaction: { enabled: null },
          retry: null,
        },
      },
      before.revision,
    )
    expect(result.ok).toBe(true)
    const text = await readFile(path, 'utf8')
    expect(text).not.toContain('null')
    expect(JSON.parse(text)).toEqual({
      compaction: { reserveTokens: 4096 },
      packages: ['npm:keep'],
    })
    const after = await f.read('agent')
    expect(after.agent?.hideThinkingBlock).toBeUndefined()
    expect(after.agent?.compaction).toEqual({ reserveTokens: 4096 })
  })
  it('clears a folder override so the folder inherits again', async () => {
    const f = await fixture()
    const path = join(f.repo, '.pi', 'settings.json')
    const before = await f.read('agent', f.repository.id)
    await f.patch(
      'agent',
      { type: 'agent.patch', patch: { steeringMode: 'all' } },
      before.revision,
      f.repository.id,
    )
    const set = await f.read('agent', f.repository.id)
    expect(set.agent?.steeringMode).toBe('all')
    const result = await f.patch(
      'agent',
      { type: 'agent.patch', patch: { steeringMode: null } },
      set.revision,
      f.repository.id,
    )
    expect(result.ok).toBe(true)
    expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({})
  })
  it('deletes Host policy keys at machine scope and refuses them for a folder', async () => {
    const f = await fixture()
    const before = await f.read('agent')
    await f.patch(
      'agent',
      { type: 'agent.patch', patch: { contextBudget: '400k', autoNameLanes: false } },
      before.revision,
    )
    const set = await f.read('agent')
    expect(
      (
        await f.patch(
          'agent',
          { type: 'agent.patch', patch: { autoNameLanes: null } },
          set.revision,
          f.repository.id,
        )
      ).ok,
    ).toBe(false)
    const result = await f.patch(
      'agent',
      { type: 'agent.patch', patch: { contextBudget: null, autoNameLanes: null } },
      set.revision,
    )
    expect(result.ok).toBe(true)
    const config = JSON.parse(await readFile(f.configPath, 'utf8'))
    expect(config).not.toHaveProperty('contextBudget')
    expect(config).not.toHaveProperty('autoNameLanes')
    expect(config.repositories).toEqual([f.repo])
    expect((await f.read('agent')).agent).toMatchObject({ contextBudget: '', autoNameLanes: true })
  })
})
