import { beforeEach, describe, expect, it, vi } from 'vitest'
import { EDIT_COMMANDS } from '@shared/writing'

const state = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  getPrefs: vi.fn(),
  setPrefs: vi.fn(),
  spellcheck: vi.fn(),
  createCorpus: vi.fn(),
  corpus: { list: vi.fn(), record: vi.fn(), clear: vi.fn() },
}))

vi.mock('./sender-policy', () => ({ admitSender: () => undefined }))
vi.mock('electron', () => ({
  app: { getPath: () => '/user-data' },
  session: { defaultSession: { setSpellCheckerEnabled: state.spellcheck } },
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) =>
      state.handlers.set(channel, handler),
  },
}))
vi.mock('../store', () => ({ getWritingPrefs: state.getPrefs, setWritingPrefs: state.setPrefs }))
vi.mock('../writing/prompt-corpus', () => ({ createPromptCorpus: state.createCorpus }))

const sender = {
  id: 1,
  cut: vi.fn(),
  copy: vi.fn(),
  paste: vi.fn(),
  selectAll: vi.fn(),
  session: { addWordToSpellCheckerDictionary: vi.fn() },
}

async function invoke(channel: string, ...args: unknown[]): Promise<unknown> {
  const handler = state.handlers.get(channel)
  if (!handler) throw new Error(`no handler for ${channel}`)
  return handler({ sender }, ...args)
}

beforeEach(async () => {
  vi.resetModules()
  vi.resetAllMocks()
  state.handlers.clear()
  state.getPrefs.mockReturnValue({ spellcheck: true, autocomplete: false })
  state.setPrefs.mockReturnValue({ spellcheck: false, autocomplete: false })
  state.createCorpus.mockReturnValue(state.corpus)
  state.corpus.list.mockResolvedValue(['learned prompt'])
  sender.session.addWordToSpellCheckerDictionary.mockReturnValue(true)
  const { registerWritingHandlers } = await import('./writing-handlers')
  registerWritingHandlers()
})

describe('writing handlers runtime characterization', () => {
  it('saves prefs before applying the normalized spellcheck value', async () => {
    const input = { spellcheck: false, autocomplete: 'invalid' }
    await invoke('writing:setPrefs', input)
    expect(state.setPrefs).toHaveBeenCalledWith(input)
    expect(state.spellcheck).toHaveBeenCalledWith(false)
    expect(state.setPrefs.mock.invocationCallOrder[0]!).toBeLessThan(
      state.spellcheck.mock.invocationCallOrder[0]!,
    )
    state.setPrefs.mockImplementation(() => {
      throw new Error('prefs unavailable')
    })
    await expect(invoke('writing:setPrefs', input)).rejects.toThrow('prefs unavailable')
    expect(state.spellcheck).toHaveBeenCalledTimes(1)
  })

  it('does not create or record a corpus while autocomplete is off', async () => {
    await invoke('writing:recordPrompt', 'private prompt')
    expect(state.createCorpus).not.toHaveBeenCalled()
    expect(state.corpus.record).not.toHaveBeenCalled()
    state.getPrefs.mockReturnValue({ spellcheck: true, autocomplete: true })
    await invoke('writing:recordPrompt', 'learned prompt')
    expect(state.corpus.record).toHaveBeenCalledWith('learned prompt')
    expect(await invoke('writing:prompts')).toEqual(['learned prompt'])
    await invoke('writing:clearPrompts')
    expect(state.corpus.clear).toHaveBeenCalledOnce()
    expect(state.createCorpus).toHaveBeenCalledOnce()
  })

  it('runs every known edit on its sender and rejects malformed commands', async () => {
    for (const command of EDIT_COMMANDS) {
      await invoke('writing:edit', command)
      expect(sender[command]).toHaveBeenCalledOnce()
    }
    for (const command of ['reload', '__proto__', '', null, 42]) {
      await expect(invoke('writing:edit', command)).rejects.toThrow('Unknown edit command')
    }
    for (const command of EDIT_COMMANDS) expect(sender[command]).toHaveBeenCalledOnce()
  })

  it('rejects empty, whitespace and oversized dictionary entries before calling the sender', async () => {
    const add = sender.session.addWordToSpellCheckerDictionary
    for (const word of ['', 'two words', 'tab\tword', '\n', 'x'.repeat(65), 42, null]) {
      expect(await invoke('writing:learnWord', word)).toBe(false)
    }
    expect(add).not.toHaveBeenCalled()
    expect(await invoke('writing:learnWord', 'Phosphor')).toBe(true)
    expect(add).toHaveBeenCalledWith('Phosphor')
  })

  it('returns domain results and propagates corpus and spellchecker errors', async () => {
    state.getPrefs.mockReturnValue({ spellcheck: true, autocomplete: true })
    state.corpus.list.mockRejectedValueOnce(new Error('list failed'))
    state.corpus.record.mockRejectedValueOnce(new Error('record failed'))
    state.corpus.clear.mockRejectedValueOnce(new Error('clear failed'))
    await expect(invoke('writing:prompts')).rejects.toThrow('list failed')
    await expect(invoke('writing:recordPrompt', 'text')).rejects.toThrow('record failed')
    await expect(invoke('writing:clearPrompts')).rejects.toThrow('clear failed')
    sender.session.addWordToSpellCheckerDictionary.mockReturnValueOnce(false)
    expect(await invoke('writing:learnWord', 'word')).toBe(false)
    state.spellcheck.mockImplementation(() => {
      throw new Error('session unavailable')
    })
    await expect(invoke('writing:setPrefs', {})).rejects.toThrow('session unavailable')
  })
})
