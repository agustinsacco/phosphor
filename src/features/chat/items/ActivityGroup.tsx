import { memo, useEffect, useRef, useState } from 'react'
import clsx from 'clsx'
import type { ToolState } from '../reducer'
import {
  externalToolInfo,
  isActivityLive,
  isTerminalAgentStatus,
  summarizeActivity,
  type ActivityStep,
  type ExternalToolInfo,
  type SubagentBlock,
} from './transcriptRows'
import { ToolCard, ToolDetail } from '../tools/ToolCard'
import { settledVerb, summarizeExternalTool } from '../tools/toolSummaries'
import { useSessionsStore } from '@/stores/sessions'
import { Markdown } from '@/components/markdown/Markdown'
import { ChevronIcon } from '@/components/icons'
import { formatDuration, formatTokens } from '@/lib/format'
import { useChatUiStore } from '../uiState'

/**
 * One run of agent activity — thinking and tool calls, merged across pi's
 * message boundaries by `buildTranscriptRows`.
 *
 * Three behaviors, from the design review:
 *
 * - **Spine (A)**: the whole run is one framed unit with a collapsed head
 *   ("9 steps · edited 5 files, ran 2 commands"), so a 22-tool turn reads as
 *   four scannable lines instead of 22 spaced rows.
 * - **Gutter thinking (B)**: thinking never occupies a row of its own. It
 *   becomes a small mark in the left gutter of the step it preceded; hover or
 *   focus previews it, click pins it open. Zero vertical cost until asked for.
 * - **Live vs settled (D)**: while anything is running the group is open and
 *   accented so you can watch work happen; once it settles it auto-collapses
 *   to the summary line — unless the user opened it themselves, which always
 *   wins.
 *
 * The group is *title-anchored*: the summary text, the card's left edge and
 * the prose above it all start at the same x. Everything that indents does so
 * INSIDE the card. Before this, the card overhung the summary text by 6px on
 * the left while the rows sat 6px further right than it — three different
 * left edges in one unit, which is what made it read as loose.
 */

/**
 * Left inset shared by every row inside the card — tool rows, CLI-side tool
 * rows, sub-agent launches, reasoning-only rows. One constant because the
 * moment two of them disagree the card stops reading as a single column, and
 * Claude-provider sessions mix all four shapes in one run.
 *
 * The gutter it opens (20px) is also the column the marks live in, so these
 * three constants are one measurement expressed three times — `pl-5`, `w-5`,
 * `ml-5`. Change one and change all of them — the "gutter is one
 * measurement" block in `activityGroupRows.test.tsx` fails if you don't.
 */
export const ROW_INSET = 'pl-5 pr-2'

/**
 * The mark slot: the gutter itself, not a hand-placed square inside it.
 *
 * `left-0 w-5` makes the box exactly the padding `ROW_INSET` opened, and
 * `justify-center` centers whatever it holds in that box — so the ✳ and the
 * `cc` chip land on one axis by construction, with no per-mark offset to keep
 * in agreement. An earlier version positioned each mark by hand: first a 1px
 * offset, then an arbitrary `left` of bare `-3.5` — a number with no unit, so
 * it compiled to a declaration the browser drops, and both marks fell onto the
 * label they were meant to sit beside.
 *
 * `inset-y-0` centers vertically against the row's real height rather than a
 * fixed `top`, so a row that grows does not strand its mark at the top. The
 * box stays `absolute`: it must never reserve a column, because most rows have
 * no mark and every label starts at the same x regardless.
 */
export const GUTTER_MARK = 'absolute inset-y-0 left-0 flex w-5 items-center justify-center'

/**
 * The visible chip inside that box. It is deliberately narrower than the
 * gutter: a fill as wide as the slot would sit flush against the card's left
 * border and touch the label, which is exactly how the `cc` row read before —
 * the ✳ got away with a 1px surround only because it has no background.
 *
 * `min-w-3.5` keeps the ✳ a 14px square; `px-0.5` lets the two `cc` glyphs
 * set their own width without ever filling the slot.
 */
