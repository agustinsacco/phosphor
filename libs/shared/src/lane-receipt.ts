import type { AgentMessage } from './rpc'

export interface LaneReceipt {
  title: string
  repository: string | null
  branch: string | null
  settledAt: number | null
  durationMs: number | null
  files: number
  added: number
  removed: number
  tests: 'passed' | 'failed' | null
  artifacts: number
  excerpt: string | null
  outcome: 'done' | 'error'
}

export interface ReceiptTool {
  name: string | null
  args?: Record<string, unknown>
  details?: unknown
  text?: string
  done: boolean
  error?: boolean
}
const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/** Only standalone test commands count. A compound shell command's exit is ambiguous. */
export function isTestCommand(command: string): boolean {
  if (/[;&|\n`<>]|\$\(/.test(command)) return false
  return /^(?:(?:npm|pnpm|yarn)(?: run)? test|(?:npx )?(?:vitest|jest|pytest)|cargo test|go test|npx playwright test|make test)(?:\s|$)/.test(
    command.trim(),
  )
}

export function receiptDuration(
  start: number | null | undefined,
  end: number | null | undefined,
): number | null {
  return typeof start === 'number' &&
    typeof end === 'number' &&
    Number.isFinite(start) &&
    Number.isFinite(end) &&
    start >= 0 &&
    end >= start
    ? end - start
    : null
}

/** Same completed edit/write line accounting as the Changes pane. */
export function receiptFacts(
  tools: readonly ReceiptTool[],
  workspacePath?: string,
): Pick<LaneReceipt, 'files' | 'added' | 'removed' | 'tests' | 'artifacts'> {
  const paths = new Set<string>(),
    artifacts = new Set<string>()
  let added = 0,
    removed = 0
  let tests: LaneReceipt['tests'] = null
  for (const tool of tools) {
    if (!tool.done) continue
    const details = record(tool.details) ? tool.details : {}
    if (
      tool.name === 'bash' &&
      typeof tool.args?.command === 'string' &&
      isTestCommand(tool.args.command)
    ) {
      // pi's bash result carries the nonzero exit in its final text, not details.
      const exit =
        typeof details.exitCode === 'number'
          ? details.exitCode
          : /(?:Process|Command) exited with code (\d+)/i.exec(tool.text ?? '')?.[1]
      if (exit !== undefined && exit !== null)
        tests = Number(exit) === 0 && tests !== 'failed' ? 'passed' : 'failed'
      else if (tool.text !== undefined && !tool.error)
        tests = tests === 'failed' ? 'failed' : 'passed'
    }
    if (tool.error) continue
    if (/^artifact_(create|edit|update)$/.test(tool.name ?? '') && typeof details.id === 'string')
      artifacts.add(details.id)
    if (
      (tool.name !== 'edit' && tool.name !== 'write') ||
      typeof tool.args?.path !== 'string' ||
      !tool.args.path
    )
      continue
    paths.add(
      workspacePath && tool.args.path.startsWith(workspacePath + '/')
        ? tool.args.path.slice(workspacePath.length + 1)
        : tool.args.path,
    )
    if (tool.name === 'write') {
      const content = tool.args.content
      if (typeof content === 'string' && content) added += content.split('\n').length
    } else {
      const display = typeof details.diff === 'string' && details.diff ? details.diff : null
      const patch = typeof details.patch === 'string' ? details.patch : ''
      for (const line of (display ?? patch).split('\n')) {
        if (
          display ? /^\+ *\d+(?:\s|$)/.test(line) : line.startsWith('+') && !line.startsWith('+++')
        )
          added++
        if (
          display ? /^- *\d+(?:\s|$)/.test(line) : line.startsWith('-') && !line.startsWith('---')
        )
          removed++
      }
    }
  }
  return { files: paths.size, added, removed, tests, artifacts: artifacts.size }
}

/** Last completed user-delimited run, never the prompt currently in flight. */
export function settledReceiptMessages(messages: readonly AgentMessage[]): readonly AgentMessage[] {
  let end = messages.length
  while (end > 0) {
    const last = messages[end - 1]
    if (last?.role === 'assistant' && last.stopReason !== 'toolUse') break
    end--
  }
  let start = end
  while (start > 0) {
    start--
    if (messages[start]?.role === 'user') break
  }
  return messages.slice(start, end)
}

export function messageReceiptTools(messages: readonly AgentMessage[]): ReceiptTool[] {
  const calls = new Map<string, { name: string; args: Record<string, unknown> }>()
  const tools: ReceiptTool[] = []
  for (const message of messages) {
    if (message.role === 'assistant')
      for (const block of message.content) {
        if (block.type === 'toolCall')
          calls.set(block.id, { name: block.name, args: block.arguments })
      }
    if (message.role === 'toolResult') {
      const call = calls.get(message.toolCallId)
      if (call)
        tools.push({
          ...call,
          done: true,
          error: message.isError,
          details: message.details,
          text: message.content
            .filter((b) => b.type === 'text')
            .map((b) => b.text)
            .join('\n'),
        })
    }
  }
  return tools
}

export function parseLaneReceipt(value: unknown): LaneReceipt | null {
  if (!record(value)) return null
  const {
    title,
    repository,
    branch,
    durationMs,
    settledAt,
    files,
    added,
    removed,
    tests,
    artifacts,
    excerpt,
    outcome,
  } = value
  const text = (v: unknown): v is string | null =>
    v === null || (typeof v === 'string' && v.length <= 2000)
  const count = (v: unknown): v is number =>
    typeof v === 'number' && Number.isSafeInteger(v) && v >= 0
  if (
    typeof title !== 'string' ||
    title.length > 2000 ||
    !text(repository) ||
    !text(branch) ||
    !text(excerpt) ||
    (excerpt !== null && excerpt.length > 140) ||
    !(
      settledAt === null ||
      (typeof settledAt === 'number' && Number.isFinite(settledAt) && settledAt >= 0)
    ) ||
    !count(files) ||
    !count(added) ||
    !count(removed) ||
    !count(artifacts) ||
    !(
      durationMs === null ||
      (typeof durationMs === 'number' && Number.isFinite(durationMs) && durationMs >= 0)
    ) ||
    (tests !== null && tests !== 'passed' && tests !== 'failed') ||
    (outcome !== 'done' && outcome !== 'error')
  )
    return null
  return {
    title,
    repository,
    branch,
    durationMs,
    settledAt,
    files,
    added,
    removed,
    tests,
    artifacts,
    excerpt,
    outcome,
  }
}

export function receiptDurationLabel(durationMs: number): string {
  const seconds = Math.floor(durationMs / 1000)
  if (!seconds) return '<1s'
  if (seconds < 60) return `${seconds}s`
  return `${Math.floor(seconds / 60)}m${seconds % 60 ? ` ${seconds % 60}s` : ''}`
}

/** Lock-screen safe: never include the reply, repository, branch or command. */
export function receiptSummary(receipt: LaneReceipt): string {
  const facts = [receipt.outcome === 'error' ? 'Stopped' : 'Done']
  if (receipt.durationMs !== null) facts[0] += ` in ${receiptDurationLabel(receipt.durationMs)}`
  if (receipt.files)
    facts.push(`${receipt.files} ${receipt.files === 1 ? 'file' : 'files'} changed`)
  if (receipt.tests) facts.push(receipt.tests === 'passed' ? 'tests pass' : 'tests failed')
  if (receipt.artifacts) facts.push(`${receipt.artifacts} artifacts`)
  return facts.join(' · ')
}
