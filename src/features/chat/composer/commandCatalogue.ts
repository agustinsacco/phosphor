import type { RpcSlashCommand, SourceInfo } from '@shared/rpc'
import { commandScore } from '@/lib/fuzzy'

/**
 * What the `/` menu lists, derived from pi's `get_commands` answer.
 *
 * pi's list is honest but raw: it carries every alias an extension registers,
 * badges an MCP prompt as an `extension` because the adapter is one, and puts
 * the "where is this from?" answer in a `sourceInfo` object nobody rendered.
 * This module is the one place that reading happens, so the chat composer and
 * the home composer show the same list for the same answer. Pure functions —
 * `commandCatalogue.test.ts` runs them against a real pi payload.
 */

export type CommandBadge = 'phosphor' | 'extension' | 'prompt' | 'skill'

export interface NativeCommand {
  name: string
  description: string
  run: () => void
}

export interface CommandEntry {
  name: string
  description?: string
  badge: CommandBadge
  /** Short answer to "where is this from?": a package name, a scope, "built into pi". */
  origin: string
  /** pi's full provenance, for the tooltip. Absent for Phosphor's own commands. */
  sourceInfo?: SourceInfo
  /** Other names pi registered for this same command (see `dedupeAliases`). */
  aliases: string[]
  /**
   * Listed only once the query matches it. For a command that exists but
   * that Phosphor has a better path for — see `DEMOTED`.
   */
  demoted?: boolean
  native?: NativeCommand
}

/** Section order when the menu is browsed with nothing typed yet. */
export const BADGE_ORDER: readonly CommandBadge[] = ['phosphor', 'extension', 'prompt', 'skill']

export const BADGE_LABELS: Record<CommandBadge, string> = {
  phosphor: 'Phosphor',
  extension: 'Extensions',
  prompt: 'Prompts',
  skill: 'Skills',
}

/**
 * Commands kept out of the browse list, with what replaces them. They still
 * resolve when typed — the menu is a discovery surface, not a permission one.
 *
 * `/mcp-auth`: Phosphor drives this command itself from Settings ▸ MCP
 * Connectors, and docs/mcp.md is explicit about why a hand-run flow is the
 * dangerous one — pi's RPC has no dialog cancel, so the adapter's "paste the
 * callback URL" prompt has to be answered exactly once, by the code that knows
 * whether the loopback callback already won.
 */
const DEMOTED: Record<string, string> = {
  'mcp-auth': 'Phosphor runs this for you from Settings ▸ MCP Connectors.',
}

/**
 * The MCP server an `mcp__<server>__<prompt>` command belongs to, or null.
 *
 * pi-mcp-adapter exposes every prompt a connected server advertises as a
 * command under this name scheme. Server names are single-underscore-safe:
 * the separator is a double underscore.
 */
export function mcpPromptServer(name: string): string | null {
  const parts = name.split('__')
  if (parts.length < 3 || parts[0] !== 'mcp') return null
  return parts[1] || null
}

/**
 * Which well-known root a resolved file sits in, as a short hint for the
 * origin label (`user · .claude/skills`), or null for anywhere else.
 */
function rootHint(path: string): string | null {
  const normalized = path.replace(/\\/g, '/')
  for (const root of [
    '.claude/skills',
    '.pi/agent/skills',
    '.pi/agent/prompts',
    '.pi/agent/extensions',
    '.pi/skills',
    '.pi/prompts',
    '.pi/extensions',
  ]) {
    if (normalized.includes(`/${root}/`)) return root
  }
  return null
}

/** The short origin the row shows. Falls back to pi's own `source` word. */
export function originLabel(command: RpcSlashCommand): string {
  const server = mcpPromptServer(command.name)
  if (server) return `${server} · MCP prompt`
  const info = command.sourceInfo
  if (!info) return command.source
  if (info.origin === 'package') return info.source.replace(/^npm:/, '')
  if (info.source === 'inline' || info.scope === 'temporary') return 'built into pi'
  const scope = info.scope === 'project' ? 'project' : 'user'
  const hint = rootHint(info.path)
  return hint ? `${scope} · ${hint}` : scope
}

