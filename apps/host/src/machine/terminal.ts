import { spawn } from 'node:child_process'
import { errorText } from '@phosphor/shared/errors'
import type { Drainable } from '../shutdown'

/** After SIGTERM, how long a program on the terminal gets before SIGKILL. */
const STOP_GRACE_MS = 2_000

export interface TerminalRun {
  /** The exit code, or null when it was killed or never started. */
  code: number | null
  /** Why it could not start (ENOENT, EACCES), when it could not. */
  error?: string
}

/**
 * Hand this terminal to a program until it exits: a login that must talk to
 * the person, such as pi's `/login` or `claude auth login`.
 *
 * The program shares the Host's process group, so it stays the terminal's
 * foreground job and can read from it; a probe's own group would be stopped
 * by SIGTTIN the moment it read. A signal to the Host (a closed SSH session,
 * say) stops it too, through `attach`: SIGTERM, then SIGKILL after a grace.
 */
export function runInTerminal(
  file: string,
  args: readonly string[],
  options: {
    cwd: string
    env: Record<string, string>
    attach?: (target: Drainable) => () => void
  },
): Promise<TerminalRun> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof spawn>
    try {
      child = spawn(file, args, { cwd: options.cwd, env: options.env, stdio: 'inherit' })
    } catch (error) {
      resolve({ code: null, error: errorText(error) })
      return
    }
    let detach = () => {}
    const exited = new Promise<void>((done) => {
      child.on('error', (error) => {
        detach()
        resolve({ code: null, error: errorText(error) })
        done()
      })
      child.on('exit', (code) => {
        detach()
        resolve({ code })
        done()
      })
    })
    if (options.attach) {
      let stopping: Promise<{ state: 'stopped' }> | null = null
      detach = options.attach({
        drain() {
          // A second signal does not wait out the grace.
          if (stopping) {
            child.kill('SIGKILL')
            return stopping
          }
          child.kill('SIGTERM')
          const grace = setTimeout(() => child.kill('SIGKILL'), STOP_GRACE_MS)
          stopping = exited.then(() => {
            clearTimeout(grace)
            return { state: 'stopped' as const }
          })
          return stopping
        },
        // A login writes nothing to the Host log, so there is nothing to hide.
        log: { write: () => {}, hide: (text) => text },
      })
    }
  })
}
