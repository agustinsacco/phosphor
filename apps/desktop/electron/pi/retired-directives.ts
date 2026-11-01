import { appendGlobalInstructions } from '@phosphor/session-runtime/pi/global-instructions'
import { errorText } from '@phosphor/shared/errors'
import type { RawPrefs } from '../prefs-migrations'

/**
 * "Your own text" (`agentDirectives.custom`) used to be appended to every
 * lane's system prompt. The user's own instructions now live in pi's global
 * AGENTS.md, so the setting is retired, once:
 *
 * - The global text is appended to that file, which every lane on This Mac
 *   reads (terminal pi and routines included).
 * - A project's text has no file of its own Phosphor may write (a repository's
 *   AGENTS.md is the user's, under version control), so it moves to
 *   `retiredDirectives` for Settings to show until dismissed. So does global
 *   text the file refused.
 *
 * Idempotent: the `custom` keys are deleted as they are handled.
 */
export function migrateRetiredDirectives(
  raw: RawPrefs,
  agentDir: string,
  log: (message: string, data?: unknown) => void = () => undefined,
): void {
  const record = (value: unknown): Record<string, unknown> =>
    value && typeof value === 'object' ? { ...(value as Record<string, unknown>) } : {}
  const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '')
  const retired = record(raw.get('retiredDirectives'))
  let retiredChanged = false

  const global = record(raw.get('agentDirectives'))
  const globalText = text(global.custom)
  let moved = false
  if ('custom' in global) {
    if (globalText) {
      try {
        const file = appendGlobalInstructions(agentDir, globalText, { followLinks: true })
        moved = true
        log('moved "Your own text" into the global instructions', { path: file.path })
      } catch (error) {
        retired[''] = globalText
        retiredChanged = true
        log('could not move "Your own text" into the global instructions', {
          error: errorText(error),
        })
      }
    }
    delete global.custom
    raw.set('agentDirectives', global)
  }

  const byProject = record(raw.get('agentDirectivesByProject'))
  let projectsChanged = false
  for (const [path, value] of Object.entries(byProject)) {
    const entry = record(value)
    if (!('custom' in entry)) continue
    const projectText = text(entry.custom)
    // The same words as the global text are already in the file.
    if (projectText && !(moved && projectText === globalText)) {
      retired[path] = projectText
      retiredChanged = true
    }
    delete entry.custom
    byProject[path] = entry
    projectsChanged = true
  }
  if (projectsChanged) raw.set('agentDirectivesByProject', byProject)
  if (retiredChanged) raw.set('retiredDirectives', retired)
}
