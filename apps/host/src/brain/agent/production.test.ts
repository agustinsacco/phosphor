import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { createProductionBrainAgent } from './production'

it('shares one binding across handover and conversation without creating a fresh Brain', async () => {
  const state = await mkdtemp(join(tmpdir(), 'harbor-owner-'))
  try {
    const agent = createProductionBrainAgent(
      state,
      join(state, 'sessions'),
      vi.fn(),
      async () => undefined,
      null,
    )
    expect(existsSync(join(state, 'brain'))).toBe(false)
    const file = join(state, 'sessions', 'harbor.jsonl')
    await agent.importBinding.bind(file)
    expect((await agent.binding.read()).sessionFile).toBe(file)
    expect(await agent.importBinding.read()).toBe(file)
    expect(agent.contribution.name).toBe('brain-curator')
  } finally {
    await rm(state, { recursive: true, force: true })
  }
})
