import { stripAnsi } from '@shared/ansi'
import type { ExtensionUIRequest } from '@shared/rpc'

/**
 * Command-approval dialogs, recognised and explained.
 *
 * A permission-gate extension (pi's convention: `~/.pi/agent/extensions/`)
 * intercepts a `bash` tool call, decides the command is dangerous, and asks
 * the user through `ctx.ui.select` / `ctx.ui.confirm`. All Phosphor receives is
 * the prose the extension wrote — one string, the whole command inside it,
 * no structure. Rendered as a dialog title that is a 4000-character wall of
 * shell script, which is what the user actually saw.
 *
 * So two jobs live here, both pure:
 *
 * 1. `parseCommandApproval` — decide that a dialog IS a command approval and
 *    pull the command back out of the prose. Deliberately tolerant: the
 *    extension is third-party and its wording will drift. A miss falls back
 *    to the generic dialog, it never blocks the user.
 * 2. `analyzeCommand` — say WHICH part is dangerous and why. The extension
 *    does not tell us (its answer is a boolean), so Phosphor re-derives it from
 *    the same pattern classes those gates use. Two consequences worth
 *    knowing: Phosphor can name a risk the gate did not match on, and it can
 *    fail to find one at all — `risks.length === 0` is a real state the UI
 *    has to render honestly rather than paper over.
 *
 * The `context` field is the payoff. A gate matching `\brm\s+-rf\b` fires on
 * the text `rm -rf` sitting inside a heredoc body that is being WRITTEN to a
 * file, not run. Marking that match as `heredoc` rather than `command` is
 * the difference between "this deletes your files" and "this writes a script
 * that mentions deleting files".
 */

/** A dialog that is asking permission to run one shell command. */
export interface CommandApproval {
  /** The command, dedented, exactly as it would be run. */
  command: string
  /** The extension's own lead-in, e.g. `Dangerous command`. */
  heading: string
}

/** Where in the command text a risky match landed. */
export type RiskContext = 'command' | 'heredoc' | 'quoted'

export interface CommandRisk {
  id: string
  /** Short name for the chip, e.g. `rm -rf`. */
  label: string
  /** One plain sentence: what this does to the machine. */
  why: string
  severity: 'high' | 'medium'
  /** Character range in the command string. */
  start: number
  end: number
  /** The matched text itself. */
  text: string
  context: RiskContext
}

/**
 * Risk classes, mirroring what permission gates in the wild match on.
 *
 * Each entry owns its own explanation because "dangerous" alone is what made
 * the old dialog useless. Patterns are intentionally a little wider than a
 * gate's (e.g. any `rm` flag cluster containing `r` or `f`, not just `-rf`):
 * we are explaining a decision that was already made, so over-matching costs
 * an extra chip while under-matching costs the whole feature.
 */
const RISK_PATTERNS: ReadonlyArray<{
  id: string
  label: string
  why: string
  severity: CommandRisk['severity']
  pattern: RegExp
}> = [
  {
    id: 'rm-recursive',
    label: 'rm -rf',
    why: 'Deletes files and directories recursively, with no prompt and no undo.',
    severity: 'high',
    pattern: /\brm\s+(?:-[a-zA-Z]*[rRf][a-zA-Z]*|--recursive|--force)/g,
  },
  {
    id: 'sudo',
    label: 'sudo',
    why: 'Runs as root. Everything after it is outside the workspace.',
    severity: 'high',
    pattern: /\bsudo\b/g,
  },
  {
    id: 'su',
    label: 'su',
    why: 'Switches to another user account.',
    severity: 'high',
    pattern: /\bsu\b/g,
  },
  {
    id: 'shred',
    label: 'shred / truncate',
    why: 'Destroys file contents in place. The data cannot be recovered.',
    severity: 'high',
    pattern: /\b(?:shred|truncate)\b/g,
  },
  {
    id: 'force-push',
    label: 'git push --force',
    why: 'Overwrites remote history. Commits other clones hold can be lost.',
    severity: 'high',
    pattern: /\bgit\s+push\b[^\n;|&]*?--force(?:-with-lease)?\b/g,
  },
  {
    id: 'reset-hard',
    label: 'git reset --hard',
    why: 'Discards every uncommitted change in the working tree.',
    severity: 'high',
    pattern: /\bgit\s+reset\s+--hard\b/g,
  },
  {
    id: 'kill',
    label: 'kill',
    why: 'Terminates running processes.',
    severity: 'medium',
    pattern: /\b(?:kill|pkill|killall)\b/g,
  },
  {
    id: 'aws',
    label: 'aws',
    why: 'Reaches live cloud infrastructure with your account credentials.',
    severity: 'medium',
    pattern: /\baws\s+\S/g,
  },
  {
    id: 'open-permissions',
    label: 'chmod 777',
    why: 'Grants every user on the machine full read, write and execute access.',
    severity: 'medium',
    pattern: /\b(?:chmod|chown)\b[^\n;|&]*?777/g,
  },
  {
    id: 'service',
    label: 'system services',
    why: 'Starts, stops or re-enables a system service.',
    severity: 'medium',
    pattern:
      /\b(?:systemctl\s+(?:start|stop|restart|enable|disable)|service\s+\S+\s+(?:start|stop|restart))\b/g,
  },
]

