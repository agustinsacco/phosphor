/**
 * The user's own instructions for every lane on one machine: the context file
 * pi loads from its agent directory (`~/.pi/agent/AGENTS.md` by default).
 *
 * Phosphor adds no file of its own. Settings edit pi's global file in place,
 * on This Mac and on each Host separately; nothing syncs between machines.
 * pi reads it at session start, and the bundled `global-context.ts` extension
 * brings running lanes up to date before each model request.
 */

/** pi's global context file names, in its order: the first that exists is the one it loads. */
export const GLOBAL_INSTRUCTIONS_NAMES = [
  'AGENTS.override.md',
  'AGENTS.md',
  'AGENTS.MD',
  'CLAUDE.md',
  'CLAUDE.MD',
] as const

/** The file Settings creates when the agent directory has none. */
export const GLOBAL_INSTRUCTIONS_DEFAULT = 'AGENTS.md'

/** Large enough for any real instructions file; every byte is sent on every request. */
export const GLOBAL_INSTRUCTIONS_MAX_BYTES = 256 * 1024

export interface GlobalInstructions {
  /** Absolute path on the machine that owns the file. */
  path: string
  content: string
  /** sha256 of the file's bytes, or of nothing when it does not exist yet. */
  revision: string
  exists: boolean
}

const utf8Bytes = (text: string): number => new TextEncoder().encode(text).length

/** Text a save may write: bounded, and no NUL. */
export function isGlobalInstructionsText(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    !value.includes('\0') &&
    value.length <= GLOBAL_INSTRUCTIONS_MAX_BYTES &&
    utf8Bytes(value) <= GLOBAL_INSTRUCTIONS_MAX_BYTES
  )
}

/** A file read as it arrives from another process, or null when it is malformed. */
export function parseGlobalInstructions(value: unknown): GlobalInstructions | null {
  const v = value as Partial<GlobalInstructions> | null
  if (
    !v ||
    typeof v !== 'object' ||
    typeof v.path !== 'string' ||
    v.path.length > 4096 ||
    v.path.includes('\0') ||
    !isGlobalInstructionsText(v.content) ||
    typeof v.revision !== 'string' ||
    !/^[a-f0-9]{64}$/.test(v.revision) ||
    typeof v.exists !== 'boolean'
  )
    return null
  return { path: v.path, content: v.content, revision: v.revision, exists: v.exists }
}
