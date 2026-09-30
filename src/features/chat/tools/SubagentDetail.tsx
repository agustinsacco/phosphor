import { useState } from 'react'
import clsx from 'clsx'
import type { ToolState } from '../reducer'
import { toolDetails, toolText, tryParseArgs } from './toolSummaries'
import {
  isChildLive,
  shortId,
  subagentCall,
  subagentRun,
  type SubagentAgentInfo,
  type SubagentCall,
  type SubagentChild,
  type SubagentRun,
} from '../subagentRuns'
import { Markdown } from '@/components/markdown/Markdown'
import { ChevronIcon } from '@/components/icons'
import { formatCost, formatDuration, formatTokens } from '@/lib/format'
import { ErrorText } from './toolDetails'
import { PathLink } from './PathLink'

/**
 * What a `subagent` call opens onto.
 *
 * A launch shows the task the model wrote and one card per child: what it is
 * doing right now while it runs (current tool, the last few tools, the last
 * line it said), and its answer as markdown once it is done. A detached launch
 * has no child here: the fleet chip carries it, and a completion card lands
 * in the transcript when it reports back. A management action shows what it
 * returned, with the agent catalogue laid out as a list rather than prose.
 */
export function SubagentDetail({ tool }: { tool: ToolState }): React.JSX.Element {
  const args = tool.args ?? tryParseArgs(tool.argsText)
  const call = subagentCall(args)
  const settled = tool.status === 'done' || tool.status === 'error'
  const run = subagentRun(toolDetails(tool), settled)
  const text = toolText(tool)
  const running = !settled

  if (call.kind === 'manage') {
    return (
      <div data-testid="subagent-detail" data-mode="manage">
        {call.action === 'list' && run?.agents ? (
          <AgentCatalogue agents={run.agents} />
        ) : tool.isError ? (
          <ErrorText text={text} />
        ) : call.action === 'guide' ? (
          <div className="max-h-96 overflow-auto px-3 py-2.5 text-base">
            <Markdown text={text} />
          </div>
        ) : (
          <pre className="max-h-80 overflow-auto px-3 py-2.5 font-mono text-base leading-relaxed break-words whitespace-pre-wrap">
            {text || <span data-find-skip>{running ? 'Running…' : '(no output)'}</span>}
          </pre>
        )}
      </div>
    )
  }

  // A single foreground child's answer IS the tool's text; pi-subagents also
  // copies it into `finalOutput`, but older versions did not.
  return <LaunchDetail tool={tool} call={call} run={run} answerIsText />
}

/**
 * What an omp `task` call opens onto: the same task section and one card per
 * subagent, read from omp's details and subagent frames
 * (`subagentRuns.ts`, "omp's `task`"). Its text is omp's spawn notice or the
 * merged results, never one child's answer, which each card carries itself.
 */
export function OmpTaskDetail({
  tool,
  view,
}: {
  tool: ToolState
  view: { call: SubagentCall; run: SubagentRun }
}): React.JSX.Element {
  if (view.call.kind !== 'launch') return <></>
  return <LaunchDetail tool={tool} call={view.call} run={view.run} answerIsText={false} />
}