/** The badge a command renders under — pi's `source`, corrected for MCP prompts. */
export function badgeFor(command: RpcSlashCommand): CommandBadge {
  if (mcpPromptServer(command.name)) return 'prompt'
  return command.source
}

/**
 * Collapse names pi registered for one and the same command.
 *
 * pi-mcp-adapter registers `/mcp` and `/pi-mcp` against a single handler with
 * a single description. The signal is two commands from the same file with
 * the same non-empty description — nothing here names the alias, because the
 * alias is upstream's and may move. The first registration stays as the row;
 * the rest are kept as aliases so they remain searchable and visible in the
 * tooltip.
 */
export function dedupeAliases(
  commands: readonly RpcSlashCommand[],
): Array<{ command: RpcSlashCommand; aliases: string[] }> {
  const indexByKey = new Map<string, number>()
  const out: Array<{ command: RpcSlashCommand; aliases: string[] }> = []
  for (const command of commands) {
    const key =
      command.description && command.sourceInfo?.path
        ? `${command.sourceInfo.path}\0${command.description}`
        : null
    if (key !== null) {
      const existing = indexByKey.get(key)
      if (existing !== undefined) {
        out[existing]!.aliases.push(command.name)
        continue
      }
      indexByKey.set(key, out.length)
    }
    out.push({ command, aliases: [] })
  }
  return out
}

export function buildCommandEntries(
  piCommands: readonly RpcSlashCommand[],
  nativeCommands: readonly NativeCommand[],
): CommandEntry[] {
  const native: CommandEntry[] = nativeCommands.map((command) => ({
    name: command.name,
    description: command.description,
    badge: 'phosphor',
    origin: 'Phosphor',
    aliases: [],
    native: command,
  }))
  const fromPi: CommandEntry[] = dedupeAliases(piCommands).map(({ command, aliases }) => {
    const demotedNote = DEMOTED[command.name]
    const description = demotedNote
      ? [command.description, demotedNote].filter(Boolean).join(' — ')
      : command.description
    return {
      name: command.name,
      ...(description ? { description } : {}),
      badge: badgeFor(command),
      origin: originLabel(command),
      ...(command.sourceInfo ? { sourceInfo: command.sourceInfo } : {}),
      aliases,
      ...(demotedNote ? { demoted: true } : {}),
    }
  })
  return [...native, ...fromPi]
}

/**
 * The rows the menu shows for a query — every one of them, in the order they
 * appear. There is no cap: the popup scrolls, and a cap is what hid every
 * skill behind eleven extension commands.
 *
 * Nothing typed: browse order, grouped by badge (`BADGE_ORDER`), pi's own
 * order within a group (it registers a package's commands together), demoted
 * entries left out. Something typed: one flat list ranked by `commandScore`,
 * the best of the name and its aliases, ties kept in input order.
 */
export function filterCommandEntries(
  query: string,
  entries: readonly CommandEntry[],
): CommandEntry[] {
  if (!query) {
    const rank = (entry: CommandEntry): number => BADGE_ORDER.indexOf(entry.badge)
    return entries.filter((entry) => !entry.demoted).sort((a, b) => rank(a) - rank(b))
  }
  const scored: Array<{ entry: CommandEntry; score: number }> = []
  for (const entry of entries) {
    let best: number | null = null
    for (const name of [entry.name, ...entry.aliases]) {
      const score = commandScore(query, name, entry.description)
      if (score !== null && (best === null || score > best)) best = score
    }
    if (best !== null) scored.push({ entry, score: best })
  }
  scored.sort((a, b) => b.score - a.score)
  return scored.map((s) => s.entry)
}

/**
 * The hover text for a row: the whole description (the row truncates it),
 * then where the command comes from and any other names it answers to.
 */
export function entryTooltip(entry: CommandEntry): string {
  const lines: string[] = []
  if (entry.description) lines.push(entry.description)
  lines.push(`From: ${entry.origin}`)
  if (entry.sourceInfo?.path && !entry.sourceInfo.path.startsWith('<')) {
    lines.push(entry.sourceInfo.path)
  }
  if (entry.aliases.length > 0) lines.push(`Also: ${entry.aliases.map((a) => `/${a}`).join(', ')}`)
  return lines.join('\n')
}
