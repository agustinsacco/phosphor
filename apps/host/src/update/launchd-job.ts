import { randomUUID } from 'node:crypto'
import { lstatSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { errnoIs } from '@phosphor/session-runtime/fs-safety'
import { HOST_AGENT } from '@phosphor/shared/host-local'
import { prepareStateDirectory } from '../lanes/state-dir'
import { launchdStatusLines, xml } from '../machine/launchd'
import type { ServiceRunner } from '../machine/systemd'

/** The one-shot job an update moves into when it was started inside the macOS service. */
export const UPDATE_JOB_LABEL = 'com.saccolabs.phosphor-host-update'

export interface UpdateJob {
  label: string
  /** `<state>/update/<label>.plist`: never in `~/Library/LaunchAgents`, so login never loads it. */
  plist: string
  /** The job's output, read after the service restarts. */
  log: string
}

export function updateJob(state: string, label: string = UPDATE_JOB_LABEL): UpdateJob {
  const folder = join(state, 'update')
  return { label, plist: join(folder, `${label}.plist`), log: join(folder, 'update.log') }
}

/** `RunAtLoad` and no `KeepAlive`: launchd runs it once and never restarts it. */
export function updateJobPlist(
  job: UpdateJob,
  program: readonly string[],
  env: Readonly<Record<string, string>>,
): string {
  if (!program.length || !isAbsolute(program[0]!) || !isAbsolute(job.log))
    throw new Error('The update job needs absolute paths.')
  const strings = (values: readonly string[]) =>
    values.map((value) => `<string>${xml(value)}</string>`).join('')
  const variables = Object.entries(env)
    .map(([name, value]) => `<key>${xml(name)}</key><string>${xml(value)}</string>`)
    .join('')
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${xml(job.label)}</string>
<key>ProgramArguments</key><array>${strings(program)}</array>
<key>EnvironmentVariables</key><dict>${variables}</dict>
<key>RunAtLoad</key><true/>
<key>ProcessType</key><string>Background</string>
<key>StandardOutPath</key><string>${xml(job.log)}</string>
<key>StandardErrorPath</key><string>${xml(job.log)}</string>
</dict></plist>
`
}

function writePrivate(path: string, text: string): void {
  const temp = `${path}.${randomUUID()}.tmp`
  try {
    writeFileSync(temp, text, { mode: 0o600, flag: 'wx' })
    renameSync(temp, path)
  } finally {
    rmSync(temp, { force: true })
  }
}

/**
 * Writes the job under the state folder, boots out a stale job of the same
 * label, then bootstraps this one in the user's GUI domain. True once launchd
 * took it.
 */
export async function startUpdateJob(
  runner: ServiceRunner,
  uid: number | undefined,
  job: UpdateJob,
  program: readonly string[],
  env: Readonly<Record<string, string>>,
): Promise<boolean> {
  prepareStateDirectory(join(job.plist, '..'), uid)
  writePrivate(job.plist, updateJobPlist(job, program, env))
  // A missing job exits 3; anything left from an earlier update must go first.
  await runner('launchctl', ['bootout', `gui/${uid}/${job.label}`])
  const result = await runner('launchctl', ['bootstrap', `gui/${uid}`, job.plist])
  return result.code === 0
}

/** The service's pid while launchd runs it; null when it is not running. */
export async function servicePid(
  runner: ServiceRunner,
  uid: number | undefined,
): Promise<number | null> {
  const status = await runner('launchctl', ['print', `gui/${uid}/${HOST_AGENT}`])
  if (status.code !== 0 || status.stdout.length > 65536) return null
  const line = launchdStatusLines(status.stdout).find((entry) => entry.startsWith('pid = '))
  const pid = line ? Number(line.slice('pid = '.length)) : 0
  return pid > 0 ? pid : null
}

/**
 * At the next daemon start: a finished update job is booted out and its plist
 * removed. A job that still runs is the updater checking this daemon's health,
 * so it is left alone. Nothing runs when no plist was written.
 */
export async function retireUpdateJob(
  runner: ServiceRunner,
  uid: number | undefined,
  job: UpdateJob,
): Promise<void> {
  try {
    lstatSync(job.plist)
  } catch (error) {
    if (errnoIs(error, 'ENOENT')) return
    throw error
  }
  const status = await runner('launchctl', ['print', `gui/${uid}/${job.label}`])
  if (status.code === 0 && launchdStatusLines(status.stdout).includes('state = running')) return
  if (status.code === 0) await runner('launchctl', ['bootout', `gui/${uid}/${job.label}`])
  rmSync(job.plist, { force: true })
}

/** At daemon start on macOS: retires a finished update job without holding the start up. */
export function retireUpdateJobAtStart(
  state: string,
  uid: number | undefined,
  runner: ServiceRunner,
  log: (event: string, fields: Record<string, unknown>) => void,
  label?: string,
): void {
  retireUpdateJob(runner, uid, updateJob(state, label)).catch((error: unknown) =>
    log('update_job.retire_failed', { error: String(error) }),
  )
}