export const GUTTER_MARK_FILL =
  'text-2xs flex h-3.5 min-w-3.5 items-center justify-center rounded px-0.5'

export const ActivityGroup = memo(function ActivityGroup({
  steps,
  tools,
  hideThinking,
  sessionId,
  active,
}: {
  steps: ActivityStep[]
  tools: Record<string, ToolState>
  hideThinking: boolean
  sessionId: string
  /** The agent is still in this activity run, including gaps between tools. */
  active: boolean
}): React.JSX.Element | null {
  /** null = follow the live/settled default; true/false = explicit user choice. */
  const [userOpen, setUserOpen] = useState<boolean | null>(null)
  const verbose = useChatUiStore((s) => s.verbose[sessionId] ?? false)
  const live = isActivityLive(steps, tools)
  const activeRun = active || live

  // Reset the override when a group becomes active again (a settled group the
  // user collapsed should still open itself if new work lands in it). Unlike
  // individual tool liveness, `active` spans the quiet hand-off between one
  // completed tool and the next assistant message.
  const wasActive = useRef(activeRun)
  useEffect(() => {
    if (activeRun && !wasActive.current) setUserOpen(null)
    wasActive.current = activeRun
  }, [activeRun])

  // ⌃O flips the session's default open/closed state (uiState.verbose). Drop
  // per-group overrides when it changes, or "expand everything" would skip
  // exactly the groups the user had collapsed by hand.
  useEffect(() => {
    setUserOpen(null)
  }, [verbose])

  const visible = hideThinking ? steps.filter((s) => s.block.type !== 'thinking') : steps
  if (visible.length === 0) return null

  const open = activeRun || (userOpen ?? verbose)
  const summary = summarizeActivity(visible, tools, (t) => settledVerb(t.toolName ?? ''))

  // Pair each thinking block onto the step that follows it (gutter mark);
  // trailing thinking with nothing after it keeps its own minimal row.
  const rows: Array<{ step: ActivityStep; thought?: string }> = []
  let pendingThought: string | undefined
  for (const step of visible) {
    if (step.block.type === 'thinking') {
      pendingThought = pendingThought ? `${pendingThought}\n\n${step.block.text}` : step.block.text
      continue
    }
    rows.push({ step, thought: pendingThought })
    pendingThought = undefined
  }
  const trailingThought = pendingThought

  const liveLabel = [
    summary.stepLabel,
    summary.detail,
    summary.thinkingCount > 0
      ? `${summary.thinkingCount} thought${summary.thinkingCount === 1 ? '' : 's'}`
      : undefined,
  ]
    .filter(Boolean)
    .join(' · ')

  return (
    // The frame moved off this wrapper on purpose: the summary line is plain
    // prose-adjacent text (caret + label), and only the step list below gets
    // a bordered card. Boxing the whole run made the summary read as part of
    // the tool output instead of the narration above it.
    <div data-testid="activity-group" data-live={activeRun || undefined}>
      <button
        data-testid="activity-summary"
        onClick={() => {
          if (!activeRun) setUserOpen(!open)
        }}
        aria-expanded={open}
        /*
         * Padding pulled back out with a negative margin so the label starts
         * at x=0 — flush with the prose above and the card below — while the
         * hover surface still has room to breathe around the text.
         */
        className="hover:bg-bg-secondary/60 -ml-1.5 flex w-[calc(100%+0.375rem)] items-center rounded-md px-1.5 py-0.5 text-left transition-colors"
      >
        {activeRun ? (
          // One flat span while live: the shimmer clips a gradient to the
          // text, which needs a single run of same-colored glyphs.
          <span className="thinking-shimmer min-w-0 truncate text-base">{liveLabel}</span>
        ) : (
          <span className="text-text-secondary min-w-0 truncate text-base">
            <span className="text-text font-medium">{summary.stepLabel}</span>
            {summary.detail && ` · ${summary.detail}`}
            {summary.thinkingCount > 0 && (
              <span className="text-text-tertiary">
                {' · '}
                {summary.thinkingCount} thought{summary.thinkingCount === 1 ? '' : 's'}
              </span>
            )}
          </span>
        )}
        {/*
         * The status slot TRAILS the label, and the live dot and the settled
         * caret share it. Leading them would move the label 14px sideways at
         * the moment a run settles — the one moment the eye is already on it.
         */}
        {activeRun ? (
          <span
            aria-hidden
            className="bg-accent tool-running-dot ml-1.5 h-1.5 w-1.5 shrink-0 rounded-full"
          />
        ) : (
          <ChevronIcon
            expanded={open}
            size={9}
            strokeWidth={3}
            className="text-text-tertiary ml-1.5"
          />
        )}
        {summary.failedCount > 0 && (
          <span className="bg-danger-soft text-danger ml-auto shrink-0 rounded px-1.5 py-px text-xs font-medium">
            {summary.failedCount} failed
          </span>
        )}
      </button>

      <div
        aria-hidden={!open}
        inert={!open}
        className={clsx('activity-group-body', open && 'activity-group-body-open')}
      >
        {/* overflow-hidden moved here from the old outer frame — the grid
            track collapse needs a clipping child to actually hide the card. */}
        <div className="min-h-0 overflow-hidden">
          {/*
           * Border only, no fill. A white card on the grey page plus a border
           * is two containment signals for one group; the hairline alone is
           * enough and keeps the run visually subordinate to the prose.
           * `rounded-lg` is 14px in this theme (--px-radius-lg), which was far
           * too round for a 26px row — hence the explicit 7.
           */}
          <div className="border-border divide-border/50 mt-1 divide-y overflow-hidden rounded-[7px] border">
            {rows.map(({ step, thought }) => (
              <div
                className="activity-step-enter"
                key={step.block.type === 'tool' ? step.block.toolCallId : `th-${step.block.index}`}
              >
                <ActivityRow step={step} thought={thought} tools={tools} sessionId={sessionId} />
              </div>
            ))}
            {trailingThought && <ThoughtOnlyRow text={trailingThought} />}
          </div>
        </div>
      </div>
    </div>
  )
})

