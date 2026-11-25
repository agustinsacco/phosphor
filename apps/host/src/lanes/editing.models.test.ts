import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  assistantMessage,
  modelChange,
  piTranscript,
  userMessage,
} from './__fixtures__/pi-transcript'
import { editingFixture, type EditingFixture } from './__fixtures__/editing'
import { forkLane, jumpLaneTo } from './editing'

/*
 * A lane resumes with the model on its leaf's branch. A branch change on a
 * stopped lane moves the leaf, so the lane's row must follow it: the stopped
 * chip shows what resume will pick, for a lane the Host started or one whose
 * model was read from its transcript.
 */
let fx: EditingFixture
beforeEach(async () => {
  fx = await editingFixture()
})
afterEach(() => fx.close())

const GPT = { provider: 'openai-codex', id: 'gpt-5' }
const OPUS = { provider: 'pi-claude-cli', id: 'claude-opus-5' }
/** Branch B answered on GPT; then the lane switched to Opus and answered again. */
const TWO_MODELS = piTranscript([
  modelChange('m1', GPT.provider, GPT.id),
  userMessage('u1', 'first'),
  assistantMessage('a1', GPT.provider, GPT.id),
  modelChange('m2', OPUS.provider, OPUS.id),
  userMessage('u2', 'second'),
  assistantMessage('a2', OPUS.provider, OPUS.id),
])

function stoppedLane(model: { provider: string; id: string } | null) {
  const lane = fx.lane('source', [TWO_MODELS])
  if (!model) return lane
  return fx.store.updateLane(lane.laneId, {
    provider: model.provider,
    model: model.id,
    updatedAt: lane.updatedAt,
  })
}

describe('a branch change re-derives the lane’s model from its transcript', () => {
  it.each([
    ['a lane the Host started', OPUS],
    ['a lane whose model was never recorded', null],
  ])('jump on %s', async (_kind, recorded) => {
    const lane = stoppedLane(recorded)
    await jumpLaneTo(fx.ports, lane, 'a1')
    expect(fx.store.getLane(lane.laneId)).toMatchObject({ model: GPT, updatedAt: lane.updatedAt })
    expect(fx.announced).toContain(lane.laneId)
    await jumpLaneTo(fx.ports, lane, 'a2')
    expect(fx.store.getLane(lane.laneId)?.model).toEqual(OPUS)
  })

  it('jump to a branch that never picked a model clears the recorded one', async () => {
    const bare = fx.lane('bare', [
      piTranscript([
        userMessage('u0', 'hi'),
        modelChange('m1', OPUS.provider, OPUS.id),
        assistantMessage('a1', OPUS.provider, OPUS.id),
      ]),
    ])
    const lane = fx.store.updateLane(bare.laneId, { provider: OPUS.provider, model: OPUS.id })
    await jumpLaneTo(fx.ports, lane, 'u0')
    expect(fx.store.getLane(lane.laneId)?.model).toBeNull()
  })

  it('a fork at an older entry takes that branch’s model, not the source’s', async () => {
    const source = stoppedLane(OPUS)
    const forked = await forkLane(fx.ports, source, { kind: 'fork', at: 'a1', lineage: null })
    expect(forked.lane.model).toEqual(GPT)
    expect(fx.store.getLane(source.laneId)?.model).toEqual(OPUS)
  })

  it('keeps the recorded model when the branch’s model is further back than the scan reads', async () => {
    const far = fx.lane('far', [
      piTranscript([
        modelChange('m1', GPT.provider, GPT.id),
        userMessage('u1', 'x'.repeat(5 * 1024 * 1024)),
        assistantMessage('a1', GPT.provider, GPT.id),
        modelChange('m2', OPUS.provider, OPUS.id),
        userMessage('u2', 'second'),
        assistantMessage('a2', OPUS.provider, OPUS.id),
      ]),
    ])
    const lane = fx.store.updateLane(far.laneId, { provider: OPUS.provider, model: OPUS.id })
    await jumpLaneTo(fx.ports, lane, 'u1')
    expect(fx.store.getLane(lane.laneId)?.model).toEqual(OPUS)
    const forked = await forkLane(fx.ports, lane, { kind: 'fork', at: 'u1', lineage: null })
    expect(forked.lane.model).toEqual(OPUS)
  })
})

describe('a model refresh that fails never fails the edit', () => {
  const full = () => {
    throw Object.assign(new Error('database or disk is full'), { code: 'ERR_SQLITE_ERROR' })
  }

  it('jump: the leaf moves, the old model stays and the failure is logged', async () => {
    const lane = stoppedLane(OPUS)
    vi.spyOn(fx.store, 'updateLane').mockImplementation(full)
    expect(await jumpLaneTo(fx.ports, lane, 'a1')).toEqual({ previousLeaf: 'a2' })
    expect(readFileSync(lane.sessionFile!, 'utf8')).toContain('"type":"branch_summary"')
    expect(fx.store.getLane(lane.laneId)?.model).toEqual(OPUS)
    expect(fx.logged).toContain('lane.model_refresh_failed')
  })

  it('fork and rewind: the new lane and its prefs stay, with the source’s model', async () => {
    const source = stoppedLane(OPUS)
    vi.spyOn(fx.store, 'updateLane').mockImplementation(full)
    const forked = await forkLane(fx.ports, source, { kind: 'fork', at: 'a1', lineage: null })
    expect(fx.store.getLane(forked.lane.laneId)).toMatchObject({ model: OPUS, removedAt: null })
    const rewound = await forkLane(fx.ports, source, { kind: 'rewind', at: 'u1', lineage: null })
    expect(fx.store.getLane(rewound.lane.laneId)).toMatchObject({ model: OPUS, removedAt: null })
    expect(fx.prefs(rewound.lane.laneId)).toEqual({ rewound_from: source.laneId })
    expect(fx.logged.filter((m) => m === 'lane.model_refresh_failed')).toHaveLength(2)
  })
})
