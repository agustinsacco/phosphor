import { create } from 'zustand'

/**
 * The Claude Code auto-compact window (Settings → Claude Code → Context
 * window; `AppPrefs.claudeAutocompact`, passed as `PI_CLAUDE_CLI_AUTOCOMPACT`).
 *
 * A leaf store for the same reason `lanePrefs.ts` is one: `stores/settings.ts`
 * calls `window.matchMedia` at creation, and the context meter — which reads
 * this to measure a Claude session against its compaction budget rather than
 * the model window — is covered by jsdom tests that must not drag that in.
 *
 * Hydrated from `app:getPrefs` by `settings.ts`, so there is still exactly one
 * prefs round-trip on launch; the settings tab updates it on save.
 *
 * Raw string, as stored. Sessions read it through `autocompactTokens()`. It is
 * the CURRENT setting: the provider reads the env var per spawn, so a session
 * started before a change keeps its old window while the meter shows the new
 * budget until that session is restarted.
 */
interface ClaudeAutocompactState {
  claudeAutocompact: string
  applyClaudeAutocompact: (value: string | undefined) => void
}

export const useClaudeAutocompactStore = create<ClaudeAutocompactState>((set) => ({
  claudeAutocompact: '',
  applyClaudeAutocompact: (value) => set({ claudeAutocompact: (value ?? '').trim() }),
}))
