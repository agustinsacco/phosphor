import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { normalizeWritingPrefs, type WritingPrefs } from '@shared/writing'

const state = vi.hoisted(() => ({
  userData: '',
  prefs: { spellcheck: true, autocomplete: false } as WritingPrefs,
  spellcheck: [] as boolean[],
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
}))

vi.mock('electron', () => ({
  app: { getPath: () => state.userData },
  session: {
    defaultSession: { setSpellCheckerEnabled: (on: boolean) => state.spellcheck.push(on) },
  },
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) =>
      state.handlers.set(channel, handler),
  },
}))

vi.mock('../store', () => ({
  getWritingPrefs: () => state.prefs,
  setWritingPrefs: (value: unknown) => (state.prefs = normalizeWritingPrefs(value)),
}))

/** The renderer's side of a call: an event whose sender is the window. */
function sender() {
  return {
    cut: vi.fn(),
    copy: vi.fn(),
    paste: vi.fn(),
    selectAll: vi.fn(),
    session: { addWordToSpellCheckerDictionary: vi.fn(() => true) },
  }
}

let window = sender()
const invoke = async (channel: string, ...args: unknown[]): Promise<unknown> => {
  const handler = state.handlers.get(channel)
  if (!handler) throw new Error(`no handler for ${channel}`)
  return handler({ sender: window }, ...args)
}
const promptsFile = (): string => join(state.userData, 'writing', 'prompts.jsonl')

beforeEach(async () => {
  vi.resetModules()
  state.userData = mkdtempSync(join(tmpdir(), 'phosphor-writing-'))
  state.prefs = { spellcheck: true, autocomplete: false }
  state.spellcheck = []
  state.handlers.clear()
  window = sender()
  const { registerWritingHandlers } = await import('./writing-handlers')
  registerWritingHandlers()
})

afterEach(() => {
  rmSync(state.userData, { recursive: true, force: true })
})

describe('writing handlers', () => {
  it('keeps nothing while autocomplete is off', async () => {
    await invoke('writing:recordPrompt', 'a private prompt')
    expect(existsSync(promptsFile())).toBe(false)
    expect(await invoke('writing:prompts')).toEqual([])

    state.prefs = { spellcheck: true, autocomplete: true }
    await invoke('writing:recordPrompt', 'a learned prompt')
    expect(await invoke('writing:prompts')).toEqual(['a learned prompt'])
    await invoke('writing:clearPrompts')
    expect(await invoke('writing:prompts')).toEqual([])
    expect(existsSync(promptsFile())).toBe(false)
  })

  it('normalizes saved prefs and applies the spellcheck switch', async () => {
    await invoke('writing:setPrefs', { spellcheck: false, autocomplete: 'yes' })
    expect(state.prefs).toEqual({ spellcheck: false, autocomplete: false })
    expect(state.spellcheck).toEqual([false])
  })

  it('runs only the known edit commands, on the sender', async () => {
    await invoke('writing:edit', 'paste')
    expect(window.paste).toHaveBeenCalledOnce()
    await expect(invoke('writing:edit', 'reload')).rejects.toThrow('Unknown edit command')
    await expect(invoke('writing:edit', '__proto__')).rejects.toThrow('Unknown edit command')
  })

  it('adds only a single word to the dictionary', async () => {
    const add = window.session.addWordToSpellCheckerDictionary
    for (const bad of ['', 'two words', 'x'.repeat(65), 42, null]) {
      expect(await invoke('writing:learnWord', bad)).toBe(false)
    }
    expect(add).not.toHaveBeenCalled()
    expect(await invoke('writing:learnWord', 'Phosphor')).toBe(true)
    expect(add).toHaveBeenCalledWith('Phosphor')
  })
})
