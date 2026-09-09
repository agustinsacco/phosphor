import { memo, useEffect, useMemo, useRef, useState } from 'react'
import clsx from 'clsx'
import type { ToolState } from '../reducer'
import {
  externalToolInfo,
  isActivityLive,
  isTerminalAgentStatus,
  summarizeActivity,
  type ActivityStep,
  type ExternalToolInfo,
  type ExternalToolResult,
  type SubagentBlock,
} from './transcriptRows'
import { ToolCard, ToolDetail } from '../tools/ToolCard'
import { CopyButton } from '@/components/CopyButton'
import { settledVerb, summarizeExternalTool } from '../tools/toolSummaries'
import { useSessionsStore } from '@/stores/sessions'
import { Markdown } from '@/components/markdown/Markdown'
import { ChevronIcon } from '@/components/icons'
import { formatDuration, formatTokens } from '@/lib/format'
import { useChatUiStore } from '../uiState'
import { useExtensionUiStore } from '@/stores/extensionUi'
import { findLiveSubagent, SUBAGENTS_STATUS_KEY } from '../subagentStatus'

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
    return <SubagentRow agent={step.block} sessionId={sessionId} />
  }

  if (step.block.type === 'externalTool') {
    const { name, args, result, toolUseId } = step.block
    const info = externalToolInfo(name, args)
    return (
      <ExternalToolRow
        name={name}
        args={args}
        info={info}
        result={result}
        // A tagged call with no result yet is running — but only while its
        // message streams. See `isActivityLive`: an unanswered call on a
        // settled turn is a CLI that never reported, not work in flight.
        pending={!!toolUseId && !result && step.streaming}
        sessionId={sessionId}
      />
    )
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
 * **What the row can claim is bounded by what the markers carry.** Until
 * provider 0.8.0 that was the invocation and nothing else, so the row had no
 * chevron and no status: always settled, nothing to expand into. When the
 * provider tags a call with its `tool_use_id` it is promising a result
 * marker, and then this row goes through the same three states a pi tool row
 * does — running, settled with an outcome, failed — and expands into the
 * output. An untagged call still renders exactly as before, because a host
 * on an older provider must not grow a chevron that opens onto nothing.
 *
 * The `cc` mark in the row's gutter keeps the provenance visible either way:
 * pi never saw these calls, so they are absent from its own accounting.
 */
function ExternalToolRow({
  name,
  args,
  info,
  result,
  pending,
  sessionId,
}: {
  name: string
  args?: string
  info: ExternalToolInfo
  result?: ExternalToolResult
  /** Tagged for a result that has not landed yet: the tool is running. */
  pending: boolean
  sessionId: string
}): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)
  const workspacePath = useSessionsStore((s) => s.live[sessionId]?.workspacePath ?? undefined)
  const summary = summarizeExternalTool(name, info.fields, workspacePath)
  const failed = result?.status === 'error'
  // Only an outcome with something in it earns a disclosure control.
  const expandable = !!result && (!!result.preview || !!result.error)
  const title = args ? `Claude Code · ${name} ${args}` : `Claude Code · ${name}`

  const body = (
    <>
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
      <span
        className={clsx(
          'shrink-0',
          failed ? 'text-danger' : 'text-text-secondary',
          pending && 'tool-running-label',
        )}
      >
        {summary.label}
      </span>
      {summary.object && (
        <span
          className={clsx(
            'min-w-0 truncate font-medium',
            failed ? 'text-danger' : 'text-text',
            summary.mono && 'font-mono text-base',
          )}
        >
          {summary.object}
        </span>
      )}
      {summary.hint && (
        <span className="text-text-tertiary min-w-0 shrink truncate font-mono text-sm">
          {summary.hint}
        </span>
      )}
      {/* The outcome, in the provider's own words. Right-aligned so a column
          of rows reads as "what ran … what came of it" rather than burying
          the result inside the label. */}
      {result?.summary && (
        <span
          data-testid="external-tool-outcome"
          className={clsx(
            // Capped, not `shrink-0`: a summary runs to 160 characters (a
            // failure quotes the CLI's message), and the command is what the
            // row is about.
            'ml-auto max-w-[45%] min-w-0 truncate font-mono text-sm',
            failed ? 'text-danger' : 'text-text-tertiary',
          )}
        >
          {result.summary}
        </span>
      )}
      {failed && (
        <span className="bg-danger-soft text-danger shrink-0 rounded px-1.5 py-px text-xs font-medium">
          failed
        </span>
      )}
      {pending && (
        <span
          aria-hidden
          data-testid="external-tool-running"
          className="bg-accent tool-running-dot ml-auto h-1.5 w-1.5 shrink-0 rounded-full"
        />
      )}
      {expandable && <ChevronIcon expanded={expanded} className="text-text-tertiary" />}
    </>
  )

  return (
    <div>
      {expandable ? (
        <button
          onClick={() => setExpanded((e) => !e)}
          aria-expanded={expanded}
          className={clsx(
            'relative flex w-full items-center gap-1.5 py-1 text-left text-lg transition-colors',
            ROW_INSET,
            !failed && 'hover:text-text',
          )}
          data-testid="external-tool-row"
          title={title}
        >
          {body}
        </button>
      ) : (
        <div
          className={clsx('relative flex items-center gap-1.5 py-1 text-lg', ROW_INSET)}
          data-testid="external-tool-row"
          // The full marker, for the case the label had to drop something.
          title={title}
        >
          {body}
        </div>
      )}
      {expanded && result && (
        // Same full-width section a pi tool's detail gets — not a nested
        // card, which read as box-in-a-box.
        <div className="border-border expand-enter border-t">
          <ExternalToolDetail name={name} result={result} />
        </div>
      )}
    </div>
  )
}

