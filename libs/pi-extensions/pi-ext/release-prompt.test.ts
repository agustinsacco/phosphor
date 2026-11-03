import { describe, expect, it } from 'vitest'
import { MEMORY_MAX } from './release-lease'
import { applyReleaseContext, passMessage, releasePrompt, RELEASE_SECTION } from './release-prompt'

describe('release prompt', () => {
  it('gives the holder the manual with its epoch, and a standby only the standby rule', () => {
    const active = releasePrompt('active', 4)
    expect(active).toContain('This lane holds the release lease (epoch 4).')
    expect(active).toContain('Merge only with release_merge.')
    expect(active).toContain("Don't rebuild a lane's reasoning to fix its logic")
    const standby = releasePrompt('standby', 4)
    expect(standby).toContain('change nothing on GitHub')
    expect(standby).not.toContain('release_merge')
  })

  it('adds the section to the first system message per request and removes a recorded one', () => {
    const messages = [
      { role: 'system', sections: { preamble: 'keep', [RELEASE_SECTION]: 'stale' } },
      { role: 'user', content: 'hi' },
      { role: 'system', sections: { [RELEASE_SECTION]: 'old fork' } },
    ]
    applyReleaseContext(messages, 'now')
    expect(messages[0]?.sections).toEqual({ preamble: 'keep', [RELEASE_SECTION]: 'now' })
    expect(messages[2]?.sections).toEqual({})
    applyReleaseContext(messages, undefined)
    expect(messages[0]?.sections).toEqual({ preamble: 'keep' })
  })

  it('states why a pass started, the queue, the memory and recent events', () => {
    const facts = {
      pass: 3,
      epoch: 2,
      base: 'main',
      changes: ['+ #4 aaaaaaa ready checks passing', '- #4 aaaaaaa ready checks pending'],
      queue: ['main bbbbbbb CI: passing', '#4 aaaaaaa ready checks passing'],
      memory: '',
      ledger: [
        ...Array.from({ length: 12 }, (_, i) =>
          JSON.stringify({ at: `2026-11-0${(i % 9) + 1}`, text: `e${i}` }),
        ),
        'not json',
      ],
    }
    const changed = passMessage({ ...facts, reason: 'changed' })
    expect(changed).toContain('Release pass 3 (epoch 2, base main).')
    expect(changed).toContain('Changed since the last pass:\n+ #4 aaaaaaa ready checks passing')
    expect(changed).toContain('Memory:\n(empty)')
    expect(changed).not.toContain(' e2\n')
    expect(changed).toContain('e11\nnot json')
    expect(passMessage({ ...facts, reason: 'first' })).toContain('read the queue in full')
    expect(passMessage({ ...facts, reason: 'sweep', ledger: [] })).not.toContain('Recent events')
  })

  it('cuts memory past the limit short in the pass, and says how to keep it', () => {
    const memory = `${'x'.repeat(MEMORY_MAX)}TAIL`
    const facts = { pass: 1, epoch: 1, base: 'main', changes: [], queue: [], ledger: [] }
    const text = passMessage({ ...facts, reason: 'sweep', memory })
    expect(text).not.toContain('TAIL')
    expect(text).toContain(
      `Memory (only the first ${MEMORY_MAX} of ${MEMORY_MAX + 4} characters; save a summary with release_memory):`,
    )
  })
})
