import { spawn, type StdioOptions } from 'node:child_process'
import { basename } from 'node:path'
import { createInterface } from 'node:readline/promises'

export class SetupCancelled extends Error {}

/** How long a cancelled child gets to exit after SIGTERM before SIGKILL. */
export const KILL_GRACE_MS = 5_000

/**
 * `interactive` hands the terminal over (sudo's password, a sign-in); `task`
 * needs no input, so a terminal screen may show its output as a log instead.
 */
export type RunMode = 'interactive' | 'task'

export interface SetupTerminal {
  confirm: (question: string, command?: string) => Promise<boolean>
  run: (file: string, args: readonly string[], mode?: RunMode) => Promise<number>
}

/** The screen a person sees (ui/screen), which asks and shows tasks in place of plain lines. */
export interface TerminalScreen {
  /** Yes or no; a cancelled question throws SetupCancelled. */
  ask(question: string, signal?: AbortSignal): Promise<boolean>
  task(title: string): { line(text: string): void; done(text: string, ok: boolean): void }
  /** A child is about to take the terminal: stop drawing until it is done. */
  handOver(): void
}

/** Inherit the real terminal, including sudo's password prompt. Never invoke a shell. */
export function setupTerminal(
  env: NodeJS.ProcessEnv,
  signal?: AbortSignal,
  output: 1 | 2 = 1,
  screen?: TerminalScreen,
): SetupTerminal {
  const destination = output === 2 ? process.stderr : process.stdout
  const start = (file: string, args: readonly string[], stdio: StdioOptions) => {
    signal?.throwIfAborted()
    const child = spawn(file, args, { env, stdio })
    return { child, exited: settled(child, signal) }
  }
  return {
    async confirm(question, command) {
      signal?.throwIfAborted()
      if (screen) return screen.ask(question, signal)
      if (!process.stdin.isTTY || !destination.isTTY) {
        if (command) destination.write(`                     Run: ${command}\n`)
        return false
      }
      const interrupted = new AbortController()
      const reader = createInterface({ input: process.stdin, output: destination })
      reader.once('SIGINT', () => interrupted.abort())
      try {
        const answer = await reader.question(`                     ${question} [Y/n] `, {
          signal: signal ? AbortSignal.any([signal, interrupted.signal]) : interrupted.signal,
        })
        return answer.trim() === '' || /^y(es)?$/i.test(answer.trim())
      } catch (error) {
        if (interrupted.signal.aborted) throw new SetupCancelled()
        throw error
      } finally {
        reader.close()
      }
    },
    async run(file, args, mode = 'interactive') {
      if (!screen || mode === 'interactive') {
        screen?.handOver()
        return start(file, args, ['inherit', output, 2]).exited
      }
      const shown = screen.task([basename(file), ...args].join(' '))
      const { child, exited } = start(file, args, ['ignore', 'pipe', 'pipe'])
      const lines = (chunk: Buffer) => shown.line(chunk.toString('utf8'))
      child.stdout?.on('data', lines)
      child.stderr?.on('data', lines)
      const code = await exited
      shown.done(code === 0 ? 'done' : `failed (exit ${code})`, code === 0)
      return code
    },
  }
}

/** Cancel with SIGTERM, then SIGKILL; settle only once the child has really exited. */
function settled(child: ReturnType<typeof spawn>, signal?: AbortSignal): Promise<number> {
  return new Promise((resolve) => {
    let escalate: NodeJS.Timeout | undefined
    const stop = () => {
      child.kill('SIGTERM')
      escalate = setTimeout(() => child.kill('SIGKILL'), KILL_GRACE_MS)
    }
    signal?.addEventListener('abort', stop, { once: true })
    const settle = (code: number) => {
      signal?.removeEventListener('abort', stop)
      clearTimeout(escalate)
      resolve(signal?.aborted ? 130 : code)
    }
    child.once('error', () => settle(1))
    child.once('close', (code) => settle(code ?? 1))
  })
}
