/**
 * Session auto-naming: prompt construction and output sanitizing for the
 * one-shot `pi -p` call that titles a session after its first user message.
 *
 * Pure functions — the subprocess plumbing lives in the IPC handler
 * (electron/ipc/pi-session-handlers.ts), which is not unit-testable without
 * spawning processes. Everything with decisions in it is here, tested in
 * session-naming.test.ts.
 */

const MAX_MESSAGE_LENGTH = 1200
const MAX_EXISTING_NAMES = 40

/**
 * Argv for the naming run, everything except the prompt itself.
 *
 * A title needs none of a session's context, so this strips everything pi
 * would otherwise load: tools, CLAUDE.md/AGENTS.md, skills, prompt templates.
 * Measured before the strip, the naming call carried ~35,000 tokens of
 * harness to produce a 15-token title.
 *
 * `--no-extensions` is conspicuously ABSENT: providers register through
 * extension discovery, so `-ne` makes pi-claude-cli an unknown provider and
 * the run errors out ("Unknown provider") — verified against real pi. Do not
 * add it back.
 *
 * When pi's default provider is the Claude CLI, the run is also pinned to
 * Haiku with an explicit `--provider` (never a bare fuzzy `--model` pattern,
 * which could resolve into another provider): a title does not need the
 * default model, which in practice is an Opus-tier one.
 */
export function titleArgs(options: { claudeCli: boolean }): string[] {
  return [
    '-p',
    '--no-session',
    '--no-tools',
    '--no-context-files',
    '--no-skills',
    '--no-prompt-templates',
    ...(options.claudeCli ? ['--provider', 'pi-claude-cli', '--model', 'claude-haiku-4-5'] : []),
  ]
}

/**
 * The naming request sent to `pi -p` (see `titleArgs` for the flag set).
 *
 * The word range is a preference rather than a constant: "2-5 words" suits a
 * sidebar, but a user running one lane per ticket may want a longer, more
 * literal title, and the branch slug is capped separately anyway.
 */
export function titlePrompt(
  message: string,
  existingNames: string[],
  words: { min: number; max: number } = { min: 2, max: 5 },
): string {
  const names = existingNames
    .map((name) => name.trim())
    .filter(Boolean)
    .slice(0, MAX_EXISTING_NAMES)
  const existing =
    names.length > 0
      ? `\nExisting session names in this workspace (yours must not duplicate or be easily confused with any of them):\n${names.map((n) => `- ${n}`).join('\n')}\n`
      : ''
  return (
    'You name coding sessions. Reply with ONLY the name: a short capitalized phrase of ' +
    // "of 1 word" rather than "of 1-1 words" when the range collapses.
    (words.min === words.max
      ? `${words.min} word${words.min === 1 ? '' : 's'} `
      : `${words.min}-${words.max} words `) +
    'summarizing the request below. No quotes, no trailing period, no explanation.\n' +
    existing +
    '\nThe request:\n' +
    message.slice(0, MAX_MESSAGE_LENGTH)
  )
}

/**
 * Distill model stdout into a usable title, or null.
 *
 * Takes the LAST non-empty line: when a model prefaces despite instructions
 * ("Here is the name:"), the name is the tail, never the head. Strips
 * wrapping quotes and trailing periods, collapses whitespace, caps length.
 */
export function sanitizeTitle(stdout: string, maxLength = 60): string | null {
  const line = stdout
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .at(-1)
  if (!line) return null
  const cleaned = line
    .replace(/^["'“”]+|["'“”.]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, Math.max(1, maxLength))
    .trim()
  return cleaned.length > 0 ? cleaned : null
}

/**
 * Last line of defense against duplicates: the prompt asks the model to
 * avoid existing names, but nothing guarantees it listened. Collisions get a
 * numeric suffix ("Fix Sidebar Resize 2"), case-insensitively.
 */
export function dedupeTitle(title: string, existingNames: string[]): string {
  const taken = new Set(existingNames.map((n) => n.trim().toLowerCase()))
  if (!taken.has(title.toLowerCase())) return title
  for (let n = 2; n < 100; n++) {
    const candidate = `${title} ${n}`
    if (!taken.has(candidate.toLowerCase())) return candidate
  }
  return title
}
