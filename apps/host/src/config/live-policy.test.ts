import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { DEFAULT_AGENT_DIRECTIVES } from '@phosphor/shared/models'
import { hostDirectives } from './directives'

let dir: string
let configPath: string
const config = (extra = {}) =>
  JSON.stringify({
    version: 1,
    pi: { executable: '/usr/bin/pi' },
    repositories: ['/srv'],
    ...extra,
  })

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'host-directives-'))
  configPath = join(dir, 'config.json')
})
afterEach(() => rm(dir, { recursive: true, force: true }))

it('reads the toggles at each call, so the next lane sees a saved change', async () => {
  await writeFile(configPath, config(), { mode: 0o600 })
  const read = hostDirectives(configPath, {})
  expect(read()).toEqual(DEFAULT_AGENT_DIRECTIVES)
  await writeFile(configPath, config({ agentDirectives: { laneCharter: false } }))
  expect(read()).toEqual({ ...DEFAULT_AGENT_DIRECTIVES, laneCharter: false })
})

it('keeps the toggles it started with when the config is unreadable or invalid', async () => {
  const read = hostDirectives(configPath, { agentDirectives: { subagentPolicy: false } })
  await writeFile(configPath, '{"version":', { mode: 0o600 })
  expect(read().subagentPolicy).toBe(false)
  await writeFile(configPath, config({ agentDirectives: { laneCharter: 'no' } }))
  expect(read()).toEqual({ ...DEFAULT_AGENT_DIRECTIVES, subagentPolicy: false })
})
