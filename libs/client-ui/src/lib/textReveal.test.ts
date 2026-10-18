import { describe, expect, it } from 'vitest'
import { advanceReveal, sliceAtCodePoint, type RevealState } from './textReveal'

/**
 * Replay of the measured Claude Code cadence: a 1,121-char answer arriving
 * as 12 chunks of ~93 chars, ~550ms apart (recorded 2026-08-27 against
 * claude -p --include-partial-messages). The reveal must stay busy between
 * chunks and never fall far behind the producer.
 */
function simulate(
  chunks: Array<{ at: number; length: number }>,
  frameMs = 16,
  settleAt?: number,
): Array<{ at: number; visible: number; target: number }> {
  const trace: Array<{ at: number; visible: number; target: number }> = []
  let state: RevealState = { visible: 0, lastTick: 0 }
  const end = chunks[chunks.length - 1]!.at + 2000
  for (let now = 0; now <= end; now += frameMs) {
    const target = chunks.reduce((n, c) => (c.at <= now ? n + c.length : n), 0)
    const streaming = settleAt === undefined || now < settleAt
    state = advanceReveal(state, target, now, streaming)
    trace.push({ at: now, visible: state.visible, target })
  }
  return trace
}

const MEASURED = Array.from({ length: 12 }, (_, i) => ({ at: i * 550, length: 93 }))

describe('advanceReveal against the recorded provider cadence', () => {
  it('keeps revealing between chunks instead of pausing at each slab', () => {
    const trace = simulate(MEASURED)
    // Mid-gap frames (roughly halfway between chunk 2 and chunk 3) must be
    // actively advancing — the whole point is no stall-then-slab rhythm.
    const during = trace.filter((t) => t.at > 1200 && t.at < 1600)
    for (let i = 1; i < during.length; i++) {
      expect(during[i]!.visible).toBeGreaterThan(during[i - 1]!.visible)
    }
  })

  it('never lags the producer by more than about two chunks', () => {
    const trace = simulate(MEASURED)
    for (const t of trace) {
      expect(t.target - t.visible).toBeLessThanOrEqual(93 * 2 + 1)
    }
  })

  it('finishes shortly after the last chunk', () => {
    const trace = simulate(MEASURED)
    const total = 12 * 93
    const done = trace.find((t) => t.visible >= total)!
    const lastChunkAt = 11 * 550
    expect(done.at - lastChunkAt).toBeLessThan(1500)
  })

  it('drains the remainder fast once the turn settles, without snapping', () => {
    const settleAt = 11 * 550 + 50
    const trace = simulate(MEASURED, 16, settleAt)
    const afterSettle = trace.filter((t) => t.at >= settleAt && t.visible < 12 * 93)
    // Still animated (more than one frame), but brief.
    expect(afterSettle.length).toBeGreaterThan(1)
    expect(afterSettle.length).toBeLessThan(40) // < ~640ms of frames
    // No single frame jumps the whole tail in at once.
    for (let i = 1; i < afterSettle.length; i++) {
      expect(afterSettle[i]!.visible - afterSettle[i - 1]!.visible).toBeLessThan(93)
    }
  })

  it('snaps only when the target shrinks (block replaced)', () => {
    const state: RevealState = { visible: 500, lastTick: 0 }
    expect(advanceReveal(state, 200, 16, true).visible).toBe(200)
  })

  it('caps the rate so a giant paste stays readable', () => {
    let state: RevealState = { visible: 0, lastTick: 0 }
    state = advanceReveal(state, 100_000, 16, true)
    expect(state.visible).toBeLessThanOrEqual(8 * 16 + 1)
  })
})

describe('sliceAtCodePoint', () => {
  it('slices plain text at the requested length', () => {
    expect(sliceAtCodePoint('hello world', 5)).toBe('hello')
  })

  it('returns the whole text at or past the end', () => {
    expect(sliceAtCodePoint('hi', 2)).toBe('hi')
    expect(sliceAtCodePoint('hi', 99)).toBe('hi')
  })

  it('never splits a surrogate pair', () => {
    const text = 'ab\u{1F600}cd' // 😀 is two UTF-16 units at index 2-3
    expect(sliceAtCodePoint(text, 3)).toBe('ab') // cut lands mid-emoji
    expect(sliceAtCodePoint(text, 4)).toBe('ab\u{1F600}')
  })

  it('floors fractional lengths from the pacing math', () => {
    expect(sliceAtCodePoint('abcdef', 3.9)).toBe('abc')
  })
})