function LaunchDetail({
  tool,
  call,
  run,
  answerIsText,
}: {
  tool: ToolState
  call: Extract<SubagentCall, { kind: 'launch' }>
  run: SubagentRun | null
  /** A lone settled child's answer is the tool's text when it carries none. */
  answerIsText: boolean
}): React.JSX.Element {
  const settled = tool.status === 'done' || tool.status === 'error'
  const text = toolText(tool)
  const running = !settled
  const children = run?.children ?? []
  const fallbackOutput =
    answerIsText && children.length === 1 && settled && !tool.isError ? text : undefined

  return (
    <div data-testid="subagent-detail" data-mode={run?.async ? 'async' : (run?.mode ?? 'single')}>
      {(call.task || call.script) && (
        <TaskSection task={call.task} script={call.script} workflow={call.workflow} />
      )}
      {run?.async && (
        <div
          data-testid="subagent-async-note"
          className="text-text-secondary border-border flex flex-wrap items-baseline gap-x-2 border-b px-3 py-2 text-base"
        >
          <span>Running in the background</span>
          {run.runId && (
            <span className="text-text-tertiary font-mono text-sm" title={run.runId}>
              {shortId(run.runId)}
            </span>
          )}
          {run.timeoutMs !== undefined && (
            <span className="text-text-tertiary text-sm">
              · up to {formatDuration(run.timeoutMs)}
            </span>
          )}
          <span className="text-text-tertiary text-sm">
            · reports back here as a completion card
          </span>
        </div>
      )}
      {children.map((child) => (
        <ChildCard
          key={child.index}
          child={child}
          fallbackOutput={child.output ?? fallbackOutput}
          // One child under its own task section would repeat that task as
          // its label; the label earns its place when children differ.
          showLabel={children.length > 1 || !call.task}
        />
      ))}
      {children.length === 0 &&
        !run?.async &&
        (tool.isError || (settled && text)) &&
        (tool.isError ? (
          <ErrorText text={text} />
        ) : (
          <div className="max-h-96 overflow-auto px-3 py-2.5 text-base">
            <Markdown text={text} />
          </div>
        ))}
      {children.length === 0 && !run?.async && running && (
        <div className="text-text-tertiary px-3 py-2.5 text-base" data-find-skip>
          Starting…
        </div>
      )}
    </div>
  )
}

/** The prompt the model wrote for its agent; a script when it wrote code. */
function TaskSection({
  task,
  script,
  workflow,
}: {
  task?: string
  script?: string
  workflow?: string
}): React.JSX.Element {
  const body = task ?? script ?? ''
  const long = body.length > 280 || body.split('\n').length > 4
  const [open, setOpen] = useState(!long)
  const title = script ? 'Workflow script' : workflow ? `Workflow ${workflow}` : 'Task'
  return (
    <div data-find-skip className="border-border border-b px-3 py-2">
      <button
        onClick={() => setOpen((o) => !o)}
        className="text-text-tertiary hover:text-text flex items-center gap-1 text-sm transition-colors"
      >
        <ChevronIcon expanded={open} className="text-text-tertiary" />
        <span>{title}</span>
        {!open && (
          <span className="text-text-tertiary min-w-0 truncate">
            · {body.replace(/\s+/g, ' ').slice(0, 96)}
          </span>
        )}
      </button>
      {open && (
        <div
          data-testid="subagent-task"
          className={clsx(
            'border-accent/30 text-text-secondary mt-1.5 max-h-72 overflow-auto border-l-2 pl-2.5 text-base whitespace-pre-wrap break-words',
            script && 'font-mono text-sm',
          )}
        >
          {body}
        </div>
      )}
    </div>
  )
}

const STATUS_WORD: Record<SubagentChild['status'], string> = {
  pending: 'queued',
  running: 'running',
  completed: 'done',
  failed: 'failed',
  stopped: 'stopped',
  detached: 'detached',
}

function statusTone(status: SubagentChild['status']): string {
  switch (status) {
    case 'running':
    case 'pending':
      return 'text-accent'
    case 'failed':
      return 'text-danger'
    case 'stopped':
    case 'detached':
      return 'text-warning'
    default:
      return 'text-text-tertiary'
  }
}

/** `openai-codex/gpt-6-astra` → `gpt-6-astra`. */
const modelName = (model: string): string => model.slice(model.lastIndexOf('/') + 1)