/** Trailing question a gate ends with when it wants a yes/no. */
const ASK_LINE = /^(?:allow|proceed|continue|run(?:\s+it)?|approve|ok|okay|confirm)\b[\s?.!]*$/i

/** Lead-in line naming the thing being approved. */
const HEADING_LINE = /^(.{0,80}?\b(?:command|shell|bash|script)\b.{0,40}?):?$/i

/** Option text meaning yes, and meaning no. */
const ALLOW_OPTION = /^(?:yes|allow|run|approve|ok|okay|proceed|continue)\b/i
const DENY_OPTION = /^(?:no|deny|block|cancel|reject|abort|stop|skip)\b/i

/**
 * Strip the common leading whitespace a gate uses to indent the command it
 * quotes back (`  ${command}`), so the command reads as it would be typed.
 */
function dedent(text: string): string {
  const lines = text.split('\n')
  let indent: number | undefined
  for (const line of lines) {
    if (line.trim() === '') continue
    const width = line.length - line.trimStart().length
    if (indent === undefined || width < indent) indent = width
  }
  if (!indent) return text
  return lines.map((line) => (line.trim() === '' ? line : line.slice(indent))).join('\n')
}

/**
 * Recognise a command-approval dialog and recover the command.
 *
 * Shape matched: a heading line naming a command, the command itself, then a
 * trailing yes/no question — the layout every gate example uses, because it
 * is what reads well in pi's own TUI. `select` also has to offer a
 * recognisable yes and no, or we cannot map the buttons and must not guess.
 */
export function parseCommandApproval(request: ExtensionUIRequest): CommandApproval | null {
  let text: string
  if (request.method === 'confirm') {
    text = `${stripAnsi(request.title)}\n\n${stripAnsi(request.message)}`
  } else if (request.method === 'select') {
    const options = request.options.map(stripAnsi)
    if (!options.some((o) => ALLOW_OPTION.test(o.trim()))) return null
    if (!options.some((o) => DENY_OPTION.test(o.trim()))) return null
    text = stripAnsi(request.title)
  } else {
    return null
  }

  const lines = text.replace(/\r\n/g, '\n').split('\n')

  // Heading: first non-empty line, and it has to name a command.
  let first = 0
  while (first < lines.length && (lines[first] ?? '').trim() === '') first++
  const headingMatch = HEADING_LINE.exec((lines[first] ?? '').trim())
  if (!headingMatch?.[1]) return null

  // Ask: last non-empty line, and it has to be the yes/no question.
  let last = lines.length - 1
  while (last >= 0 && (lines[last] ?? '').trim() === '') last--
  if (last <= first) return null
  if (!ASK_LINE.test((lines[last] ?? '').trim())) return null

  const command = dedent(lines.slice(first + 1, last).join('\n')).trim()
  if (command === '') return null

  return { command, heading: headingMatch[1].trim() }
}

/** Which of a `select`'s options mean yes and no, in the request's own words. */
export function approvalOptions(options: string[]): { allow: string; deny: string } | null {
  const allow = options.find((o) => ALLOW_OPTION.test(stripAnsi(o).trim()))
  const deny = options.find((o) => DENY_OPTION.test(stripAnsi(o).trim()))
  return allow !== undefined && deny !== undefined ? { allow, deny } : null
}

interface Span {
  start: number
  end: number
}

function inSpan(spans: Span[], start: number, end: number): boolean {
  return spans.some((span) => start >= span.start && end <= span.end)
}

/**
 * Heredoc bodies, as character ranges.
 *
 * A heredoc body is text being written, not run — the single biggest source
 * of "why is this dangerous?" confusion, because a script full of `rm -rf`
 * being saved to disk trips every gate on the way past. Nested `<<` inside a
 * body is skipped: it is content too.
 */
function heredocSpans(command: string): Span[] {
  const spans: Span[] = []
  const opener = /<<[-~]?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/g
  let match: RegExpExecArray | null
  while ((match = opener.exec(command)) !== null) {
    if (inSpan(spans, match.index, match.index)) continue
    const delimiter = match[2]
    const lineEnd = command.indexOf('\n', match.index)
    if (lineEnd === -1) break
    const body = lineEnd + 1
    // `<<-` strips leading tabs from the terminator; accept any indentation,
    // which costs nothing here and survives a gate that reflowed the command.
    const terminator = new RegExp(`^[ \\t]*${delimiter}[ \\t]*$`, 'm')
    terminator.lastIndex = 0
    const rest = command.slice(body)
    const found = terminator.exec(rest)
    const end = found ? body + found.index : command.length
    spans.push({ start: body, end })
    opener.lastIndex = end
  }
  return spans
}