/** A tool step, with any preceding reasoning available from the gutter. */
function ActivityRow({
  step,
  thought,
  tools,
  sessionId,
}: {
  step: ActivityStep
  thought?: string
  tools: Record<string, ToolState>
  sessionId: string
}): React.JSX.Element | null {
  const [pinned, setPinned] = useState(false)
  const [hovered, setHovered] = useState(false)
  const [expanded, setExpanded] = useState(false)

  // Tools Claude Code ran inside its own process while acting as the model
  // provider. There is no pi tool result to show — only what was invoked —
  // so this is a compact, always-settled row rather than a ToolCard.
  if (step.block.type === 'subagent') {
    return <SubagentRow agent={step.block} />
  }

  if (step.block.type === 'externalTool') {
    const { name, args } = step.block
    const info = externalToolInfo(name, args)
    return <ExternalToolRow name={name} args={args} info={info} sessionId={sessionId} />
  }

  if (step.block.type !== 'tool') return null
  const tool = tools[step.block.toolCallId]
  if (!tool) return null

  const showThought = thought && (pinned || hovered)

  return (
    <div>
      {/* The mark floats in the row's own inset rather than reserving a column
          in front of every row. Reserving it pushed all four row types 20px
          right of the card edge for the sake of the few that have reasoning. */}
      <div className={clsx('relative', ROW_INSET)}>
        {thought && (
          <button
            onClick={() => setPinned((p) => !p)}
            onPointerEnter={() => setHovered(true)}
            onPointerLeave={() => setHovered(false)}
            onFocus={() => setHovered(true)}
            onBlur={() => setHovered(false)}
            title="Reasoning before this step"
            aria-label="Show reasoning before this step"
            aria-expanded={pinned}
            data-testid="thought-mark"
            className={clsx(GUTTER_MARK, 'group/mark')}
          >
            <span
              className={clsx(
                GUTTER_MARK_FILL,
                'transition-colors',
                pinned
                  ? 'bg-accent-soft text-accent'
                  : 'text-text-tertiary group-hover/mark:bg-accent-soft group-hover/mark:text-accent',
              )}
            >
              ✳
            </span>
          </button>
        )}
        <ToolCard
          tool={tool}
          sessionId={sessionId}
          expanded={expanded}
          onToggle={() => setExpanded((e) => !e)}
        />
      </div>
      {expanded && (
        // Not a second card: the detail is a full-width section of the
        // group's card, divided from the row above. A nested bordered box
        // here read as box-in-a-box.
        <div className="border-border expand-enter border-t">
          <ToolDetail tool={tool} sessionId={sessionId} />
        </div>
      )}
      {showThought && (
        <div
          data-testid="thought-body"
          className="border-border text-text-secondary mb-1.5 ml-5 mr-2 border-l-2 pl-2.5 text-base italic opacity-90 [&_.md-content]:text-base"
        >
          <Markdown text={thought} />
        </div>
      )}
    </div>
  )
}

