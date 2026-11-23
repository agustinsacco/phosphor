import { describe, expect, it } from 'vitest'
import { OPS_LIMITS } from '../host-protocol-ops'
import {
  LANE_LIVENESS_OP,
  OP_METHOD,
  OP_REPLY_CODES,
  OP_TITLE,
  noOwnerReply,
  parseOpChannelRequest,
} from '../ops'

const DIGEST = 'ab'.repeat(32)
const CONFIRM = { confirmId: '00000000-0000-4000-8000-000000000001', digest: DIGEST }
const ARGV = {
  v: 1,
  id: 'op-1',
  argv: ['instructions', 'edit', '--project'],
  content: '# Rules',
  reason: 'User asked for it',
  confirm: CONFIRM,
  deadlineMs: 30_000,
  facts: {
    swarm: { available: true, requested: false, enabled: false, lastBy: 'user', userOff: true },
    contextFiles: { off: ['claude'], userOff: [] },
    subagentsLive: false,
  },
} as const
const parse = (v: unknown) => parseOpChannelRequest(JSON.stringify(v))

describe('op channel constants', () => {
  it('uses the editor method and a versioned title', () => {
    expect(OP_METHOD).toBe('editor')
    expect(OP_TITLE).toBe('phosphor-op/v1')
    expect(noOwnerReply('op-1')).toStrictEqual({
      v: 1,
      id: 'op-1',
      status: 'unsupported',
      code: 'no-owner',
    })
    expect(OP_REPLY_CODES).toContain('timeout')
  })
})

describe('parseOpChannelRequest', () => {
  it('reads a command line with content and facts unchanged', () => {
    expect(parse(ARGV)).toStrictEqual(ARGV)
  })

  it('reads a structured op and the internal liveness message', () => {
    const brain = { v: 1, id: 'b1', op: 'brain.search', input: { query: 'x' }, deadlineMs: 5_000 }
    expect(parse(brain)).toStrictEqual(brain)
    const live = { v: 1, id: 'l1', op: LANE_LIVENESS_OP, subagents: 2 }
    expect(parse(live)).toStrictEqual(live)
    expect(parse({ ...live, subagents: -1 })).toBeNull()
  })

  it('needs exactly one of argv and op, and bounds content inside the args budget', () => {
    const { argv: _argv, ...bare } = ARGV
    expect(parse(bare)).toBeNull()
    expect(parse({ ...ARGV, op: 'help' })).toBeNull()
    expect(parse({ ...ARGV, input: {} })).toBeNull()
    expect(parse({ ...ARGV, content: 'x'.repeat(OPS_LIMITS.contentBytes + 1) })).toBeNull()
    const fits = 'x'.repeat(OPS_LIMITS.contentBytes)
    expect(parse({ ...ARGV, content: fits })).not.toBeNull()
    const argv = Array.from({ length: 13 }, () => 'y'.repeat(4096))
    expect(parse({ ...ARGV, argv, content: fits })).toBeNull()
  })

  it('refuses bad ids, deadlines, confirms, facts and non-JSON', () => {
    for (const bad of [
      { id: '' },
      { id: 'a b' },
      { v: 2 },
      { deadlineMs: 0 },
      { deadlineMs: 600_001 },
      { confirm: { confirmId: 'x', digest: DIGEST } },
      { facts: { swarm: { available: true } } },
      { facts: { subagentsLive: 'yes' } },
      { reason: '' },
    ])
      expect(parse({ ...ARGV, ...bad }), JSON.stringify(bad)).toBeNull()
    expect(parseOpChannelRequest('{')).toBeNull()
  })
})
