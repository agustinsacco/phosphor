import { describe, expect, it } from 'vitest'
import { parseClientFrame } from '../host-protocol'

const REQUEST = '00000000-0000-4000-8000-000000000003'
const REPO = 'fedcba9876543210'
const THINKING = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']
const command = (op: unknown) =>
  parseClientFrame(JSON.stringify({ type: 'command', requestId: REQUEST, op }))
const accepted = (op: unknown) => ({ ok: true, frame: { type: 'command', requestId: REQUEST, op } })
const refused = (code: string) => ({
  ok: false,
  reason: 'command',
  reply: { kind: 'receipt', requestId: REQUEST, code },
})

// Characterization through the public entry, before op parsing moves to client-ops.ts.
describe('command ops through the public entry', () => {
  it('projects message ops, keeping streamingBehavior on prompt only', () => {
    expect(command({ type: 'prompt', message: 'm' })).toStrictEqual(
      accepted({ type: 'prompt', message: 'm' }),
    )
    expect(command({ type: 'steer', message: 'm', streamingBehavior: 'steer' })).toStrictEqual(
      accepted({ type: 'steer', message: 'm' }),
    )
    expect(command({ type: 'follow_up', message: 'm', images: [] })).toStrictEqual(
      accepted({ type: 'follow_up', message: 'm', images: [] }),
    )
    for (const streamingBehavior of ['steer', 'followUp'])
      expect(command({ type: 'prompt', message: 'm', streamingBehavior })).toStrictEqual(
        accepted({ type: 'prompt', message: 'm', streamingBehavior }),
      )
    for (const op of [
      { type: 'prompt', message: 'm', streamingBehavior: null },
      { type: 'steer', message: 1 },
    ])
      expect(command(op)).toStrictEqual(refused('bad-request'))
  })

  it('projects field ops to their own fields', () => {
    const cases = [
      [{ type: 'compact', x: 1 }, { type: 'compact' }],
      [
        { type: 'set_model', provider: 'p', modelId: 'm', x: 1 },
        { type: 'set_model', provider: 'p', modelId: 'm' },
      ],
      [
        { type: 'lane.markRead', upTo: 0, x: 1 },
        { type: 'lane.markRead', upTo: 0 },
      ],
      [
        { type: 'set_session_name', name: 'x'.repeat(80) },
        { type: 'set_session_name', name: 'x'.repeat(80) },
      ],
    ] as const
    for (const [input, output] of cases) expect(command(input)).toStrictEqual(accepted(output))
    for (const level of THINKING)
      expect(command({ type: 'set_thinking_level', level })).toStrictEqual(
        accepted({ type: 'set_thinking_level', level }),
      )
    for (const op of [
      { type: 'set_session_name', name: 'x'.repeat(81) },
      { type: 'lane.markRead' },
    ])
      expect(command(op)).toStrictEqual(refused('bad-request'))
  })

  it('projects lane.create with only the optional fields given', () => {
    const minimal = { type: 'lane.create', repositoryId: REPO, worktree: null }
    expect(command({ ...minimal, x: 1 })).toStrictEqual(accepted(minimal))
    const branch = { ...minimal, worktree: { branch: 'b' } }
    expect(command(branch)).toStrictEqual(accepted(branch))
    expect(command({ ...minimal, worktree: { branch: 'b', fresh: true } })).toStrictEqual(
      accepted({ ...minimal, worktree: { branch: 'b', fresh: true } }),
    )
    for (const thinkingLevel of THINKING)
      expect(command({ ...minimal, thinkingLevel })).toStrictEqual(
        accepted({ ...minimal, thinkingLevel }),
      )
  })

  it('refuses lane.create field by field', () => {
    const minimal = { type: 'lane.create', repositoryId: REPO, worktree: null }
    for (const patch of [
      { repositoryId: REPO.toUpperCase() },
      { worktree: undefined },
      { worktree: 'b' },
      { worktree: { branch: '-b' } },
      { worktree: { branch: 'b', fresh: 'true' } },
      { name: '' },
      { provider: 'p'.repeat(201) },
      { model: '' },
      { thinkingLevel: 'auto' },
    ])
      expect(command({ ...minimal, ...patch }), JSON.stringify(patch)).toStrictEqual(
        refused('bad-request'),
      )
  })

  it('hands each family prefix to its own parser and classifies unknown members', () => {
    for (const type of [
      'terminal.foo',
      'routine.foo',
      'host.repositories.foo',
      'files.foo',
      'lane.foo',
    ])
      expect(command({ type }), type).toStrictEqual(refused('unsupported'))
    for (const type of ['lane.delete', 'provider.login', 'terminal.kill', 'routine.run'])
      expect(command({ type }), type).toStrictEqual(refused('bad-request'))
    for (const type of ['files.delete', 'attachments.commit'])
      expect(command({ type }), type).toStrictEqual(refused('unsupported'))
  })
})