function ChildCard({
  child,
  fallbackOutput,
  showLabel,
}: {
  child: SubagentChild
  fallbackOutput?: string
  showLabel: boolean
}): React.JSX.Element {
  const live = isChildLive(child)
  const stats = [
    child.model ? modelName(child.model) : undefined,
    child.toolCount === undefined
      ? undefined
      : `${child.toolCount} tool${child.toolCount === 1 ? '' : 's'}`,
    child.turnCount === undefined
      ? undefined
      : `${child.turnCount} turn${child.turnCount === 1 ? '' : 's'}`,
    child.tokens === undefined ? undefined : `${formatTokens(child.tokens)} tokens`,
    child.durationMs === undefined ? undefined : formatDuration(child.durationMs),
    child.costUsd === undefined ? undefined : formatCost(child.costUsd),
  ].filter(Boolean)
  const output = live ? undefined : fallbackOutput
  return (
    <div
      data-testid="subagent-child"
      data-status={child.status}
      className="border-border border-b px-3 py-2 last:border-b-0"
    >
      <div className="flex min-w-0 items-center gap-2 text-base">
        <span
          className={clsx(
            'shrink-0 rounded px-1.5 py-px text-xs font-semibold uppercase tracking-wide',
            live ? 'bg-accent-soft text-accent' : 'bg-bg-secondary text-text-secondary',
          )}
        >
          agent
        </span>
        <span className="text-text shrink-0 font-medium">{child.agent}</span>
        {showLabel && child.label && (
          <span className="text-text-secondary min-w-0 truncate" title={child.label}>
            {child.label}
          </span>
        )}
        <span className={clsx('shrink-0 text-sm', statusTone(child.status))}>
          {STATUS_WORD[child.status]}
        </span>
        {stats.length > 0 && (
          <span className="text-text-tertiary ml-auto shrink-0 font-mono text-sm">
            {stats.join(' · ')}
          </span>
        )}
      </div>
      {live && child.currentTool && (
        <div
          data-testid="subagent-current-tool"
          className="text-text-secondary tool-running-label mt-1 ml-5 truncate font-mono text-sm"
        >
          ⎿ {child.currentTool}
        </div>
      )}
      {live && child.recentTools.length > 0 && (
        <ul className="text-text-tertiary mt-0.5 ml-5 font-mono text-sm">
          {child.recentTools.map((line, i) => (
            <li key={i} className="truncate">
              {line}
            </li>
          ))}
        </ul>
      )}
      {live && child.recentOutput.length > 0 && (
        <div className="text-text-tertiary mt-1 ml-5 truncate text-sm italic">
          {child.recentOutput.at(-1)}
        </div>
      )}
      {child.error && <ErrorText text={child.error} />}
      {output && (
        <div data-testid="subagent-output" className="mt-1.5 max-h-96 overflow-auto text-base">
          <Markdown text={output} />
        </div>
      )}
      {(child.sessionFile || child.outputPath) && (
        <div className="text-text-tertiary mt-1.5 flex flex-wrap gap-x-3 text-sm">
          {child.sessionFile && (
            <span className="flex min-w-0 items-baseline gap-1">
              <span>session</span>
              <PathLink path={child.sessionFile} />
            </span>
          )}
          {child.outputPath && (
            <span className="flex min-w-0 items-baseline gap-1">
              <span>output</span>
              <PathLink path={child.outputPath} />
            </span>
          )}
        </div>
      )}
    </div>
  )
}

/** `action: "list"`: who can be delegated to, and who cannot right now. */
function AgentCatalogue({ agents }: { agents: SubagentAgentInfo[] }): React.JSX.Element {
  return (
    <ul data-testid="subagent-catalogue" className="divide-border/50 divide-y">
      {agents.map((agent) => (
        <li key={agent.name} className="flex min-w-0 items-baseline gap-2 px-3 py-1.5 text-base">
          <span
            className={clsx(
              'shrink-0 font-mono font-medium',
              agent.available ? 'text-text' : 'text-text-tertiary line-through',
            )}
          >
            {agent.name}
          </span>
          {agent.source && (
            <span className="text-text-tertiary shrink-0 text-2xs uppercase tracking-wide">
              {agent.source}
            </span>
          )}
          <span className="text-text-secondary min-w-0 truncate" title={agent.description}>
            {agent.available ? agent.description : (agent.unavailableReason ?? 'unavailable')}
          </span>
          {agent.model && (
            <span className="text-text-tertiary ml-auto shrink-0 font-mono text-sm">
              {modelName(agent.model)}
            </span>
          )}
        </li>
      ))}
    </ul>
  )
}
