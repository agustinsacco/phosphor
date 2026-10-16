import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline/promises'

export class SetupCancelled extends Error {}

export interface SetupTerminal {
  confirm: (question: string, command?: string) => Promise<boolean>
  run: (file: string, args: readonly string[]) => Promise<number>
}

/** Inherit the real terminal, including sudo's password prompt. Never invoke a shell. */
export function setupTerminal(
  env: NodeJS.ProcessEnv,
  signal?: AbortSignal,
  output: 1 | 2 = 1,
): SetupTerminal {
  const destination = output === 2 ? process.stderr : process.stdout
  return {
    async confirm(question, command) {
      signal?.throwIfAborted()
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
    run(file, args) {
      signal?.throwIfAborted()
      return new Promise((resolve) => {
        const child = spawn(file, args, { env, stdio: ['inherit', output, 2], signal })
        child.once('error', () => resolve(signal?.aborted ? 130 : 1))
        child.once('close', (code) => resolve(signal?.aborted ? 130 : (code ?? 1)))
      })
    },
  }
}
