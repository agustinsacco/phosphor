import { spawn } from 'node:child_process'

/**
 * Run a command in a process group of its own, without blocking the event
 * loop, until it exits, `timeoutMs` passes, or `signal` aborts. A deadline or
 * an abort kills the whole group (npx, vitest and its workers alike), so a
 * caller's signal handlers and cleanup still run while a test hangs.
 *
 * Resolves with the exit code, or null when a signal ended it. stdin is
 * closed: a process group that is not the terminal's foreground must not read it.
 */
export function runGroup(program, args, { cwd, env, timeoutMs, signal }) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return resolve(null)
    const child = spawn(program, args, {
      cwd,
      env,
      stdio: ['ignore', 'inherit', 'inherit'],
      detached: true,
    })
    // Only while the leader is alive (unreaped), so the group id is still ours.
    const kill = () => {
      try {
        process.kill(-child.pid, 'SIGKILL')
      } catch {
        // Already gone.
      }
    }
    const timer = setTimeout(kill, timeoutMs)
    signal?.addEventListener('abort', kill, { once: true })
    const done = () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', kill)
    }
    child.once('error', (error) => {
      done()
      reject(error)
    })
    // code is null when a signal ended it, ours or anyone's.
    child.once('exit', (code) => {
      done()
      resolve(code)
    })
  })
}
