import { countMatches } from '@shared/text-search'
import { markdownText } from './markdownText'
import type { ToolState } from './reducer'
import { externalToolInfo, type ActivityStep, type TranscriptRow } from './items/transcriptRows'
import {
  summarizeExternalTool,
  summarizeTool,
  toolDetails,
  toolText,
  type EditDetails,
} from './tools/toolSummaries'
import { parseDisplayDiff } from './diff'
import { parseErrorMessage } from './errorMessage'
import { parseUserText } from './userMessageBlocks'

/**
 * Find in a session, counted from the transcript's DATA.
 *
 * The transcript is virtualized, so most rows are not in the DOM and a DOM
 * search would count only what is on screen. Every row is instead reduced to
 * the text it renders as, split into SEGMENTS — one per element that holds a
 * run of it: a message body, a tool row's summary line, its expanded output,
 * the reasoning before it. The rendered element carries the same name in
 * `data-find-segment`, which is how a hit counted here is found again once
 * its row is on screen (`useTranscriptFind`).
 *
 * Hidden-until-asked text (tool output, reasoning, a collapsed run) is
 * counted, because it is the text a reader most often goes looking for; the
 * segment name says what has to open to show it.
 */

/** A run of a row's text, and the `data-find-segment` of the element rendering it. */
interface FindPiece {
  segment: string
  text: string
}

export interface TranscriptHit {
  /** Index into the rows, which is the virtualizer's index. */
  row: number
  rowId: string
  segment: string
  /** Which match inside the segment, 0-based. */
  ordinal: number
}

export interface TranscriptFindContext {
  tools: Record<string, ToolState>
  hideThinking: boolean
  /** The session's cwd, which tool summaries strip from paths. */
  workspacePath?: string
}

/** Segment names. Activity segments are suffixed with the step's `stepFindKey`. */
export const SEGMENT = {
  body: 'body',
  command: 'command',
  output: 'output',
  step: (key: string) => `step:${key}`,
  detail: (key: string) => `detail:${key}`,
  thought: (key: string) => `thought:${key}`,
} as const

/** The key of reasoning that ends a run, with no step after it to pair with. */
export const TRAILING_THOUGHT = 'end'

/**
 * Which part of which step an activity segment names: `detail:c1` is the
 * expanded output of step `c1`. Null for a segment outside a run (`body`).
 */
export function segmentPart(segment: string): { part: string; key: string } | null {
  const at = segment.indexOf(':')
  return at === -1 ? null : { part: segment.slice(0, at), key: segment.slice(at + 1) }
}

/**
 * A step's identity inside its activity run. Tool calls carry a unique id;
 * everything else is only unique within its message, hence the item id.
 */
export function stepFindKey(step: ActivityStep): string {
  return step.block.type === 'tool' ? step.block.toolCallId : `${step.itemId}:${step.block.index}`
}

/**
 * Derived text, cached on the object it came from. The reducer replaces a
 * message, its blocks and a tool's state rather than mutating them, so an
 * unchanged one keeps its entry — and keeps returning the same string
 * instance, which makes the per-query count cache below a cheap lookup while a
 * reply streams. Blocks `buildTranscriptRows` makes itself (a CLI-side tool, a
 * sub-agent) are new on every pass, so they cannot hold an entry here.
 */
const derived = new WeakMap<object, Map<string, string>>()

function cached(source: object, slot: string, compute: () => string): string {
  let entry = derived.get(source)
  if (!entry) derived.set(source, (entry = new Map()))
  let text = entry.get(slot)
  if (text === undefined) entry.set(slot, (text = compute()))
  return text
}

/**
 * Summary lines of CLI-side tool rows, keyed by what they are derived from —
 * their marker's name and arguments, and the outcome folded into them — since
 * the blocks themselves are rebuilt on every pass. Carried from one pass to
 * the next like the counts, so only lines still in the transcript are kept.
 */
interface Summaries {
  previous: Map<string, string>
  used: Map<string, string>
}

function carried(summaries: Summaries, key: string, compute: () => string): string {
  let text = summaries.used.get(key) ?? summaries.previous.get(key)
  if (text === undefined) text = compute()
  summaries.used.set(key, text)
  return text
}

function lines(...parts: (string | undefined | null)[]): string {
  return parts.filter((part): part is string => !!part).join('\n')
}

/**
 * A tool row's summary line. The row lays its parts out side by side with a
 * space between them, so a phrase that reads across two ("Ran npm test")
 * matches, and a whole word stops at a part's edge.
 */
