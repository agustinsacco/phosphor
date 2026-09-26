/** The slice of electron-store a migration needs, untyped by AppPrefs. */
export interface RawPrefs {
  get(key: string): unknown
  set(key: string, value: unknown): void
  delete(key: string): void
}

/**
 * Keys whose stored name changed. The old name is no longer in
 * `DEFAULT_APP_PREFS`, so finding it on disk means an earlier version wrote
 * it: its value moves to the new key (unless that one is already set) and the
 * old key is deleted. Runs once, when `electron/store.ts` opens the store.
 *
 * - `claudeAutocompact` → `contextBudget`: the Claude-only auto-compact window
 *   became the budget for every session (shared/context-budget.ts).
 */
export function migrateRenamedPrefs(raw: RawPrefs): void {
  const legacy = raw.get('claudeAutocompact')
  if (legacy === undefined) return
  const current = raw.get('contextBudget')
  if (typeof legacy === 'string' && legacy.trim() && !current) {
    raw.set('contextBudget', legacy.trim())
  }
  raw.delete('claudeAutocompact')
}