/**
 * What a CLI-side tool returned.
 *
 * The provider caps the preview at 2,000 characters and reports the full
 * size, so this says which it is showing rather than pretending the preview
 * is the whole output — the rest is only in Claude Code's own transcript,
 * which is not something a reader can reach from here.
 */
function ExternalToolDetail({
  name,
  result,
}: {
  name: string
  result: ExternalToolResult
}): React.JSX.Element {
  const text = result.preview ?? result.error ?? ''
  const failed = result.status === 'error'

  return (
    <div>
      <div className="border-border flex items-center justify-between gap-2 border-b px-3 py-2">
        <span className="text-text-tertiary min-w-0 flex-1 truncate font-mono text-sm">
          {name}
          {result.summary ? ` · ${result.summary}` : ''}
        </span>
        <div className="flex shrink-0 items-center gap-2">
          <span
            className={clsx(
              'rounded px-1.5 py-px font-mono text-xs font-medium',
              failed ? 'bg-danger-soft text-danger' : 'bg-success/15 text-success',
            )}
          >
            {failed ? 'error' : 'ok'}
          </span>
          {text && <CopyButton text={text} />}
        </div>
      </div>
      <pre
        data-testid="external-tool-preview"
        className={clsx(
          'max-h-80 overflow-auto px-3 py-2.5 font-mono text-base leading-relaxed break-words whitespace-pre-wrap',
          failed ? 'text-danger' : 'terminal-output',
        )}
      >
        {text || '(no output)'}
      </pre>
      {result.truncated && (
        <div className="border-border text-text-tertiary border-t px-3 py-1.5 text-sm">
          Showing the first {result.preview?.length.toLocaleString()} of{' '}
          {result.length?.toLocaleString()} characters — the rest stayed in Claude Code&apos;s own
          transcript.
        </div>
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
 *
 * STATUS is marker-fed; PROGRESS is joined live from the status channel by
 * `taskId`. The two markers arrive at the start and the end, so without the
 * join a running row has nothing to say for its whole life — eight of them
 * said "running" and nothing else for the eight minutes of one fan-out. The
 * overlay only ever ADDS to a live row: it cannot move a status (a `launched`
 * agent stays launched) and it is ignored once the row is terminal, so the
 * provider clearing the key at the end of an episode leaves settled rows
 * exactly as their markers left them.
 */
function SubagentRow({
  agent,
  sessionId,
}: {
  agent: SubagentBlock
  sessionId: string
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const expandable = Boolean(agent.prompt)
  const done = isTerminalAgentStatus(agent.status)

  // The raw string, not a derived object: a selector that parsed here would
  // return a fresh identity on every store tick and re-render every row.
  const statusText = useExtensionUiStore((s) => s.statuses[sessionId]?.[SUBAGENTS_STATUS_KEY])
  const live = useMemo(
    () => (done ? undefined : findLiveSubagent(statusText, agent.taskId)),
    [done, statusText, agent.taskId],
  )
  // "Running Read stream-parser.ts" while it runs; the tool name alone between
  // steps, which is the only thing left when the provider clears the step.
  const liveStep = live?.currentStep ?? live?.lastToolName

  // Cost is a terminal fact in the markers, so a running agent has none of it
  // until it finishes. The live snapshot carries it the whole way, which is
  // what turns a silent row into one that visibly climbs.
  const toolUses = agent.toolUses ?? live?.toolUses
  const totalTokens = agent.totalTokens ?? live?.totalTokens
  const durationMs = agent.durationMs ?? live?.durationMs
  const stats = [
    toolUses === undefined ? undefined : `${toolUses} tool${toolUses === 1 ? '' : 's'}`,
    totalTokens === undefined ? undefined : `${formatTokens(totalTokens)} tokens`,
    durationMs === undefined ? undefined : formatDuration(durationMs),
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
      {/* Its own line rather than a third segment in the header: the
          description already truncates there, and two competing truncating
          segments meant a long step ate the agent's name. */}
      {liveStep && (
        <div
          data-testid="subagent-step"
          className="text-text-tertiary mb-1 ml-5 mr-2 truncate text-sm"
        >
          {liveStep}
        </div>
      )}
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
