import { expect, it, vi } from 'vitest'
import { BRAIN_CURATOR_METHODS } from '@phosphor/shared/brain-agent'
import brainAgentGuard, { BRAIN_AGENT_GUARD_COMMAND } from './brain-agent-guard'

function load() {
  const on = vi.fn()
  const registerCommand = vi.fn()
  brainAgentGuard({ on, registerCommand })
  expect(on).toHaveBeenCalledWith('tool_call', expect.any(Function))
  const guard = on.mock.calls.find(([event]) => event === 'tool_call')![1] as (
    event: unknown,
  ) => unknown
  return { guard, registerCommand }
}

it('allows exactly Brain Agent’s own tools', () => {
  const { guard } = load()
  for (const method of BRAIN_CURATOR_METHODS)
    expect(guard({ toolName: `brain_${method}` })).toBeUndefined()
})

it('blocks built-in, extension, MCP and unnamed tools', () => {
  const { guard } = load()
  for (const toolName of [
    'bash',
    'read',
    'edit',
    'write',
    'grep',
    'mcp',
    'linear_search_issues',
    'subagent',
    'brain_flag',
    'brain_waiting ',
    'Brain_waiting',
    '',
    undefined,
  ])
    expect(guard({ toolName })).toEqual({ block: true, reason: expect.any(String) })
  expect(guard(null)).toEqual({ block: true, reason: expect.any(String) })
})

it('proves it loaded through a command that does nothing', async () => {
  const { registerCommand } = load()
  expect(registerCommand).toHaveBeenCalledWith(BRAIN_AGENT_GUARD_COMMAND, {
    description: expect.any(String),
    handler: expect.any(Function),
  })
  const [, command] = registerCommand.mock.calls[0]! as [
    string,
    { handler(args: string): Promise<void> },
  ]
  await expect(command.handler('anything')).resolves.toBeUndefined()
})
