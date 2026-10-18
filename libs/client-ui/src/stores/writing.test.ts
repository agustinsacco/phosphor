// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PhosphorApi } from '@shared/ipc'
import { MAX_LEARNED_PROMPTS } from '@shared/writing'
import type * as WritingStore from './writing'

const PROMPTS = ['ok good lets open a PR', 'ok good lets open a PR now']
const invoke = vi.fn()

/** A fresh store: the predictor and the load promise are module state. */
async function store(): Promise<typeof WritingStore.useWritingStore> {
  vi.resetModules()
  return (await import('./writing')).useWritingStore
}

beforeEach(() => {
  invoke.mockReset()
  invoke.mockImplementation(async (channel: string) =>
    channel === 'writing:prompts' ? [...PROMPTS] : undefined,
  )
  window.phosphor = { invoke } as unknown as PhosphorApi
})

afterEach(() => {
  delete (window as { phosphor?: PhosphorApi }).phosphor
})

const on = { spellcheck: true, autocomplete: true }

describe('useWritingStore', () => {
  it('predicts only with autocomplete on and the prompts loaded', async () => {
    const writing = await store()
    expect(writing.getState().predict('ok good lets op')).toBeNull()
    writing.getState().apply(on)
    expect(writing.getState().predict('ok good lets op')).toBeNull()
    await writing.getState().load()
    expect(writing.getState()).toMatchObject({ ready: true, learned: 2 })
    expect(writing.getState().predict('ok good lets op')).toBe('en a PR now')
    writing.getState().apply({ autocomplete: false })
    expect(writing.getState().predict('ok good lets op')).toBeNull()
  })

  it('tries the load again after a failure', async () => {
    const writing = await store()
    invoke.mockRejectedValueOnce(new Error('main is busy'))
    await writing.getState().load()
    expect(writing.getState().ready).toBe(false)
    await writing.getState().load()
    expect(writing.getState().ready).toBe(true)
    expect(invoke).toHaveBeenCalledTimes(2)
  })

  it('puts the prefs back when saving them fails', async () => {
    const writing = await store()
    invoke.mockRejectedValueOnce(new Error('disk full'))
    await expect(writing.getState().setPrefs({ autocomplete: true })).rejects.toThrow('disk full')
    expect(writing.getState().prefs.autocomplete).toBe(false)
  })

  it('learns a sent prompt at once, and only while on', async () => {
    const writing = await store()
    writing.getState().recordPrompt('deploy the worker to staging')
    expect(invoke).not.toHaveBeenCalledWith('writing:recordPrompt', expect.anything())

    writing.getState().apply(on)
    await writing.getState().load()
    writing.getState().recordPrompt('/compact')
    writing.getState().recordPrompt('deploy the worker to staging')
    expect(invoke).toHaveBeenCalledTimes(2) // the load, then the one learnable prompt
    expect(invoke).toHaveBeenLastCalledWith('writing:recordPrompt', 'deploy the worker to staging')
    expect(writing.getState().learned).toBe(3)
    expect(writing.getState().predict('deploy the wor')).toBe('ker to staging')
  })

  it('never counts more prompts than main keeps', async () => {
    const writing = await store()
    invoke.mockImplementation(async (channel: string) =>
      channel === 'writing:prompts'
        ? Array(MAX_LEARNED_PROMPTS).fill('the same prompt')
        : undefined,
    )
    writing.getState().apply(on)
    await writing.getState().load()
    writing.getState().recordPrompt('one more prompt')
    expect(writing.getState().learned).toBe(MAX_LEARNED_PROMPTS)
  })

  it('a failed write does not reach the send path', async () => {
    const writing = await store()
    writing.getState().apply(on)
    await writing.getState().load()
    invoke.mockRejectedValueOnce(new Error('disk full'))
    expect(() => writing.getState().recordPrompt('still sends')).not.toThrow()
    await Promise.resolve()
  })

  it('forgets everything on clear', async () => {
    const writing = await store()
    writing.getState().apply(on)
    await writing.getState().load()
    await writing.getState().clearPrompts()
    expect(invoke).toHaveBeenLastCalledWith('writing:clearPrompts')
    expect(writing.getState().learned).toBe(0)
    expect(writing.getState().predict('ok good lets op')).toBeNull()
  })
})
