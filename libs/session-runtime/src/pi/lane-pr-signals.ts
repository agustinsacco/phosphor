import type { GhPrRef, LanePrSignals } from '@phosphor/shared/models'
import { isPrRef, prKey, prRefsIn } from '@phosphor/shared/github-pr-refs'
import { branchesCreatedBy, reviewedBy, stripHeredocs } from './lane-pr-commands'

/** The session-file entry "Track a PR…" and "Hide" write. */
export const LANE_PR_ENTRY = 'phosphor-prs'

export const PR_SIGNAL_LIMITS = {
  opened: 50,
  branches: 50,
  reviewing: 20,
  mentioned: 20,
  overrides: 100,
  runs: 200,
  pending: 64,
} as const

/** What the fold carries between lines. Every member is bounded by `PR_SIGNAL_LIMITS`. */
export interface PrSignalState {
  opened: Map<string, GhPrRef>
  branches: Set<string>
  reviewing: Map<string, GhPrRef>
  /** PR numbers reviewed with no repo named: resolved against the lane's own repo. */
  reviewingHere: Set<number>
  mentioned: Map<string, GhPrRef>
  /** Last pin or hide per PR. */
  overrides: Map<string, { ref: GhPrRef; action: 'pin' | 'hide' }>
  /** Subagent run ids, matched against run folders by the scanner. */
  runs: Set<string>
  /** `gh pr create` calls whose result has not been read yet. */
  pending: Set<string>
}

export function emptyPrSignals(): PrSignalState {
  return {
    opened: new Map(),
    branches: new Set(),
    reviewing: new Map(),
    reviewingHere: new Set(),
    mentioned: new Map(),
    overrides: new Map(),
    runs: new Set(),
    pending: new Set(),
  }
}

export function clonePrSignals(state: PrSignalState): PrSignalState {
  return {
    opened: new Map(state.opened),
    branches: new Set(state.branches),
    reviewing: new Map(state.reviewing),
    reviewingHere: new Set(state.reviewingHere),
    mentioned: new Map(state.mentioned),
    overrides: new Map(state.overrides),
    runs: new Set(state.runs),
    pending: new Set(state.pending),
  }
}

/**
 * Cheap test before a child run's line is parsed at all. The lane's own file
 * is parsed anyway by the metadata fold, so this only guards subagent runs.
 */
export function mayCarryPrSignal(line: string, state: PrSignalState): boolean {
  return (
    line.includes('gh pr') ||
    line.includes('pull_request') ||
    line.includes('git ') ||
    (state.pending.size > 0 && line.includes('"toolResult"'))
  )
}

function addRef(map: Map<string, GhPrRef>, ref: GhPrRef, limit: number): void {
  const key = prKey(ref)
  if (!map.has(key) && map.size < limit) map.set(key, ref)
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  return content
    .map((block) => {
      const b = block as { type?: string; text?: unknown }
      return b?.type === 'text' && typeof b.text === 'string' ? b.text : ''
    })
    .join('\n')
}

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g

function collectRuns(state: PrSignalState, line: string): void {
  for (const match of line.matchAll(UUID)) {
    if (state.runs.size >= PR_SIGNAL_LIMITS.runs) return
    state.runs.add(match[0])
  }
}

function foldToolCall(state: PrSignalState, block: Record<string, unknown>): void {
  const id = typeof block.id === 'string' ? block.id : undefined
  const name = typeof block.name === 'string' ? block.name : ''
  const args = block.arguments as { command?: unknown } | undefined
  if (/create_pull_request|pull_request_create/i.test(name)) {
    if (id && state.pending.size < PR_SIGNAL_LIMITS.pending) state.pending.add(id)
    return
  }
  if (typeof args?.command !== 'string') return
  const command = stripHeredocs(args.command)
  if (/\bgh\s+pr\s+create\b/.test(command) && id && state.pending.size < PR_SIGNAL_LIMITS.pending)
    state.pending.add(id)
  for (const branch of branchesCreatedBy(command)) {
    if (state.branches.size >= PR_SIGNAL_LIMITS.branches) break
    state.branches.add(branch)
  }
  const reviewed = reviewedBy(command)
  for (const ref of reviewed.refs) addRef(state.reviewing, ref, PR_SIGNAL_LIMITS.reviewing)
  for (const number of reviewed.numbers)
    if (state.reviewingHere.size < PR_SIGNAL_LIMITS.reviewing) state.reviewingHere.add(number)
}

