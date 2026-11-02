import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { parseSettingsPatch, parseSettingsRead } from './machine-settings'
import { parseMachineSettings } from './machine-settings-result'
import { GLOBAL_INSTRUCTIONS_MAX_BYTES } from './global-instructions'

const revision = 'a'.repeat(64)
const repositoryId = '0123456789abcdef'
const patch = (change: unknown, section: string, extra = {}) =>
  parseSettingsPatch({ section, revision, change, ...extra })
const sha = (text: string) => createHash('sha256').update(text).digest('hex')

describe('Host global instructions', () => {
  it('reads and writes the machine file only, never a folder’s', () => {
    expect(parseSettingsRead({ section: 'instructions' })).toEqual({ section: 'instructions' })
    expect(parseSettingsRead({ section: 'instructions', repositoryId })).toBeNull()
    const write = { type: 'instructions.write', content: '# Mine\n' }
    expect(patch(write, 'instructions')).toMatchObject({ change: write })
    expect(patch(write, 'instructions', { repositoryId })).toBeNull()
    expect(patch(write, 'agent')).toBeNull()
  })

  it('refuses text pi would not load as written', () => {
    const write = (content: unknown) =>
      patch({ type: 'instructions.write', content }, 'instructions')
    expect(write('a\0b')).toBeNull()
    expect(write(42)).toBeNull()
    expect(write('x'.repeat(GLOBAL_INSTRUCTIONS_MAX_BYTES + 1))).toBeNull()
    // Bytes, not UTF-16 units: three bytes each.
    expect(write('€'.repeat(GLOBAL_INSTRUCTIONS_MAX_BYTES / 3 + 1))).toBeNull()
    expect(write('x'.repeat(GLOBAL_INSTRUCTIONS_MAX_BYTES))).toBeTruthy()
    expect(
      patch({ type: 'instructions.write', content: 'a', path: '/etc/passwd' }, 'instructions'),
    ).toBeNull()
  })

  it('accepts a read whose revision is the file’s own', () => {
    const content = 'Be brief.\n'
    const instructions = {
      path: '/home/me/.pi/agent/AGENTS.md',
      content,
      revision: sha(content),
      exists: true,
    }
    const read = { section: 'instructions', revision: sha(content), instructions }
    expect(parseMachineSettings(read)).toEqual(read)
    expect(parseMachineSettings({ ...read, revision })).toBeNull()
    expect(parseMachineSettings({ ...read, repositoryId })).toBeNull()
    expect(
      parseMachineSettings({ ...read, instructions: { ...instructions, content: 1 } }),
    ).toBeNull()
  })
})

describe('Host directive toggles', () => {
  const agent = { contextBudget: '', autoNameLanes: true }

  it('are Host policy: machine-wide, booleans, known blocks only', () => {
    const toggle = (agentDirectives: unknown, extra = {}) =>
      patch({ type: 'agent.patch', patch: { agentDirectives } }, 'agent', extra)
    expect(toggle({ laneCharter: false })).toBeTruthy()
    expect(toggle({ laneCharter: false }, { repositoryId })).toBeNull()
    expect(toggle({ laneCharter: 'no' })).toBeNull()
    expect(toggle({ custom: 'text' })).toBeNull()
    expect(toggle(['laneCharter'])).toBeNull()
  })

  it('are read back completed from the defaults, and absent from older Hosts', () => {
    expect(
      parseMachineSettings({ section: 'agent', revision, agent })?.agent?.agentDirectives,
    ).toBeUndefined()
    expect(
      parseMachineSettings({
        section: 'agent',
        revision,
        agent: { ...agent, agentDirectives: { laneCharter: false, custom: 'x' } },
      })?.agent?.agentDirectives,
    ).toEqual({
      machineAwareness: true,
      worktreeGuard: true,
      laneCharter: false,
      subagentPolicy: true,
    })
  })
})
