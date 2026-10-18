import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { PromptCorpus } from './prompt-corpus'

const state = vi.hoisted(() => ({
  getPath: vi.fn<(name: string) => string>(),
  getSession: vi.fn(),
  createCorpus: vi.fn<(filePath: () => string) => PromptCorpus>(),
  corpus: { list: vi.fn(), record: vi.fn(), clear: vi.fn() },
}))

vi.mock('electron', () => ({
  app: { getPath: state.getPath },
  session: {
    get defaultSession() {
      return state.getSession()
    },
  },
}))
vi.mock('./prompt-corpus', () => ({ createPromptCorpus: state.createCorpus }))

beforeEach(() => {
  vi.resetModules()
  vi.resetAllMocks()
  state.getPath.mockReturnValue('/initial-user-data')
  state.createCorpus.mockReturnValue(state.corpus)
})

describe('writing runtime', () => {
  it('does not look up userData, create a corpus or bind a session at import time', async () => {
    await import('./runtime')
    expect(state.getPath).not.toHaveBeenCalled()
    expect(state.createCorpus).not.toHaveBeenCalled()
    expect(state.getSession).not.toHaveBeenCalled()
  })

  it('lazily creates one corpus with a path callback that follows redirected userData', async () => {
    const { promptCorpus } = await import('./runtime')
    expect(promptCorpus()).toBe(state.corpus)
    expect(state.getPath).not.toHaveBeenCalled()
    expect(promptCorpus()).toBe(state.corpus)
    expect(state.createCorpus).toHaveBeenCalledOnce()
    const [filePath] = state.createCorpus.mock.calls[0]!
    state.getPath.mockReturnValue('/redirected-user-data')
    expect(filePath()).toBe(join('/redirected-user-data', 'writing', 'prompts.jsonl'))
    expect(state.getPath).toHaveBeenCalledWith('userData')
    state.getPath.mockReturnValue('/later-user-data')
    expect(filePath()).toBe(join('/later-user-data', 'writing', 'prompts.jsonl'))
  })

  it('applies each spellcheck change to the current defaultSession with its receiver intact', async () => {
    const { applySpellcheck } = await import('./runtime')
    const first = { setSpellCheckerEnabled: vi.fn() }
    const second = { setSpellCheckerEnabled: vi.fn() }
    state.getSession.mockReturnValueOnce(first).mockReturnValueOnce(second)
    applySpellcheck(false)
    applySpellcheck(true)
    expect(first.setSpellCheckerEnabled).toHaveBeenCalledWith(false)
    expect(second.setSpellCheckerEnabled).toHaveBeenCalledWith(true)
    expect(first.setSpellCheckerEnabled.mock.contexts[0]).toBe(first)
    expect(second.setSpellCheckerEnabled.mock.contexts[0]).toBe(second)
    expect(state.createCorpus).not.toHaveBeenCalled()
    expect(state.getPath).not.toHaveBeenCalled()
  })
})
