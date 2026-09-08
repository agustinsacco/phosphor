/**
 * Types and pure helpers for the Skills page.
 *
 * A skill is a directory with a SKILL.md whose YAML frontmatter carries at
 * least `name` and `description` (the Agent Skills standard pi implements —
 * see pi's docs/skills.md). Everything here is pure string/shape work so the
 * renderer and the main process validate identically; filesystem and RPC work
 * lives in `electron/pi/skills.ts`.
 */

export type SkillScope = 'user' | 'project'

/** One file inside a skill bundle, path relative to the bundle dir. */
export interface SkillFileEntry {
  path: string
  size: number
}

/** Sidecar written by Phosphor installs (`.phosphor-skill.json`) — provenance. */
export interface SkillProvenance {
  catalogId: string
  repo: string
  sha: string
  subpath: string
  installedAt: number
}

/** A skill as pi resolves it, enriched with what's on disk. */
export interface ResolvedSkill {
  name: string
  description: string
  /** Absolute path of the bundle directory. */
  dir: string
  scope: SkillScope
  /** pi's sourceInfo.source (`auto`, `local`, `npm:<pkg>`) or `scan`. */
  source: string
  origin: 'package' | 'top-level'
  /** Under a root Phosphor may write to (`~/.pi/agent/skills`, `<ws>/.pi/skills`). */
  writable: boolean
  /** Lives in another harness's directory (`.claude/skills`). */
  borrowed: boolean
  /** `disable-model-invocation: true` — hidden from the system prompt. */
  draft: boolean
  files: SkillFileEntry[]
  totalSize: number
  provenance?: SkillProvenance
  warnings: string[]
}

export interface SkillsListResult {
  skills: ResolvedSkill[]
  /** How the list was obtained: pi's own resolution, or the scan fallback. */
  probe: 'rpc' | 'scan'
  /** Where creates/installs land, for display. */
  userRoot: string
  projectRoot?: string
}

export interface SkillImportPreview {
  sourcePath: string
  kind: 'md' | 'zip'
  /** Frontmatter name, null when missing (blocks import). */
  name: string | null
  description: string | null
  files: SkillFileEntry[]
  skillMd: string
  warnings: string[]
}

/** Max description length per the Agent Skills standard. */
export const SKILL_DESCRIPTION_MAX = 1024

/**
 * Validate a skill name against the standard's rules (1-64 chars, lowercase
 * a-z / digits / hyphens, no edge or doubled hyphens). Returns an error
 * message, or null when valid.
 */
export function validateSkillName(name: string): string | null {
  if (!name) return 'Name is required'
  if (name.length > 64) return 'Name must be 64 characters or fewer'
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(name)) {
    return 'Use lowercase letters, digits and single hyphens (no edge hyphens)'
  }
  return null
}

export interface SkillFrontmatter {
  attrs: Record<string, string>
  /** Raw frontmatter block (between the --- fences), or null when absent. */
  raw: string | null
  body: string
}

/**
 * Parse SKILL.md frontmatter. Deliberately a YAML *subset*: `key: value`
 * lines with indented continuations folded into one space-joined string, and
 * block markers (`|`, `>-`, …) dropped. Skills in the wild (verified against
 * anthropics/skills) use nothing richer, and a lenient parse that never
 * throws beats a YAML dependency that can.
 */
export function parseSkillFrontmatter(text: string): SkillFrontmatter {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text)
  if (!match) return { attrs: {}, raw: null, body: text }
  const raw = match[1] ?? ''
  const attrs: Record<string, string> = {}
  let currentKey: string | null = null
  for (const line of raw.split(/\r?\n/)) {
    const keyed = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line)
    if (keyed) {
      currentKey = (keyed[1] ?? '').toLowerCase()
      attrs[currentKey] = cleanFrontmatterValue(keyed[2] ?? '')
    } else if (currentKey && /^\s+\S/.test(line)) {
      attrs[currentKey] = `${attrs[currentKey]} ${line.trim()}`.trim()
    } else {
      currentKey = null
    }
  }
  return { attrs, raw, body: text.slice(match[0].length) }
}

function cleanFrontmatterValue(value: string): string {
  const trimmed = value.trim().replace(/^[|>][+-]?\s*/, '')
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length >= 2)
  ) {
    return trimmed.slice(1, -1)
  }
  return trimmed
}

/** Is the skill hidden from the system prompt? */
export function isSkillDraft(attrs: Record<string, string>): boolean {
  return attrs['disable-model-invocation'] === 'true'
}

/**
 * Set or clear `disable-model-invocation` in a SKILL.md's frontmatter,
 * touching nothing else. Returns the input unchanged when there is no
 * frontmatter block to edit (the caller surfaces that as a warning).
 */
export function setSkillDraftFlag(text: string, draft: boolean): string {
  const match = /^(---\r?\n)([\s\S]*?)(\r?\n---)/.exec(text)
  if (!match) return text
  const head = match[1] ?? ''
  const block = match[2] ?? ''
  const lines = block.split(/\r?\n/).filter((line) => !/^disable-model-invocation:/.test(line))
  if (draft) lines.push('disable-model-invocation: true')
  return text.slice(0, head.length) + lines.join('\n') + text.slice(head.length + block.length)
}

/** Compose a fresh SKILL.md for the create flow. */
export function composeSkillMd(options: {
  name: string
  description: string
  content: string
  draft: boolean
}): string {
  const lines = [
    '---',
    `name: ${options.name}`,
    `description: ${options.description.replace(/\r?\n/g, ' ').trim()}`,
  ]
  if (options.draft) lines.push('disable-model-invocation: true')
  lines.push('---', '', options.content.trim(), '')
  return lines.join('\n')
}

/**
 * Standard-compliance warnings worth showing on a skill row. These are
 * advisory — pi loads most non-compliant skills anyway — but each one is a
 * real "why didn't the model use my skill?" answer.
 */
export function skillFrontmatterWarnings(attrs: Record<string, string>): string[] {
  const warnings: string[] = []
  const name = attrs['name']
  if (!name) warnings.push('Frontmatter has no name — the directory name is used instead')
  else {
    const nameError = validateSkillName(name)
    if (nameError) warnings.push(`Name: ${nameError}`)
  }
  const description = attrs['description']
  if (!description) warnings.push('No description — the model cannot decide when to use this skill')
  else if (description.length > SKILL_DESCRIPTION_MAX) {
    warnings.push(`Description is ${description.length} chars (max ${SKILL_DESCRIPTION_MAX})`)
  }
  if (attrs['allowed-tools']) warnings.push(`Pre-approves tools: ${attrs['allowed-tools']}`)
  return warnings
}
