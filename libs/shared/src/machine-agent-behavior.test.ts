import { expect, it } from 'vitest'
import { parseSettingsPatch } from './machine-settings'
import { parseMachineSettings } from './machine-settings-result'
import {
  AGENT_FIELDS,
  agentFieldValue,
  validAgentBehavior,
  withAgentField,
} from './machine-agent-behavior'
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
it('validates each whole-number field at the bounds the field table gives it', () => {
  for (const field of Object.values(AGENT_FIELDS)) {
    if (field.kind !== 'int') continue
    const [group, name] = field.path
    const valid = (value: number) => validAgentBehavior(group, { [name]: value })
    expect([valid(field.min), valid(field.max), valid(field.piDefault)]).toEqual([true, true, true])
    expect([valid(field.min - 1), valid(field.max + 1)]).toEqual([false, false])
  }
})
it('sets and clears a field, merging a nested group one level and dropping it once empty', () => {
  const settings = { compaction: { enabled: false, reserveTokens: 50000 }, steeringMode: 'all' }
  const path = AGENT_FIELDS['compaction.enabled'].path
  expect(agentFieldValue(settings, path)).toBe(false)
  expect(withAgentField(settings, path, true).compaction).toEqual({
    enabled: true,
    reserveTokens: 50000,
  })
  const cleared = withAgentField(
    withAgentField(settings, path, undefined),
    AGENT_FIELDS['compaction.reserveTokens'].path,
    undefined,
  )
  expect(cleared).toEqual({ steeringMode: 'all' })
  expect(withAgentField(cleared, AGENT_FIELDS.steeringMode.path, undefined)).toEqual({})
  expect(settings.compaction).toEqual({ enabled: false, reserveTokens: 50000 })
})