function words(...parts: (string | undefined | null)[]): string {
  return parts.filter((part): part is string => !!part).join(' ')
}

function argString(tool: ToolState, key: string): string {
  const value = tool.args?.[key]
  return typeof value === 'string' ? value : ''
}

/**
 * What a tool's expanded detail shows (`ToolDetail` in tools/ToolCard.tsx),
 * less the headers, badges and placeholders that find skips.
 */
function toolDetailText(tool: ToolState): string {
  const output = toolText(tool)
  switch (tool.toolName) {
    case 'bash': {
      const command = typeof tool.args?.command === 'string' ? tool.args.command : tool.argsText
      return lines(`$ ${command}`, output)
    }
    case 'edit': {
      const diff = toolDetails<EditDetails>(tool)?.diff
      const body = diff
        ? parseDisplayDiff(diff)
            .map((line) => line.text)
            .join('\n')
        : tool.isError
          ? output
          : ''
      return lines(argString(tool, 'path'), body)
    }
    case 'write':
      return tool.isError ? output : lines(argString(tool, 'path'), argString(tool, 'content'))
    case 'read':
      return tool.isError ? output : lines(argString(tool, 'path'), output)
    case 'grep':
    case 'find':
    case 'ls':
      return output
    case 'artifact_create':
    case 'artifact_update':
    case 'artifact_edit':
      // The card restates the step: its title is already the row's summary.
      return tool.isError ? output : ''
    default:
      // The arguments header is the call's input, and find reads its output.
      return output
  }
}

function stepPieces(
  step: ActivityStep,
  key: string,
  context: TranscriptFindContext,
  summaries: Summaries,
): FindPiece[] {
  const { block } = step
  switch (block.type) {
    case 'tool': {
      const tool = context.tools[block.toolCallId]
      if (!tool) return []
      const summary = cached(tool, `summary\u0000${context.workspacePath ?? ''}`, () => {
        const { label, object, hint } = summarizeTool(tool, context.workspacePath)
        // The row's badge says so, and a reader searching for it means it.
        return words(label, object, hint, tool.status === 'error' ? 'failed' : undefined)
      })
      return [
        { segment: SEGMENT.step(key), text: summary },
        { segment: SEGMENT.detail(key), text: cached(tool, 'detail', () => toolDetailText(tool)) },
      ]
    }
    case 'externalTool': {
      const { name, args, result } = block
      const failed = result?.status === 'error'
      const source = [name, args, result?.summary, failed, context.workspacePath].join('\u0000')
      const summary = carried(summaries, source, () => {
        const info = externalToolInfo(name, args)
        const { label, object, hint } = summarizeExternalTool(
          name,
          info.fields,
          context.workspacePath,
        )
        return words(label, object, hint, result?.summary, failed ? 'failed' : undefined)
      })
      const detail = result?.preview ?? result?.error
      return detail
        ? [
            { segment: SEGMENT.step(key), text: summary },
            { segment: SEGMENT.detail(key), text: detail },
          ]
        : [{ segment: SEGMENT.step(key), text: summary }]
    }
    case 'subagent': {
      // Fields of the block, shown verbatim: nothing is derived, so nothing
      // is cached.
      const pieces: FindPiece[] = [
        {
          segment: SEGMENT.step(key),
          text: block.description ?? block.subagentType ?? 'Sub-agent task',
        },
      ]
      if (block.prompt) pieces.push({ segment: SEGMENT.detail(key), text: block.prompt })
      return pieces
    }
    default:
      return []
  }
}

/**
 * An activity run in the order ActivityGroup renders it: the reasoning before
 * a step (its own "Thought for 12s" row, opening in place), then the step's
 * summary line, then its expanded detail. Reasoning with no step after it
 * closes the run.
 *
 * Every thought has a row, whatever follows it: a pi tool, a CLI-side tool, a
 * sub-agent, or a tool whose state is missing and renders nothing itself.
 */
function activityPieces(
  steps: ActivityStep[],
  context: TranscriptFindContext,
  summaries: Summaries,
): FindPiece[] {
  const pieces: FindPiece[] = []
  let thoughts: string[] = []
  for (const step of steps) {
    if (step.block.type === 'thinking') {
      if (context.hideThinking) continue
      const block = step.block
      thoughts.push(cached(block, 'text', () => markdownText(block.text)))
      continue
    }
    const key = stepFindKey(step)
    // One segment, several pieces: ActivityGroup joins the thoughts into one
    // body, so their matches count on from each other.
    for (const text of thoughts) pieces.push({ segment: SEGMENT.thought(key), text })
    pieces.push(...stepPieces(step, key, context, summaries))
    thoughts = []
  }
  for (const text of thoughts) pieces.push({ segment: SEGMENT.thought(TRAILING_THOUGHT), text })
  return pieces
}