function foldOverride(state: PrSignalState, data: unknown): void {
  const value = data as { action?: unknown; ref?: unknown } | null
  if (!value || !isPrRef(value.ref)) return
  const key = prKey(value.ref)
  if (value.action === 'pin' || value.action === 'hide') {
    state.overrides.delete(key)
    if (state.overrides.size < PR_SIGNAL_LIMITS.overrides)
      state.overrides.set(key, { ref: value.ref, action: value.action })
  } else if (value.action === 'clear') state.overrides.delete(key)
}

/**
 * Fold one parsed session entry. `line` is the raw JSONL it came from, read
 * only for subagent run ids. Mentions come from the lane's own prompts and
 * replies, never from a subagent's, which quote far more than they own.
 */
export function foldPrEntry(
  state: PrSignalState,
  entry: Record<string, unknown>,
  line: string,
  options: { mentions: boolean },
): void {
  const type = entry.type
  if (type === 'custom') {
    if (entry.customType === LANE_PR_ENTRY) foldOverride(state, entry.data)
    return
  }
  if (type === 'custom_message') {
    if (typeof entry.customType === 'string' && entry.customType.startsWith('subagent'))
      collectRuns(state, line)
    return
  }
  if (type !== 'message') return
  const message = entry.message as Record<string, unknown> | undefined
  if (!message) return
  if (message.role === 'toolResult') {
    if (message.toolName === 'subagent') collectRuns(state, line)
    const id = message.toolCallId
    if (typeof id === 'string' && state.pending.delete(id))
      for (const ref of prRefsIn(textOf(message.content), 5))
        addRef(state.opened, ref, PR_SIGNAL_LIMITS.opened)
    return
  }
  if (message.role === 'user') {
    if (options.mentions)
      for (const ref of prRefsIn(textOf(message.content), PR_SIGNAL_LIMITS.mentioned))
        addRef(state.mentioned, ref, PR_SIGNAL_LIMITS.mentioned)
    return
  }
  if (message.role !== 'assistant' || !Array.isArray(message.content)) return
  for (const block of message.content as Record<string, unknown>[]) {
    if (block?.type === 'toolCall') foldToolCall(state, block)
    else if (options.mentions && block?.type === 'text' && typeof block.text === 'string')
      for (const ref of prRefsIn(block.text, PR_SIGNAL_LIMITS.mentioned))
        addRef(state.mentioned, ref, PR_SIGNAL_LIMITS.mentioned)
  }
}

/** Add a subagent run's findings. Mentions and pins never come from a child. */
export function mergeChildSignals(into: PrSignalState, child: PrSignalState): void {
  for (const ref of child.opened.values()) addRef(into.opened, ref, PR_SIGNAL_LIMITS.opened)
  for (const branch of child.branches)
    if (into.branches.size < PR_SIGNAL_LIMITS.branches) into.branches.add(branch)
  for (const ref of child.reviewing.values())
    addRef(into.reviewing, ref, PR_SIGNAL_LIMITS.reviewing)
  for (const number of child.reviewingHere)
    if (into.reviewingHere.size < PR_SIGNAL_LIMITS.reviewing) into.reviewingHere.add(number)
}

/** The public shape, or undefined when the lane points at nothing. */
export function prSignalsOf(state: PrSignalState): LanePrSignals | undefined {
  const pinned: GhPrRef[] = []
  const hidden: GhPrRef[] = []
  for (const { ref, action } of state.overrides.values())
    (action === 'pin' ? pinned : hidden).push(ref)
  const signals: LanePrSignals = {
    opened: [...state.opened.values()],
    branches: [...state.branches],
    reviewing: [...state.reviewing.values()],
    mentioned: [...state.mentioned.values()],
    pinned,
    hidden,
  }
  if (state.reviewingHere.size) signals.reviewingHere = [...state.reviewingHere]
  const empty =
    !signals.opened.length &&
    !signals.branches.length &&
    !signals.reviewing.length &&
    !signals.mentioned.length &&
    !pinned.length &&
    !hidden.length &&
    !state.reviewingHere.size
  return empty ? undefined : signals
}
