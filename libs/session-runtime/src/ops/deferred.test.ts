import { describe, expect, it } from 'vitest'
import { createLaneDeferred, orderDeferred } from './deferred'
import type { LaneDeferred } from './types'

describe('orderDeferred', () => {
  it('applies model changes first and keeps one item per kind', () => {
    const items: LaneDeferred[] = [
      { kind: 'reload', what: 'MCP server' },
      { kind: 'archive' },
      { kind: 'model', provider: 'a', modelId: '1' },
      { kind: 'reload', what: 'skill' },
      { kind: 'thinking', level: 'high' },
      { kind: 'model', provider: 'b', modelId: '2' },
      { kind: 'archive' },
    ]
    expect(orderDeferred(items)).toEqual([
      { kind: 'model', provider: 'b', modelId: '2' },
      { kind: 'thinking', level: 'high' },
      { kind: 'reload', what: 'MCP server; skill' },
      { kind: 'archive' },
    ])
  })
})

describe('createLaneDeferred', () => {
  it('logs a refused or failing apply and forgets the items', async () => {
    const logged: string[] = []
    let calls = 0
    const queue = createLaneDeferred(
      {
        deferred: {
          apply: async () => {
            calls++
            if (calls === 2) throw new Error('gone')
            return { ok: false, message: 'Claude gate' }
          },
        },
      },
      (_scope, message) => logged.push(message),
    )
    queue.hold('s', [{ kind: 'stop' }])
    await queue.settled('s')
    queue.hold('s', [{ kind: 'stop' }])
    await queue.settled('s')
    await queue.settled('s')
    expect(calls).toBe(2)
    expect(logged).toEqual(['deferred work did not apply', 'deferred work failed'])
  })

  it('drops held work and the reload claim on cancel', () => {
    const queue = createLaneDeferred(
      { deferred: { apply: async () => ({ ok: true }) } },
      () => undefined,
    )
    queue.hold('s', [{ kind: 'compact' }])
    expect(queue.claimReload('s')).toBe(true)
    expect(queue.claimReload('s')).toBe(false)
    queue.cancel('s')
    expect(queue.pending('s')).toEqual([])
    expect(queue.claimReload('s')).toBe(true)
  })
})
