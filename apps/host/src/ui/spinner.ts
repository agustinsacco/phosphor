import type { Readable, Writable } from 'node:stream'
import { unicode } from '@clack/prompts'
import { BAR, RAIL, TONE_STYLE, type Paint, type Tone } from './theme'

/** The terminal a rich screen draws on. */
export interface RichTerminal {
  input: Readable & { isTTY?: boolean; setRawMode?: (raw: boolean) => unknown }
  output: Writable & { columns?: number }
  /** NO_COLOR and TERM=dumb turn colour off; the layout stays. */
  color: boolean
  /** Off in CI logs: a spinner draws once per change instead of every frame. */
  animate: boolean
  /** Ctrl-C while a spinner holds the keyboard: the Host's own SIGINT path. */
  interrupt: () => void
}

/** A line that is still working: a spinner, its text and how long it has run. */
export interface Busy {
  update(text: string): void
  /** Ends it as a finished line. */
  done(text: string, tone?: Tone): void
  /** Ends it without a trace. */
  clear(): void
  /** Erase it and its bar, print through `write` (which opens with its own bar), then draw it below. */
  above(write: () => void): void
}

const FRAMES = unicode ? ['◒', '◐', '◓', '◑'] : ['•', 'o', 'O', '0']
const ERASE = '\r\x1b[2K'
const UP_ERASE = '\x1b[1A\x1b[2K'
const HIDE = '\x1b[?25l'
const SHOW = '\x1b[?25h'
/** After this long a spinner shows its elapsed seconds. */
const SHOW_ELAPSED_MS = 4_000

/**
 * Clack's spinner, drawn the same way, without its keyboard handling: Clack's
 * exits 0 on Ctrl-C, past the Host's shutdown. This one swallows keys while
 * it runs, so typing cannot break the line, and turns Ctrl-C into SIGINT.
 */
export function startSpinner(
  terminal: RichTerminal,
  paint: Paint,
  initial: string,
  /** Once it has ended, either way. */
  onEnd: () => void = () => {},
  now: () => number = Date.now,
): Busy {
  const { output, input } = terminal
  const started = now()
  let text = initial.replace(/\.+$/, '')
  let frame = 0
  let ended = false
  const draw = () => {
    const seconds = Math.floor((now() - started) / 1000)
    const elapsed = now() - started >= SHOW_ELAPSED_MS ? paint('dim', ` ${seconds}s`) : ''
    const room = Math.max(10, (output.columns ?? 80) - 6 - (elapsed ? ` ${seconds}s`.length : 0))
    const shown = text.length > room ? `${text.slice(0, room - 1)}…` : text
    output.write(`${ERASE}${paint('magenta', FRAMES[frame]!)}  ${shown}${elapsed}`)
  }
  const keys = (chunk: Buffer | string) => {
    if (String(chunk).includes('\x03')) {
      end('Cancelled', 'fail')
      terminal.interrupt()
    }
  }
  const raw = input.isTTY === true && typeof input.setRawMode === 'function'
  const showCursor = () => output.write(SHOW)
  output.write(`${paint('gray', BAR)}\n${HIDE}`)
  process.once('exit', showCursor)
  if (raw) {
    input.setRawMode?.(true)
    input.on('data', keys)
    input.resume()
  }
  draw()
  const timer = terminal.animate
    ? setInterval(() => {
        frame = (frame + 1) % FRAMES.length
        draw()
      }, 80)
    : undefined
  function end(final: string | null, tone: Tone = 'done') {
    if (ended) return
    ended = true
    clearInterval(timer)
    if (raw) {
      input.off('data', keys)
      input.setRawMode?.(false)
      input.pause()
    }
    output.write(ERASE)
    // Without a final line the bar above it goes too.
    if (final === null) output.write(UP_ERASE)
    else output.write(`${paint(TONE_STYLE[tone], RAIL[tone])}  ${final}\n`)
    output.write(SHOW)
    process.removeListener('exit', showCursor)
    onEnd()
  }
  return {
    update(next) {
      text = next.replace(/\.+$/, '')
      if (!ended) draw()
    },
    done: (final, tone) => end(final, tone),
    clear: () => end(null),
    above(write) {
      if (ended) return write()
      output.write(`${ERASE}${UP_ERASE}`)
      write()
      output.write(`${paint('gray', BAR)}\n`)
      draw()
    },
  }
}