/**
 * A tool Claude Code ran inside its own process, rendered as a pi tool row.
 *
 * Same inset, same type scale, same verb vocabulary and the same monospace
 * treatment for commands and patterns — because a Claude-provider run
 * interleaves these with pi's own tool calls, and two vocabularies for the
 * same act made one turn read like two transcripts stitched together.
 * `summarizeExternalTool` owns the mapping.
 *
 * Two things stay deliberately different, and both are honest rather than
 * cosmetic. There is no chevron: the provider forwards the invocation and no
 * `tool_result`, so there is nothing to expand into and a disclosure control
 * would promise output that does not exist. And the row is always settled —
 * no running dot, no failure state — because the marker arrives after the
 * fact and carries no status. The `cc` mark in the row's gutter keeps the
 * provenance visible:
 * pi never saw these calls, so they are absent from its own accounting.
 */
function ExternalToolRow({
  name,
  args,
  info,
  sessionId,
}: {
  name: string
  args?: string
  info: ExternalToolInfo
  sessionId: string
}): React.JSX.Element {
  const workspacePath = useSessionsStore((s) => s.live[sessionId]?.workspacePath ?? undefined)
  const summary = summarizeExternalTool(name, info.fields, workspacePath)

  return (
    <div
      className={clsx('relative flex items-center gap-1.5 py-1 text-lg', ROW_INSET)}
      data-testid="external-tool-row"
      // The full untruncated preview, for the case the cap cut the label.
      title={args ? `Claude Code · ${name} ${args}` : `Claude Code · ${name}`}
    >
      {/* Provenance belongs in the gutter, not in front of the label. It used
          to be an inline pill, which pushed every Claude row ~25px right of
          pi's own rows — and a Claude turn interleaves the two in one card, so
          the column broke on the first WebSearch. Same slot as the ✳ mark, same
          quiet styling: this row's label now starts at the x a pi row's does. */}
      <span aria-label="Ran by Claude Code" title="Ran by Claude Code" className={GUTTER_MARK}>
        {/* Same chip the pinned ✳ gets; no `tracking-wide` — the two glyphs
            already fill the slot the fill allows them. */}
        <span
          className={clsx(
            GUTTER_MARK_FILL,
            'bg-bg-secondary text-text-tertiary font-mono uppercase',
          )}
        >
          cc
        </span>
      </span>
      <span className="text-text-secondary shrink-0">{summary.label}</span>
      {summary.object && (
        <span
          className={clsx(
            'text-text min-w-0 truncate font-medium',
            summary.mono && 'font-mono text-base',
          )}
        >
          {summary.object}
        </span>
      )}
      {summary.hint && (
        <span className="text-text-tertiary min-w-0 truncate font-mono text-sm">
          {summary.hint}
        </span>
      )}
    </div>
  )
}

/**
 * One Claude Code sub-agent, from launch to whatever became of it.
 *
 * ONE row per agent, not per marker. The CLI reports the same agent three
 * times — the model's `Agent` call, `Task started`, `Task completed` — and
 * rendering each of them made a three-agent fan-out look like eight
 * launches, with the finished agents indistinguishable from the new ones.
 * `buildTranscriptRows` folds them; this row shows the folded state.
 *
 * What it may claim is bounded by what the markers prove. `launched` means
 * the model called the tool and the CLI never confirmed a thing — on a
 * provider older than 0.4.14 that is an agent that died with the subprocess,
 * so it must not be dressed up as running. The sub-agent's own transcript is
 * still not forwarded (docs/extensions.md), so the expandable
 * detail is the launch prompt, never the agent's work.
 */
