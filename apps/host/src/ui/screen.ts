import { confirm, isCancel, log, note, taskLog, S_BAR_END, S_BAR_START } from '@clack/prompts'
import { SetupCancelled, type TerminalScreen } from '../commands/setup-terminal'
import { startSpinner, type Busy, type RichTerminal } from './spinner'
import {
  BAR,
  painter,
  RAIL,
  rowLines,
  TONE_STYLE,
  wrap,
  type Paint,
  type Row,
  type Tone,
} from './theme'

export type { Busy, RichTerminal } from './spinner'

/**
 * One command's output on a terminal: a rail that opens with the command,
 * one block per step or finding, spinners while it works, and a closing line.
 * Only a person reads it; scripts get the plain text or --json.
 */
export interface Screen extends TerminalScreen {
  readonly paint: Paint
  open(title: string, detail?: string): void
  say(text: string, tone?: Tone): void
  /** A titled block of aligned rows, with optional lines after them. */
  list(title: string, rows: readonly Row[], tone?: Tone, after?: readonly string[]): void
  note(body: string, title: string): void
  busy(text: string): Busy
  /** A spinner while `work` runs; it ends however the work does. */
  during<T>(text: string, work: () => Promise<T>): Promise<T>
  /** Yes or no, Yes first. Ctrl-C, Escape or the signal throw SetupCancelled. */
  ask(question: string, signal?: AbortSignal): Promise<boolean>
  /** A command whose output only matters when it fails: a log that collapses on success. */
  task(title: string): TaskOutput
  /** Ends any spinner and leaves a bar, so a child's own output starts on a clean line. */
  handOver(): void
  close(text: string, tone?: Tone): void
}

export interface TaskOutput {
  line(text: string): void
  done(text: string, ok: boolean): void
}

/** The screen for a person at a terminal; none for --json, pipes and CI logs. */
export function screenFor(terminal: RichTerminal | undefined, json?: boolean): Screen | null {
  return terminal && !json ? createScreen(terminal) : null
}

export function createScreen(terminal: RichTerminal): Screen {
  const { output, input } = terminal
  const paint = painter(terminal.color)
  let active: Busy | null = null
  /** Prints above a running spinner, which then carries on below. */
  const print = (write: () => void) => (active ? active.above(write) : write())
  const settle = () => {
    active?.clear()
    active = null
  }
  const symbol = (tone: Tone) => paint(TONE_STYLE[tone], RAIL[tone])
  /** The columns right of the rail; a closed or unknown width wraps at 80. */
  const width = () => (output.columns || 80) - 3
  const lines = (text: string) => text.split('\n').flatMap((line) => wrap(line, width()))
  const screen: Screen = {
    paint,
    open(title, detail) {
      const head = paint('bold', title) + (detail ? paint('dim', ` · ${detail}`) : '')
      output.write(`${paint('gray', S_BAR_START)}  ${head}\n`)
    },
    say(text, tone = 'done') {
      print(() => log.message(lines(text), { output, symbol: symbol(tone) }))
    },
    list(title, rows, tone = 'done', after = []) {
      const body = [
        paint('bold', title),
        ...rowLines(paint, rows, width()),
        ...after.flatMap(lines),
      ]
      print(() => log.message(body, { output, symbol: symbol(tone) }))
    },
    note(body, title) {
      print(() => note(body, paint('bold', title), { output }))
    },
    busy(text) {
      settle()
      const spinner: Busy = startSpinner(terminal, paint, text, () => {
        if (active === spinner) active = null
      })
      active = spinner
      return spinner
    },
    async during(text, work) {
      const shown = screen.busy(text)
      try {
        return await work()
      } finally {
        shown.clear()
      }
    },
    async ask(question, signal) {
      settle()
      const answer = await confirm({ message: question, input, output, signal })
      if (isCancel(answer)) throw new SetupCancelled()
      return answer
    },
    handOver() {
      settle()
      output.write(`${paint('gray', BAR)}\n`)
    },
    task(title) {
      settle()
      return taskOutput(output, title)
    },
    close(text, tone = 'done') {
      settle()
      const shown =
        tone === 'fail' ? paint('red', text) : tone === 'warn' ? paint('yellow', text) : text
      output.write(`${paint('gray', BAR)}\n${paint('gray', S_BAR_END)}  ${shown}\n\n`)
    },
  }
  return screen
}

/** A child's output as a log of its last lines, cleared on success and kept on failure. */
function taskOutput(output: RichTerminal['output'], title: string): TaskOutput {
  const shown = taskLog({ title, output, limit: 8 })
  return {
    line: (text) => {
      for (const line of text.split(/\r?\n/)) if (line.trim()) shown.message(line)
    },
    done: (text, ok) =>
      ok ? shown.success(`${title} · ${text}`) : shown.error(`${title} · ${text}`),
  }
}
