import { afterEach, expect, it, vi } from 'vitest'
import type { BrainAgentRun } from '@phosphor/shared/brain-agent'
import { createAutoRun } from './auto-run'
import { BRAIN_AUTO_RUN_LIMIT_REFUSAL } from '@phosphor/shared/brain-agent'

afterEach(() => vi.useRealTimers())
function fixture() {
  vi.useFakeTimers()
  const snap = { jobs: [] as { state: string }[], prefs: { enabled: true, agentAuto: true } }
  let signature = '1:1'
  const start = vi.fn()
  const auto = createAutoRun({
    store: {
      snapshot: () => snap,
      latestRun: () => null,
      waitingCounts: () => ({
        entities: 1,
        groups: 0,
        unlinked: 0,
        repeats: 0,
        conflicts: 0,
        flags: 0,
      }),
      waitingSignature: () => signature,
    },
    queue: { accepting: true },
    defrag: { start },
    options: { agent: {} },
  } as unknown as Parameters<typeof createAutoRun>[0])
  return {
    auto,
    snap,
    start,
    tick: vi.advanceTimersByTime,
    change: () => {
      signature += '1'
    },
  }
}
it('runs once, 60 quiet seconds after the newest saved read', () => {
  const { auto, start, tick } = fixture()
  auto.changed()
  tick(60000)
  expect(start).not.toHaveBeenCalled()
  auto.readSaved()
  tick(59000)
  auto.readSaved()
  tick(59999)
  expect(start).not.toHaveBeenCalled()
  tick(1)
  expect(start).toHaveBeenCalledWith({ automatic: true })
  auto.changed()
  tick(60000)
  expect(start).toHaveBeenCalledTimes(1)
})
it.each(['queued', 'running'])('waits for a %s read and obeys the switch', (state) => {
  const { auto, start, snap, tick } = fixture()
  auto.readSaved()
  snap.jobs.push({ state })
  auto.changed()
  tick(60000)
  expect(start).not.toHaveBeenCalled()
  snap.jobs = []
  snap.prefs.agentAuto = false
  auto.changed()
  tick(60000)
  expect(start).not.toHaveBeenCalled()
})
it('requires a changed signature and backs off after a failed run', () => {
  const { auto, start, tick, change } = fixture()
  auto.readSaved()
  tick(60000)
  auto.runEnded({ automatic: true, state: 'failed' } as BrainAgentRun)
  auto.readSaved()
  tick(60000)
  expect(start).toHaveBeenCalledTimes(1)
  change()
  auto.readSaved()
  tick(60000)
  expect(start).toHaveBeenCalledTimes(1)
  tick(600000)
  expect(start).toHaveBeenCalledTimes(2)
  auto.runEnded({ automatic: true, state: 'done' } as BrainAgentRun)
  auto.readSaved()
  tick(60000)
  expect(start).toHaveBeenCalledTimes(2)
})

it('quietly consumes a read when the persisted daily cap refuses, and never retries from changed()', () => {
  const { auto, start, tick } = fixture()
  start.mockImplementationOnce(() => {
    throw new Error(BRAIN_AUTO_RUN_LIMIT_REFUSAL)
  })
  auto.readSaved()
  tick(60000)
  auto.changed()
  tick(24 * 3600000)
  expect(start).toHaveBeenCalledTimes(1)
  auto.readSaved()
  tick(60000)
  expect(start).toHaveBeenCalledTimes(2)
})

it.each(['waiting', 'failed'])('a %s read does not block the automatic run', (state) => {
  const { auto, snap, tick, start } = fixture()
  snap.jobs.push({ state })
  auto.readSaved()
  tick(60_000)
  expect(start).toHaveBeenCalledOnce()
})
it('compares signatures after manual Defrag even without a cooldown', () => {
  const { auto, start, tick, change } = fixture()
  auto.runEnded({ automatic: false, state: 'done' } as BrainAgentRun)
  auto.readSaved()
  tick(60000)
  expect(start).not.toHaveBeenCalled()
  change()
  auto.readSaved()
  tick(60000)
  expect(start).toHaveBeenCalledOnce()
})
it('doubles consecutive failure delays across a stopped run and caps them at six hours', () => {
  const { auto, start, tick, change } = fixture()
  for (const [i, minutes] of [10, 20, 40, 80, 160, 320, 360, 360].entries()) {
    auto.runEnded({ automatic: true, state: 'failed' } as BrainAgentRun)
    change()
    auto.readSaved()
    tick(minutes * 60_000 - 1)
    expect(start).toHaveBeenCalledTimes(i)
    tick(1)
    expect(start).toHaveBeenCalledTimes(i + 1)
    if (i === 0) auto.runEnded({ automatic: true, state: 'stopped' } as BrainAgentRun)
  }
})
