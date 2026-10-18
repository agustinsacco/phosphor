import { randomUUID } from 'node:crypto'
import {
  closeSync,
  constants,
  fstatSync,
  ftruncateSync,
  openSync,
  readSync,
  unlinkSync,
  writeSync,
} from 'node:fs'
import type { RuntimeLog } from '@phosphor/session-runtime/file-log'
import { mkdir, open, rename, unlink } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'
import { IdentityFailure } from '../control/identity'
import { errnoCode, errnoIs } from '../fs-safety'
import { hostLogDirectory } from './log'
export {
  writeServiceUnit as writeLaunchAgent,
  removeServiceUnit as removeLaunchAgent,
} from './systemd'

export const HOST_AGENT = 'com.saccolabs.phosphor-host'
function xml(value: string): string {
  if (value.length > 65536 || /[\p{Cc}\u2028\u2029]/u.test(value))
    throw new IdentityFailure('Service paths and PATH must not contain control characters.')
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
}
export function launchAgentPlist(
  node: string,
  bundle: string,
  config: string,
  path: string,
  logDir: string,
): string {
  if (![node, bundle, config, logDir].every(isAbsolute))
    throw new IdentityFailure('Service paths must be absolute.')
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${xml(HOST_AGENT)}</string>
<key>ProgramArguments</key><array>${[node, bundle, 'run', '--config', config, '--supervisor', 'launchd'].map((value) => `<string>${xml(value)}</string>`).join('')}</array>
<key>EnvironmentVariables</key><dict><key>PATH</key><string>${xml(path)}</string></dict>
<key>RunAtLoad</key><true/>
<key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>
<key>ExitTimeOut</key><integer>30</integer>
<key>ThrottleInterval</key><integer>10</integer>
<key>ProcessType</key><string>${xml('Background')}</string>
<key>StandardOutPath</key><string>${xml('/dev/null')}</string>
<key>StandardErrorPath</key><string>${xml(join(logDir, 'launchd.err.log'))}</string>
</dict></plist>
`
}

// Measured on macOS 26: bootout of a missing job exits 3; print/kickstart exit 113.
export function launchctlMissing(
  command: 'bootout' | 'print' | 'kickstart',
  code: number | null,
): boolean {
  return code === (command === 'bootout' ? 3 : 113)
}
export function launchdStatusLines(stdout: string): string[] {
  return stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(
      (line) =>
        /^state = [a-z-]{1,40}$/.test(line) || /^(?:pid|last exit code) = \d{1,10}$/.test(line),
    )
}
const reasons: Readonly<Record<number, string>> = {
  64: 'usage error',
  69: 'prerequisite unavailable',
  77: 'machine removed',
  78: 'config invalid',
}
export function permanentServiceReason(code: number): string | undefined {
  return reasons[code]
}
export function serviceExitPath(env: NodeJS.ProcessEnv, home: string): string {
  return join(dirname(hostLogDirectory(env, home)), 'service-exit.json')
}
const missing = (error: unknown) => error instanceof Error && errnoIs(error, 'ENOENT')
/** Read only a bounded suffix, even when a file has a single enormous line. */
export async function readLogTail(
  path: string,
  lines: number,
  bytes = 256 * 1024,
): Promise<{ text: string; end: number }> {
  const file = await open(path, 'r')
  try {
    const size = (await file.stat()).size
    const start = Math.max(0, size - bytes)
    const buffer = Buffer.alloc(Math.min(size, bytes))
    const read = await file.read(buffer, 0, buffer.length, start)
    let text = buffer.subarray(0, read.bytesRead).toString('utf8')
    if (start > 0) text = text.slice(text.indexOf('\n') + 1)
    return { text: text.trimEnd().split('\n').slice(-lines).join('\n'), end: size }
  } finally {
    await file.close()
  }
}
export async function readServiceExit(path: string): Promise<string | undefined> {
  try {
    const file = await open(path, 'r')
    let text: string
    try {
      if ((await file.stat()).size > 1024) return undefined
      const buffer = Buffer.alloc(1025)
      const read = await file.read(buffer, 0, buffer.length, 0)
      if (read.bytesRead > 1024) return undefined
      text = buffer.subarray(0, read.bytesRead).toString('utf8')
    } finally {
      await file.close()
    }
    const value: unknown = JSON.parse(text)
    if (
      value === null ||
      typeof value !== 'object' ||
      !('code' in value) ||
      typeof value.code !== 'number' ||
      !('at' in value) ||
      typeof value.at !== 'string' ||
      !Number.isFinite(Date.parse(value.at))
    )
      return undefined
    return permanentServiceReason(value.code)
  } catch (error) {
    if (missing(error) || error instanceof SyntaxError) return undefined
    throw error
  }
}
export interface LaunchdRunPorts {
  uid: number | undefined
  stderrIdentity?: () => { dev: number; ino: number }
  log?: RuntimeLog
}
function errorCode(error: unknown): string {
  const code = error instanceof Error ? errnoCode(error) : undefined
  return code !== undefined && /^[A-Z0-9_]{1,40}$/.test(code) ? code : 'UNKNOWN'
}
/** Called only with the run lock held. No async work can interleave with fd 2 compaction. */
export function prepareLaunchdRun(
  env: NodeJS.ProcessEnv,
  home: string,
  ports: LaunchdRunPorts,
): void {
  try {
    unlinkSync(serviceExitPath(env, home))
  } catch (error) {
    if (!missing(error)) ports.log?.('service', 'exit_record_unclear', { reason: errorCode(error) })
  }
  let file: number | undefined
  const skipped = (reason: string) => ports.log?.('service', 'err_log_skipped', { reason })
  try {
    file = openSync(
      join(hostLogDirectory(env, home), 'launchd.err.log'),
      constants.O_RDWR | constants.O_NOFOLLOW,
    )
    const stat = fstatSync(file)
    if (!stat.isFile() || stat.uid !== ports.uid) {
      skipped('not_owned_regular_file')
      return
    }
    const stderr = (ports.stderrIdentity ?? (() => fstatSync(2)))()
    if (stderr.dev !== stat.dev || stderr.ino !== stat.ino) {
      skipped('stderr_mismatch')
      return
    }
    if (stat.size <= 1024 * 1024) return
    const buffer = Buffer.alloc(256 * 1024)
    let read = 0
    while (read < buffer.length) {
      const count = readSync(
        file,
        buffer,
        read,
        buffer.length - read,
        stat.size - buffer.length + read,
      )
      if (count === 0) {
        skipped('short_read')
        return
      }
      read += count
    }
    let written = 0
    while (written < buffer.length) {
      const count = writeSync(file, buffer, written, buffer.length - written, written)
      if (count === 0) {
        skipped('short_write')
        return
      }
      written += count
    }
    ftruncateSync(file, buffer.length)
  } catch (error) {
    if (!missing(error)) skipped(errorCode(error))
  } finally {
    if (file !== undefined) {
      try {
        closeSync(file)
      } catch (error) {
        skipped(errorCode(error))
      }
    }
  }
}
export async function launchdExit(
  code: number,
  env: NodeJS.ProcessEnv,
  home: string,
  at: number,
): Promise<number> {
  if (!permanentServiceReason(code)) return code
  const path = serviceExitPath(env, home)
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temp = `${path}.${randomUUID()}.tmp`
  try {
    const file = await open(temp, 'wx', 0o600)
    try {
      await file.writeFile(JSON.stringify({ code, at: new Date(at).toISOString() }))
      await file.sync()
    } finally {
      await file.close()
    }
    await rename(temp, path)
  } finally {
    await unlink(temp).catch((error) => {
      if (!missing(error)) throw error
    })
  }
  return 0
}
