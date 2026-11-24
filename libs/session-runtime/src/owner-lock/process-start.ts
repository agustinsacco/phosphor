import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { promisify } from 'node:util'

/**
 * A process's start time, as text that is equal for the same process and
 * different for a later process given the same pid. Null when it cannot be
 * read; the owner lock then decides on liveness alone and never steals.
 */

export interface ProcessStartPorts {
  readonly platform: NodeJS.Platform
  readFile(path: string): Promise<string>
  /** stdout of `ps -o lstart= -p <pid>`. */
  ps(pid: number): Promise<string>
}

const execFileAsync = promisify(execFile)

const nodePorts: ProcessStartPorts = {
  platform: process.platform,
  readFile: (path) => readFile(path, 'utf8'),
  // An absolute path, because launchd's PATH is minimal. Desktop and the
  // daemon run with different locales and zones; a fixed C locale and UTC
  // make both print the same text for the same process.
  ps: async (pid) =>
    (
      await execFileAsync('/bin/ps', ['-o', 'lstart=', '-p', String(pid)], {
        env: { LC_ALL: 'C', TZ: 'UTC0' },
        timeout: 5_000,
        maxBuffer: 4_096,
      })
    ).stdout,
}

/** `starttime` (field 22) of `/proc/<pid>/stat`, read after the command name's last `)`. */
export function parseLinuxStartTicks(stat: string): string | null {
  const end = stat.lastIndexOf(')')
  if (end < 0) return null
  const ticks = stat.slice(end + 2).split(' ')[19]
  return ticks !== undefined && /^\d+$/.test(ticks) ? ticks : null
}

export async function readProcessStart(
  pid: number,
  ports: ProcessStartPorts = nodePorts,
): Promise<string | null> {
  if (!Number.isSafeInteger(pid) || pid <= 0 || pid > 2147483647) return null
  try {
    if (ports.platform === 'linux') {
      // Ticks count from boot, so the boot id keeps a start from an earlier boot apart.
      const [stat, bootId] = await Promise.all([
        ports.readFile(`/proc/${pid}/stat`),
        ports.readFile('/proc/sys/kernel/random/boot_id'),
      ])
      const ticks = parseLinuxStartTicks(stat)
      const boot = bootId.trim()
      return ticks && boot ? `linux:${boot}:${ticks}` : null
    }
    if (ports.platform === 'darwin') {
      const started = (await ports.ps(pid)).trim().replace(/\s+/g, ' ')
      return started ? `darwin:${started}` : null
    }
  } catch {
    /* A gone process or an unreadable table: unknown. */
  }
  return null
}
