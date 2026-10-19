import { spawn, type ChildProcess } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'
import { errorText } from '@phosphor/shared/errors'
import { redact } from './environment'

/**
 * The one way the Host runs another program to inspect the machine.
 *
 * - stdin is /dev/null, never an open pipe. `pi -p` and friends wait for
 *   EOF on stdin, and a pipe nobody closes never delivers it (docs/pi-integration.md).
 * - The program leads its own process group. A timeout SIGKILLs the whole
 *   group, so a hung grandchild cannot keep the Host waiting.
 * - Output past the cap is read and dropped, so the program never blocks on
 *   a full pipe.
 * - The environment is exactly the one given; nothing is inherited.
 * - Output comes back with every secret value of that environment hidden,
 *   before any caller can pick a line or shorten it.
 */

export const PROBE_OUTPUT_CAP = 64 * 1024
const DEFAULT_TIMEOUT_MS = 10_000
/** After the SIGKILL: how long to wait for pipes held by a process that left the group. */
const CLOSE_GRACE_MS = 1_000

/** pi's environment, as a probe needs it: the variables, and the values never to return. */
export interface ProbeEnvironment {
  env: Record<string, string>
  secrets: readonly string[]
}

export interface ProbeResult {
  /** The exit code, or null when the program was killed or never started. */
  code: number | null
  signal: NodeJS.Signals | null
  stdout: string
  stderr: string
  timedOut: boolean
  /** Output past the cap was dropped. */
  truncated: boolean
  /** Why the program could not start (ENOENT, EACCES), when it could not. */
  error?: string
}

const live = new Set<ChildProcess>()

function killGroup(child: ChildProcess): void {
  if (child.pid === undefined) return
  try {
    process.kill(-child.pid, 'SIGKILL')
  } catch {
    // ESRCH: the group is already gone.
  }
}

export function probe(
  file: string,
  args: readonly string[],
  options: ProbeEnvironment & { timeoutMs?: number },
): Promise<ProbeResult> {
  let child: ChildProcess
  try {
    child = spawn(file, args, {
      cwd: '/',
      env: options.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    })
  } catch (error) {
    return Promise.resolve({ ...EMPTY, error: errorText(error) })
  }
  live.add(child)
  return new Promise((resolve) => {
    const kept = { stdout: [] as Buffer[], stderr: [] as Buffer[] }
    const size = { stdout: 0, stderr: 0 }
    const cut = { stdout: false, stderr: false }
    let timedOut = false
    let settled = false
    let grace: NodeJS.Timeout | undefined
    const timer = setTimeout(() => {
      timedOut = true
      killGroup(child)
      grace = setTimeout(() => settle(null, 'SIGKILL'), CLOSE_GRACE_MS)
    }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS)

    const text = (stream: 'stdout' | 'stderr') => {
      const bytes = Buffer.concat(kept[stream])
      // The cap can split a character. Leave its first bytes out, rather than
      // decoding them to U+FFFD, so a secret's first characters still end the text.
      const decoded = cut[stream] ? new StringDecoder('utf8').write(bytes) : bytes.toString('utf8')
      return redact(decoded, options.secrets, cut[stream])
    }

    const settle = (code: number | null, signal: NodeJS.Signals | null, error?: string) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      clearTimeout(grace)
      live.delete(child)
      // Whatever the program left running in its group goes with it.
      killGroup(child)
      child.stdout?.destroy()
      child.stderr?.destroy()
      resolve({
        code,
        signal,
        stdout: text('stdout'),
        stderr: text('stderr'),
        timedOut,
        truncated: cut.stdout || cut.stderr,
        ...(error === undefined ? {} : { error }),
      })
    }

    for (const stream of ['stdout', 'stderr'] as const) {
      child[stream]?.on('data', (chunk: Buffer) => {
        const room = PROBE_OUTPUT_CAP - size[stream]
        if (chunk.length > room) cut[stream] = true
        if (room <= 0) return
        const part = chunk.subarray(0, room)
        kept[stream].push(part)
        size[stream] += part.length
      })
    }
    child.on('error', (error) => settle(null, null, errorText(error)))
    child.on('close', (code, signal) => settle(code, signal))
  })
}

const EMPTY: ProbeResult = {
  code: null,
  signal: null,
  stdout: '',
  stderr: '',
  timedOut: false,
  truncated: false,
}

/** SIGKILL every probe still running. For signal handlers on the way out. */
export function stopProbes(): void {
  for (const child of live) killGroup(child)
}

/** Why a probe failed, as a suffix for a report line, such as `: timed out`. */
export function probeFailure(result: ProbeResult): string {
  if (result.error) return `: ${result.error}`
  if (result.timedOut) return ': timed out'
  const line = (result.stderr.trim() || result.stdout.trim()).split('\n')[0]?.slice(0, 200)
  const how = result.signal ? `killed by ${result.signal}` : `exit ${result.code}`
  return line ? ` (${how}): ${line}` : ` (${how})`
}
