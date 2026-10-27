import { expect, it } from 'vitest'
import { parseSettingsPatch } from './machine-settings'
import { parseMachineSettings } from './machine-settings-result'
const patch = (value: unknown) =>
  parseSettingsPatch({
    section: 'agent',
    revision: 'a'.repeat(64),
    change: { type: 'agent.patch', patch: value },
  })
it('admits only bounded reviewed agent settings', () => {
  expect(
    patch({
      compaction: { enabled: false, reserveTokens: 16384, keepRecentTokens: 20000 },
      retry: { enabled: true, maxRetries: 5, baseDelayMs: 2000 },
      hideThinkingBlock: true,
      steeringMode: 'all',
      followUpMode: 'one-at-a-time',
    }),
  ).not.toBeNull()
  for (const invalid of [
    { retry: { maxRetries: -1 } },
    { retry: { maxRetries: 101 } },
    { compaction: { reserveTokens: 1.5 } },
    { compaction: { keepRecentTokens: Infinity } },
    { compaction: { model: 'not-reviewed' } },
    { retry: { baseDelayMs: '1000' } },
    { steeringMode: 'parallel' },
    { hideThinkingBlock: 'false' },
  ])
    expect(patch(invalid)).toBeNull()
})
it('projects reviewed behavior across the wire without returning unreviewed nested fields', () => {
  const parsed = parseMachineSettings({
    section: 'agent',
    revision: 'a'.repeat(64),
    agent: {
      contextBudget: '200k',
      autoNameLanes: true,
      compaction: { enabled: true, model: 'PRIVATE', secret: 'TOKEN' },
      retry: { enabled: false, maxRetries: 5 },
      hideThinkingBlock: true,
    },
  })
  expect(parsed?.agent).toMatchObject({
    compaction: { enabled: true },
    retry: { enabled: false, maxRetries: 5 },
    hideThinkingBlock: true,
  })
  expect(JSON.stringify(parsed)).not.toMatch(/PRIVATE|TOKEN/)
})
it('accepts old Hosts without optional agent behavior or package content counts', () => {
  expect(
    parseMachineSettings({
      section: 'agent',
      revision: 'a'.repeat(64),
      agent: { contextBudget: '200k', autoNameLanes: true },
    })?.agent,
  ).toEqual({ contextBudget: '200k', autoNameLanes: true })
  expect(
    parseMachineSettings({
      section: 'resources',
      revision: 'b'.repeat(64),
      resources: { packages: [{ name: 'pkg', spec: 'npm:pkg', installed: true, scope: 'global' }] },
    })?.resources?.packages,
  ).toHaveLength(1)
})
