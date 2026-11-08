import { describe, expect, it } from 'vitest'
import { MACHINE_COMMANDS_LIMIT, parseMachineCommands } from './commands'

const command = {
  name: 'skill:demo',
  description: 'Example',
  source: 'skill',
  sourceInfo: {
    path: '/home/u/.pi/agent/skills/demo/SKILL.md',
    source: 'local',
    scope: 'user',
    origin: 'top-level',
  },
}

describe('parseMachineCommands', () => {
  it('projects only the fields the menu reads', () => {
    expect(
      parseMachineCommands([
        {
          ...command,
          extra: 'private',
          sourceInfo: { ...command.sourceInfo, baseDir: '/b', secret: 1 },
        },
        { name: 'plan', source: 'prompt' },
      ]),
    ).toEqual([
      { ...command, sourceInfo: { ...command.sourceInfo, baseDir: '/b' } },
      { name: 'plan', source: 'prompt' },
    ])
  })
  it('rejects unknown sources, scopes, origins, oversized text and counts', () => {
    for (const c of [
      {},
      { ...command, name: '' },
      { ...command, name: 'a'.repeat(201) },
      { ...command, source: 'native' },
      { ...command, description: 'x'.repeat(2049) },
      { ...command, sourceInfo: { ...command.sourceInfo, scope: 'global' } },
      { ...command, sourceInfo: { ...command.sourceInfo, origin: 'npm' } },
      { ...command, sourceInfo: { ...command.sourceInfo, path: 'a\0b' } },
      { ...command, sourceInfo: 'inline' },
    ])
      expect(parseMachineCommands([c])).toBeNull()
    expect(parseMachineCommands(Array(MACHINE_COMMANDS_LIMIT).fill(command))).toHaveLength(
      MACHINE_COMMANDS_LIMIT,
    )
    expect(parseMachineCommands(Array(MACHINE_COMMANDS_LIMIT + 1).fill(command))).toBeNull()
    expect(parseMachineCommands({})).toBeNull()
  })
})