/** Every searchable run in one row, in on-screen order. */
export function rowPieces(
  row: TranscriptRow,
  context: TranscriptFindContext,
  summaries: Summaries = { previous: new Map(), used: new Map() },
): FindPiece[] {
  switch (row.kind) {
    case 'text': {
      const { block } = row
      return [
        { segment: SEGMENT.body, text: cached(block, 'text', () => markdownText(block.text)) },
      ]
    }
    case 'outcome': {
      const { item } = row
      if (item.stopReason !== 'error') return []
      return [
        {
          segment: SEGMENT.body,
          text: cached(item, 'outcome', () => parseErrorMessage(item.errorMessage).text),
        },
      ]
    }
    case 'activity':
      return activityPieces(row.steps, context, summaries)
    case 'item': {
      const { item } = row
      switch (item.kind) {
        case 'user':
          return [
            {
              segment: SEGMENT.body,
              text: cached(item, 'text', () =>
                parseUserText(item.text)
                  .map((block) =>
                    block.kind === 'text'
                      ? block.text
                      : block.items.map((entry) => entry.content).join('\n'),
                  )
                  .join('\n'),
              ),
            },
          ]
        case 'bash':
          return [
            { segment: SEGMENT.command, text: item.command },
            { segment: SEGMENT.output, text: item.output },
          ]
        case 'divider':
          return [
            {
              segment: SEGMENT.body,
              text: item.variant === 'error' ? (item.summary ?? 'Error') : (item.summary ?? ''),
            },
          ]
        case 'custom':
          return [
            { segment: SEGMENT.body, text: cached(item, 'text', () => markdownText(item.text)) },
          ]
        case 'assistant':
          return []
      }
    }
  }
}

/**
 * What one pass reuses from the last. `counts` are one query's match counts,
 * by text: a streaming reply changes one block at a time, so every other
 * block's count is a lookup. `summaries` are the CLI-side tool lines (see
 * `Summaries`), whatever the query. Both are rebuilt from what the pass used,
 * so superseded entries do not pile up.
 */
interface FindCache {
  regex: RegExp | null
  counts: Map<string, number>
  summaries: Map<string, string>
}

export function createFindCache(): FindCache {
  return { regex: null, counts: new Map(), summaries: new Map() }
}

/** Every hit in the transcript, in order, up to `limit`. */
export function findTranscriptHits(
  rows: TranscriptRow[],
  context: TranscriptFindContext,
  regex: RegExp,
  limit: number,
  cache: FindCache = createFindCache(),
): { hits: TranscriptHit[]; capped: boolean } {
  const previous = cache.regex === regex ? cache.counts : new Map<string, number>()
  const counts = new Map<string, number>()
  const summaries: Summaries = { previous: cache.summaries, used: new Map() }
  const hits: TranscriptHit[] = []
  let capped = false
  outer: for (let row = 0; row < rows.length; row++) {
    const { id: rowId } = rows[row]!
    const ordinals = new Map<string, number>()
    for (const { segment, text } of rowPieces(rows[row]!, context, summaries)) {
      if (text === '') continue
      let count = counts.get(text) ?? previous.get(text)
      if (count === undefined) count = countMatches(text, regex, limit)
      counts.set(text, count)
      let ordinal = ordinals.get(segment) ?? 0
      for (let i = 0; i < count; i++) {
        if (hits.length >= limit) {
          capped = true
          break outer
        }
        hits.push({ row, rowId, segment, ordinal: ordinal++ })
      }
      ordinals.set(segment, ordinal)
    }
  }
  cache.regex = regex
  cache.counts = counts
  cache.summaries = summaries.used
  return { hits, capped }
}

/**
 * The hit a fresh query should land on: the first at or below the top of the
 * viewport, else the last one above it — whichever is nearest to what the
 * reader is looking at.
 */
export function nearestHit(hits: TranscriptHit[], topRow: number): number {
  if (hits.length === 0) return -1
  const below = hits.findIndex((hit) => hit.row >= topRow)
  return below === -1 ? hits.length - 1 : below
}