function SubagentRow({ agent }: { agent: SubagentBlock }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const expandable = Boolean(agent.prompt)
  const done = isTerminalAgentStatus(agent.status)
  const stats = [
    agent.toolUses === undefined
      ? undefined
      : `${agent.toolUses} tool${agent.toolUses === 1 ? '' : 's'}`,
    agent.totalTokens === undefined ? undefined : `${formatTokens(agent.totalTokens)} tokens`,
    agent.durationMs === undefined ? undefined : formatDuration(agent.durationMs),
  ].filter(Boolean)

  return (
    <div data-testid="subagent-row" data-status={agent.status}>
      <button
        onClick={() => expandable && setOpen((o) => !o)}
        aria-expanded={expandable ? open : undefined}
        disabled={!expandable}
        className={clsx(
          'flex w-full items-center gap-1.5 py-1 text-left text-lg transition-colors',
          ROW_INSET,
          expandable && 'hover:bg-bg-secondary/60',
        )}
      >
        <span
          className={clsx(
            'shrink-0 rounded px-1.5 py-px text-xs font-semibold uppercase tracking-wide',
            agent.status === 'completed'
              ? 'bg-bg-secondary text-text-secondary'
              : done
                ? 'bg-bg-secondary text-warning'
                : 'bg-accent-soft text-accent',
          )}
        >
          agent
        </span>
        <span
          className={clsx(
            'min-w-0 truncate font-medium',
            done ? 'text-text-secondary' : 'text-text',
          )}
        >
          {agent.description ?? agent.subagentType ?? 'Sub-agent task'}
        </span>
        {/* The status word only earns its space when it says something the
            row does not: "running" while it is out there, and the reason a
            terminal agent produced nothing. A completed agent says so with
            its stats. */}
        {agent.status !== 'completed' && (
          <span
            className={clsx(
              'shrink-0 text-sm',
              agent.status === 'running' ? 'text-accent' : 'text-text-tertiary',
            )}
          >
            {agent.status === 'running'
              ? 'running'
              : agent.status === 'launched'
                ? 'launched'
                : agent.status}
          </span>
        )}
        {stats.length > 0 && (
          <span className="text-text-tertiary shrink-0 truncate font-mono text-sm">
            {stats.join(' · ')}
          </span>
        )}
        {expandable && (
          <ChevronIcon expanded={open} size={9} strokeWidth={3} className="text-text-tertiary" />
        )}
      </button>
      {open && agent.prompt && (
        <div
          data-testid="subagent-prompt"
          className="border-accent/30 text-text-secondary mb-1.5 ml-5 mr-2 whitespace-pre-wrap break-words border-l-2 pl-2.5 text-sm"
        >
          {agent.prompt}
        </div>
      )}
    </div>
  )
}

/** Reasoning with no tool call after it (e.g. the turn ended on a thought). */
function ThoughtOnlyRow({ text }: { text: string }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  return (
    <div>
      <button
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        data-testid="thought-mark"
        className={clsx(
          'text-text-tertiary hover:text-text-secondary relative flex w-full items-center py-1 text-left text-base italic transition-colors',
          ROW_INSET,
        )}
      >
        {/* Same slot the paired mark uses, so a reasoning-only row and a tool
            row with reasoning put their ✳ in exactly one place. */}
        <span className={GUTTER_MARK} aria-hidden>
          <span className={GUTTER_MARK_FILL}>✳</span>
        </span>
        <span>Reasoning</span>
      </button>
      {open && (
        <div
          data-testid="thought-body"
          className="border-border text-text-secondary mb-1.5 ml-5 mr-2 border-l-2 pl-2.5 text-base italic opacity-90 [&_.md-content]:text-base"
        >
          <Markdown text={text} />
        </div>
      )}
    </div>
  )
}
