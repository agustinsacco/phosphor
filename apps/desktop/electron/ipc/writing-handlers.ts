import { EDIT_COMMANDS, type EditCommand } from '@shared/writing'
import { handle } from './handle'
import { getWritingPrefs, setWritingPrefs } from '../store'
import { applySpellcheck, promptCorpus } from '../writing/runtime'

export { applySpellcheck } from '../writing/runtime'

/**
 * Settings → Writing: the spellchecker switch, the edit commands behind the
 * text-field menu, and the prompts autocomplete learns from. Spelling
 * suggestions themselves never come through here; the preload reads them
 * synchronously from `webFrame`.
 */

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
