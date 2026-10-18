import { app, session } from 'electron'
import { join } from 'node:path'
import { createPromptCorpus, type PromptCorpus } from './prompt-corpus'

let corpus: PromptCorpus | null = null

/** Lazy for the same reason as store.ts: userData may still be redirected for E2E. */
export function promptCorpus(): PromptCorpus {
  corpus ??= createPromptCorpus(() => join(app.getPath('userData'), 'writing', 'prompts.jsonl'))
  return corpus
}

/** The app's windows share the default session, so this switches all of them. */
export function applySpellcheck(enabled: boolean): void {
  session.defaultSession.setSpellCheckerEnabled(enabled)
}
