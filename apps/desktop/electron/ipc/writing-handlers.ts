import { app, session } from 'electron'
import { join } from 'node:path'
import { EDIT_COMMANDS, type EditCommand } from '@shared/writing'
import { handle } from './handle'
import { getWritingPrefs, setWritingPrefs } from '../store'
import { createPromptCorpus, type PromptCorpus } from '../writing/prompt-corpus'

/**
 * Settings → Writing: the spellchecker switch, the edit commands behind the
 * text-field menu, and the prompts autocomplete learns from. Spelling
 * suggestions themselves never come through here; the preload reads them
 * synchronously from `webFrame`.
 */

let corpus: PromptCorpus | null = null

/** Lazy for the same reason as store.ts: userData may still be redirected for E2E. */
function promptCorpus(): PromptCorpus {
  corpus ??= createPromptCorpus(() => join(app.getPath('userData'), 'writing', 'prompts.jsonl'))
  return corpus
}

/** The app's windows share the default session, so this switches all of them. */
export function applySpellcheck(enabled: boolean): void {
  session.defaultSession.setSpellCheckerEnabled(enabled)
}

/** One word as the spellchecker sees it: letters, no spaces, nothing paste-sized. */
function isDictionaryWord(word: unknown): word is string {
  return typeof word === 'string' && word.length > 0 && word.length <= 64 && !/\s/.test(word)
}

export function registerWritingHandlers(): void {
  handle('writing:setPrefs', (_event, prefs) => {
    const next = setWritingPrefs(prefs)
    applySpellcheck(next.spellcheck)
  })

  handle('writing:edit', (event, command) => {
    if (!EDIT_COMMANDS.includes(command)) throw new Error(`Unknown edit command: ${command}`)
    const run: Record<EditCommand, () => void> = {
      cut: () => event.sender.cut(),
      copy: () => event.sender.copy(),
      paste: () => event.sender.paste(),
      selectAll: () => event.sender.selectAll(),
    }
    run[command]()
  })

  handle('writing:learnWord', (event, word) =>
    isDictionaryWord(word) ? event.sender.session.addWordToSpellCheckerDictionary(word) : false,
  )

  handle('writing:prompts', () => promptCorpus().list())

  handle('writing:recordPrompt', async (_event, text) => {
    // Checked here too, not only in the renderer: nothing is kept while off.
    if (!getWritingPrefs().autocomplete) return
    await promptCorpus().record(text)
  })

  handle('writing:clearPrompts', () => promptCorpus().clear())
}
