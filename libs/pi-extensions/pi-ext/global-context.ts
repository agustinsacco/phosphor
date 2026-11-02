/**
 * Keeps the user's global AGENTS.md current in every request of a running lane.
 *
 * pi reads `<agent dir>/AGENTS.md` once, when a session starts or reloads, and
 * renders it as the first block of the `project_context` system-prompt
 * section. Phosphor's Settings edit that file while lanes run, and without
 * this a lane would keep sending the text it started with until a restart.
 *
 * Before every model request (`context_with_system`) this re-reads the file pi
 * would pick from the agent directory and swaps the global block for it:
 * replaced when it changed, added when the file appeared, removed when it went
 * away. Repository files are left exactly as pi rendered them. Request-local,
 * like the context-file filter: a turn already streaming finishes with what it
 * was sent, and the session file keeps the text the lane started with.
 *
 * Registered by context-breakdown.ts before context-files.ts, so the filter
 * sees the swapped block.
 */

import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import {
  globalAgentDir,
  isGlobalContextPath,
  parseProjectContext,
  renderProjectContext,
} from './context-files'

/** pi's `loadContextFileFromDir` order (resource-loader.js, pi 1.3.0): the first file wins. */
export const GLOBAL_CONTEXT_NAMES = [
  'AGENTS.override.md',
  'AGENTS.md',
  'AGENTS.MD',
  'CLAUDE.md',
  'CLAUDE.MD',
] as const

export interface GlobalContextFile {
  path: string
  content: string
}

/** pi strips a leading BOM before rendering. */
const stripBom = (text: string): string => (text.charCodeAt(0) === 0xfeff ? text.slice(1) : text)

/** pi's block for one context file, byte for byte. */
export function renderContextBlock(file: GlobalContextFile): string {
  return `<project_instructions path="${file.path}">\n${file.content}\n</project_instructions>`
}

/**
 * The section with its global block replaced by `file`: unchanged when it
 * already matches or the shape is unknown, null when nothing is left.
 */
export function swapGlobalContext(
  section: string | undefined,
  file: GlobalContextFile | null,
  agentDir: string,
): string | null | undefined {
  if (section === undefined)
    return file ? renderProjectContext([renderContextBlock(file)]) : section
  const blocks = parseProjectContext(section)
  if (!blocks) return section
  const project = blocks.filter((block) => !isGlobalContextPath(block.path, agentDir))
  const texts = [...(file ? [renderContextBlock(file)] : []), ...project.map((block) => block.text)]
  if (texts.length === blocks.length && texts.every((text, i) => text === blocks[i]!.text))
    return section
  return texts.length ? renderProjectContext(texts) : null
}

interface SystemMessageLike {
  role?: string
  sections?: Record<string, string | null>
}

/** `sections` with `project_context` where pi puts it: before skills and cwd. */
function withContextSection(
  sections: Record<string, string | null>,
  section: string,
): Record<string, string | null> {
  const next: Record<string, string | null> = {}
  let placed = false
  for (const [name, value] of Object.entries(sections)) {
    if (!placed && (name === 'skills' || name === 'cwd')) {
      next.project_context = section
      placed = true
    }
    next[name] = value
  }
  if (!placed) next.project_context = section
  return next
}

/**
 * Bring every system message's global block up to date, in place. Only the
 * leading message may gain a section; a later patch is left as declared.
 */
export function applyGlobalContext(
  messages: unknown[],
  file: GlobalContextFile | null,
  agentDir: string,
): boolean {
  let changed = false
  let leading = true
  for (const message of messages) {
    const m = message as SystemMessageLike | null
    if (m?.role !== 'system') continue
    const isLeading = leading
    leading = false
    const current = m.sections?.project_context
    if (current === null || (current === undefined && !isLeading)) continue
    const next = swapGlobalContext(current, file, agentDir)
    if (next === current) continue
    changed = true
    if (current === undefined) m.sections = withContextSection(m.sections ?? {}, next!)
    else if (next !== null && next !== undefined) m.sections!.project_context = next
    else if (isLeading) delete m.sections!.project_context
    else m.sections!.project_context = null
  }
  return changed
}

/**
 * The global file as pi would load it now, cached by path, size and mtime so
 * a request only stats the candidates.
 */
export function globalContextReader(agentDir: string): () => GlobalContextFile | null {
  let cached: { key: string; file: GlobalContextFile } | undefined
  return () => {
    for (const name of GLOBAL_CONTEXT_NAMES) {
      const path = join(agentDir, name)
      try {
        const stat = statSync(path)
        if (!stat.isFile()) continue
        const key = `${path}\0${stat.size}\0${stat.mtimeMs}`
        if (cached?.key !== key)
          cached = { key, file: { path, content: stripBom(readFileSync(path, 'utf8')) } }
        return cached.file
      } catch {
        // Missing or unreadable: pi moves on to the next name too.
      }
    }
    return null
  }
}

/** The prompt pi reports with its global block brought up to date, for measuring. */
export function liveSystemPrompt(
  prompt: string,
  file: GlobalContextFile | null,
  agentDir: string,
): string {
  const start = prompt.indexOf('<project_context>\n')
  const end = start < 0 ? -1 : prompt.indexOf('\n</project_context>', start)
  if (end < 0) {
    const added = swapGlobalContext(undefined, file, agentDir)
    return added ? `${prompt}\n\n${added}` : prompt
  }
  const section = prompt.slice(start, end + '\n</project_context>'.length)
  const next = swapGlobalContext(section, file, agentDir)
  return `${prompt.slice(0, start)}${next ?? ''}${prompt.slice(start + section.length)}`
}

/** pi was told to load no context files at all; the swap must not add one. */
function contextFilesDisabled(argv: readonly string[]): boolean {
  return argv.includes('--no-context-files') || argv.includes('-nc')
}

interface GlobalContextApi {
  on(event: string, handler: (event: unknown, ctx: unknown) => unknown): void
}

/** Wires the swap; `prompt` adjusts what pi reports for the context breakdown. */
export default function globalContext(
  pi: GlobalContextApi,
  agentDir: string = globalAgentDir(),
  argv: readonly string[] = process.argv,
): { prompt: (systemPrompt: string) => string } {
  const read = globalContextReader(agentDir)
  const disabled = contextFilesDisabled(argv)
  pi.on('context_with_system', (event) => {
    if (disabled) return undefined
    const messages = (event as { messages?: unknown[] }).messages
    if (!Array.isArray(messages) || !applyGlobalContext(messages, read(), agentDir))
      return undefined
    return { messages }
  })
  return {
    prompt: (systemPrompt) =>
      disabled ? systemPrompt : liveSystemPrompt(systemPrompt, read(), agentDir),
  }
}
