/**
 * Whether a lane's model is sent the CLAUDE.md / AGENTS.md files pi found
 * (`AppPrefs.contextFiles`, the two checkboxes in both composers).
 *
 * The preference is what a NEW lane starts with. A running lane keeps its own
 * state inside pi, so toggling in one lane changes that lane and the
 * preference, never the other lanes. The filter itself is
 * `libs/pi-extensions/pi-ext/context-files.ts`; this module is Phosphor's side
 * of its wire contract (env var at spawn, host command afterwards, both in the
 * grammar `claude=off agents=on`).
 */

export type ContextFileKind = 'claude' | 'agents'

export interface ContextFilePrefs {
  claude: boolean
  agents: boolean
}

export const DEFAULT_CONTEXT_FILE_PREFS: ContextFilePrefs = { claude: true, agents: true }

export const CONTEXT_FILE_KINDS: readonly ContextFileKind[] = ['claude', 'agents']

export const CONTEXT_FILE_LABELS: Record<ContextFileKind, string> = {
  claude: 'CLAUDE.md',
  agents: 'AGENTS.md',
}

/** Read by the extension when pi starts. */
export const CONTEXT_FILES_ENV = 'PHOSPHOR_CONTEXT_FILES'

/** User-editable JSON in, two booleans out. Anything but `false` means included. */
export function normalizeContextFilePrefs(raw: unknown): ContextFilePrefs {
  const value = raw && typeof raw === 'object' ? (raw as Partial<ContextFilePrefs>) : {}
  return { claude: value.claude !== false, agents: value.agents !== false }
}

/** The spawn-time value, or undefined when every file is sent (pi's default). */
export function contextFilesEnvValue(prefs: ContextFilePrefs): string | undefined {
  const off = CONTEXT_FILE_KINDS.filter((kind) => !prefs[kind])
  return off.length > 0 ? off.map((kind) => `${kind}=off`).join(' ') : undefined
}

/** The host command that changes one kind in a running lane. */
export function contextFileCommand(kind: ContextFileKind, included: boolean): string {
  return `/phosphor-context-files ${kind}=${included ? 'on' : 'off'}`
}
