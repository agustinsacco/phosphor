import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { DEFAULT_AGENT_DIRECTIVES } from '@phosphor/shared/models'
import { hostContextBudget, hostDirectives } from './live-policy'

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

it('reads the context budget at each call, so the next lane sees a saved change', async () => {
  await writeFile(configPath, config(), { mode: 0o600 })
  const read = hostContextBudget(configPath, { contextBudget: '300k' })
  expect(read()).toBe('')
  await writeFile(configPath, config({ contextBudget: '150k' }))
  expect(read()).toBe('150k')
})

it('keeps the last valid budget when the config becomes unreadable', async () => {
  await writeFile(configPath, config({ contextBudget: '150k' }), { mode: 0o600 })
  const read = hostContextBudget(configPath, { contextBudget: '300k' })
  expect(read()).toBe('150k')
  await writeFile(configPath, '{"version":')
  expect(read()).toBe('150k')
})

it('keeps the budget it started with when the config is unreadable or invalid', async () => {
  const read = hostContextBudget(configPath, { contextBudget: '300k' })
  await writeFile(configPath, '{"version":', { mode: 0o600 })
  expect(read()).toBe('300k')
  await writeFile(configPath, config({ contextBudget: '77k' }))
  expect(read()).toBe('300k')
  expect(hostContextBudget(join(dir, 'missing.json'), {})()).toBe('')
})
