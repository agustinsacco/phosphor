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

/** A model to run the title on, always named with its provider. */
export interface TitleModel {
  provider: string
  id: string
}

/** The model a Claude CLI title used before the catalogue picked one. */
export const CLAUDE_TITLE_FALLBACK: TitleModel = {
  provider: 'pi-claude-cli',
  id: 'claude-haiku-4-5',
}

/**
 * Argv for the naming run, everything except the prompt itself.
 *
 * A title needs none of a session's context, so this strips everything pi
 * would otherwise load: tools, CLAUDE.md/AGENTS.md, skills, prompt templates.
 * Measured before the strip, the naming call carried ~35,000 tokens of
 * harness to produce a 15-token title.
 *
 * `--thinking off` always: without it the run inherits the user's default
 * level, and a title on Haiku at `high` took 6.0s against 2.8s off.
 *
 * `model` is passed with an explicit `--provider` (never a bare fuzzy
 * `--model` pattern, which could resolve into another provider).
 *
 * `extensions` set means a fast boot: `-ne` skips every installed package
 * (MCP adapter, sub-agents, web access…) and only the listed files load.
 * Providers can register through extensions (pi-claude-cli does), so the
 * caller must list the provider's own extension, and falls back to a full
 * boot when a fast one fails ("Unknown provider").
 */
export function titleArgs(
  options: { model?: TitleModel | null; extensions?: string[] | null } = {},
): string[] {
  const { model, extensions } = options
  return [
    '-p',
    '--no-session',
    '--no-tools',
    '--no-context-files',
    '--no-skills',
    '--no-prompt-templates',
    '--thinking',
    'off',
    ...(model ? ['--provider', model.provider, '--model', model.id] : []),
    ...(extensions ? ['--no-extensions', ...extensions.flatMap((path) => ['-e', path])] : []),
  ]
}

/** One way to run the title, in the order `titleAttempts` returns them. */
export interface TitleAttempt {
  model: TitleModel | null
  extensions: string[] | null
}

/**
 * Fastest first, then safer: the picked model on a fast boot, the same on a
 * full boot (an extension-registered provider is unknown under `-ne`), then
 * `fallback` (null = pi's default) in case the picked model is not usable on
 * this account. Duplicates are dropped, so most plans are one or two runs.
 */
export function titleAttempts(
  model: TitleModel | null,
  fastExtensions: string[] | null,
  fallback: TitleModel | null,
): TitleAttempt[] {
  const plan: TitleAttempt[] = [
    ...(fastExtensions ? [{ model, extensions: fastExtensions }] : []),
    { model, extensions: null },
    { model: fallback, extensions: null },
  ]
  const seen = new Set<string>()
  return plan.filter((attempt) => {
    const key = JSON.stringify(attempt)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/** The catalogue fields `pickTitleModel` reads. */
export interface TitleCandidate {
  id: string
  provider: string
  cost?: { input: number; output: number }
}

/** Not chat models, or not usable unattended (rate-limited free tiers). */
const NOT_FOR_TITLES = /voxtral|whisper|embed|tts|audio|realtime|guard|moderation|image|:free/i

/** Cross-region inference prefixes (Bedrock), kept identical to the default's. */
const REGION_PREFIX = /^(us|eu|apac|global|jp|au|ca|us-gov)\./i

function regionOf(id: string): string {
  return REGION_PREFIX.exec(id)?.[1]?.toLowerCase() ?? ''
}

/**
 * The model family: the first run of letters once any region prefix is gone.
 * `anthropic.claude-…`, `anthropic/claude-…` → anthropic; `claude-opus-…` →
 * claude; `gpt-5.5` → gpt; `kimi-k2` → kimi.
 */
function familyOf(id: string): string {
  return /[a-z]+/i.exec(id.replace(REGION_PREFIX, ''))?.[0]?.toLowerCase() ?? ''
}

function price(model: TitleCandidate): number | null {
  if (!model.cost) return null
  const total = model.cost.input + model.cost.output
  return Number.isFinite(total) && total > 0 ? total : null
}

/**
 * The cheapest model to title a session with, or null for "use the default".
 *
 * Stays inside the default's provider (same credentials), family (a vendor
 * the user already reaches, e.g. Anthropic on Bedrock) and region prefix.
 * Picks only a model with a known price strictly below the default's; the
 * catalogue's cheapest overall is not safe (on Bedrock it is a speech model,
 * on OpenRouter a rate-limited free tier). Unknown prices pick nothing.
 */
export function pickTitleModel(
  catalogue: TitleCandidate[],
  defaultProvider: string | undefined,
  defaultModel: string | undefined,
): TitleModel | null {
  if (!defaultProvider || !defaultModel) return null
  const current = catalogue.find((m) => m.provider === defaultProvider && m.id === defaultModel)
  const ceiling = current ? price(current) : null
  if (ceiling === null) return null
  const family = familyOf(defaultModel)
  const region = regionOf(defaultModel)
  let best: { model: TitleCandidate; price: number } | null = null
  for (const model of catalogue) {
    if (model.provider !== defaultProvider || NOT_FOR_TITLES.test(model.id)) continue
    if (familyOf(model.id) !== family || regionOf(model.id) !== region) continue
    const cost = price(model)
    if (cost === null || cost >= ceiling) continue
    // Ties go to the shorter id: the alias over the dated snapshot.
    if (
      !best ||
      cost < best.price ||
      (cost === best.price && model.id.length < best.model.id.length)
    ) {
      best = { model, price: cost }
    }
  }
  return best ? { provider: defaultProvider, id: best.model.id } : null
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