/**
 * Quoted string ranges outside heredoc bodies.
 *
 * A match inside quotes is usually an argument or a message, not a command
 * being invoked — weaker evidence than a bare match, so the UI grades it
 * differently rather than dropping it.
 */
function quotedSpans(command: string, heredocs: Span[]): Span[] {
  const spans: Span[] = []
  let index = 0
  while (index < command.length) {
    if (inSpan(heredocs, index, index)) {
      const span = heredocs.find((s) => index >= s.start && index <= s.end)
      index = span ? span.end + 1 : index + 1
      continue
    }
    const char = command[index]
    if (char === '\\') {
      index += 2
      continue
    }
    if (char === "'" || char === '"') {
      const start = index
      index++
      while (index < command.length) {
        if (char === '"' && command[index] === '\\') {
          index += 2
          continue
        }
        if (command[index] === char) break
        index++
      }
      spans.push({ start: start + 1, end: index })
      index++
      continue
    }
    index++
  }
  return spans
}

/**
 * Find every risky construct in a command and say where it sits.
 *
 * Ordered by how much the user should care: real command matches first, then
 * severity, then position. Overlapping matches of the same class collapse to
 * the first, so a loop of ten `rm -rf` lines is one chip, not ten.
 */
export function analyzeCommand(command: string): CommandRisk[] {
  const heredocs = heredocSpans(command)
  const quoted = quotedSpans(command, heredocs)
  const risks: CommandRisk[] = []

  for (const { pattern: source, ...entry } of RISK_PATTERNS) {
    const pattern = new RegExp(source.source, source.flags)
    let match: RegExpExecArray | null
    let best: CommandRisk | undefined
    while ((match = pattern.exec(command)) !== null) {
      if (match[0] === '') {
        pattern.lastIndex++
        continue
      }
      const start = match.index
      const end = start + match[0].length
      const context: RiskContext = inSpan(heredocs, start, end)
        ? 'heredoc'
        : inSpan(quoted, start, end)
          ? 'quoted'
          : 'command'
      const risk: CommandRisk = { ...entry, start, end, text: match[0], context }
      // Prefer a real command-context match over an incidental one, so the
      // chip points at the occurrence that actually justifies the prompt.
      if (!best || (best.context !== 'command' && context === 'command')) best = risk
      if (context === 'command') break
    }
    if (best) risks.push(best)
  }

  const rank = { command: 0, quoted: 1, heredoc: 2 } as const
  return risks.sort(
    (a, b) =>
      rank[a.context] - rank[b.context] ||
      (a.severity === b.severity ? 0 : a.severity === 'high' ? -1 : 1) ||
      a.start - b.start,
  )
}

/** One line of the command, split into plain and risky runs for rendering. */
export interface CommandLine {
  /** 1-based line number, for the gutter. */
  number: number
  segments: Array<{ text: string; risk?: CommandRisk }>
  /** Any risk falls on this line — drives both the marker and focus mode. */
  flagged: boolean
}

/**
 * Split a command into rendered lines with the risky runs marked.
 *
 * Rendering does not get to re-scan the string: the highlight has to be the
 * same match the explanation above it names, or the two disagree.
 */
export function toCommandLines(command: string, risks: CommandRisk[]): CommandLine[] {
  const ordered = [...risks].sort((a, b) => a.start - b.start)
  const lines: CommandLine[] = []
  let offset = 0
  let number = 1

  for (const text of command.split('\n')) {
    const lineStart = offset
    const lineEnd = offset + text.length
    const segments: CommandLine['segments'] = []
    let cursor = lineStart

    for (const risk of ordered) {
      if (risk.end <= lineStart || risk.start >= lineEnd) continue
      const start = Math.max(risk.start, cursor)
      const end = Math.min(risk.end, lineEnd)
      if (end <= start) continue
      if (start > cursor) segments.push({ text: command.slice(cursor, start) })
      segments.push({ text: command.slice(start, end), risk })
      cursor = end
    }
    if (cursor < lineEnd || segments.length === 0) {
      segments.push({ text: command.slice(cursor, lineEnd) })
    }

    lines.push({ number, segments, flagged: segments.some((s) => s.risk) })
    offset = lineEnd + 1
    number++
  }

  return lines
}

/**
 * Line numbers worth showing when a command is too long to read whole:
 * every flagged line plus `context` lines around it, and always the first
 * and last line so the user can see how the command opens and closes.
 */
export function focusLines(lines: CommandLine[], context = 2): Set<number> {
  const keep = new Set<number>()
  if (lines.length === 0) return keep
  keep.add(lines[0]!.number)
  keep.add(lines[lines.length - 1]!.number)
  for (const line of lines) {
    if (!line.flagged) continue
    for (let n = line.number - context; n <= line.number + context; n++) {
      if (n >= 1 && n <= lines.length) keep.add(n)
    }
  }
  return keep
}
