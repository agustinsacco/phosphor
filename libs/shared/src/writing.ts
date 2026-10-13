/**
 * Writing help in Phosphor's own text fields (`AppPrefs.writing`, Settings →
 * Writing): spelling suggestions on right-click and local autocomplete learned
 * from the prompts you send. Neither one calls a model.
 */

export interface WritingPrefs {
  /** Chromium's spellchecker: underlines plus right-click suggestions. */
  spellcheck: boolean
  /**
   * Ghost-text completion in the composers. While on, every prompt sent from
   * a composer is kept in `<userData>/writing/prompts.jsonl` to learn from.
   */
  autocomplete: boolean
}

export const DEFAULT_WRITING_PREFS: WritingPrefs = { spellcheck: true, autocomplete: false }

/** User-editable JSON in, two booleans out. Spelling is on unless set false. */
export function normalizeWritingPrefs(raw: unknown): WritingPrefs {
  const value = raw && typeof raw === 'object' ? (raw as Partial<WritingPrefs>) : {}
  return { spellcheck: value.spellcheck !== false, autocomplete: value.autocomplete === true }
}

/** Edit commands the text-field menu asks main to run on the focused field. */
export type EditCommand = 'cut' | 'copy' | 'paste' | 'selectAll'

export const EDIT_COMMANDS: readonly EditCommand[] = ['cut', 'copy', 'paste', 'selectAll']

/** Prompts kept to learn from; the oldest drop off past this. */
export const MAX_LEARNED_PROMPTS = 2000

/** Longer prompts are pasted logs or files, not writing worth learning from. */
export const MAX_LEARNED_PROMPT_CHARS = 2000

/**
 * Whether a sent prompt is worth learning from: not a slash command, not a
 * `!` shell command, not empty, not a paste-sized blob.
 */
export function isLearnablePrompt(text: string): boolean {
  const trimmed = text.trim()
  return (
    trimmed.length > 0 &&
    trimmed.length <= MAX_LEARNED_PROMPT_CHARS &&
    !trimmed.startsWith('/') &&
    !trimmed.startsWith('!')
  )
}
