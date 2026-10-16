import { execFile } from 'node:child_process'
import { constants } from 'node:fs'
import { access, stat } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { tailscaleExecutableCandidates } from '@phosphor/shared/tailscale-executable'
import { getLoginShellPath } from '../pi/shell-env'
import type { TailscaleStatus } from '@shared/tailscale-status'

export const TAILSCALE_OPTIONS = {
  timeout: 5_000,
  killSignal: 'SIGKILL' as const,
  maxBuffer: 1_048_576,
  encoding: 'utf8' as const,
  windowsHide: true,
}
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
const dnsName = (value: unknown): value is string =>
  typeof value === 'string' &&
  value.length <= 254 &&
  /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+ts\.net\.?$/i.test(value)

/** Tailscale's extensible JSON is untrusted. Only these fields leave main. */
export function parseTailscaleStatus(output: string): TailscaleStatus {
  const result = (code: TailscaleStatus['code']): TailscaleStatus => ({ code })
  if (Buffer.byteLength(output) > TAILSCALE_OPTIONS.maxBuffer) return result('check-failed')
  let value: unknown
  try {
    value = JSON.parse(output)
  } catch {
    return result('check-failed')
  }
  if (!record(value) || typeof value.BackendState !== 'string') return result('check-failed')
  if (value.BackendState === 'NeedsLogin' || value.BackendState === 'NeedsMachineAuth')
    return result('signed-out')
  if (value.BackendState !== 'Running') return result('not-running')
  if (!record(value.CurrentTailnet) || value.CurrentTailnet.MagicDNSEnabled !== true)
    return result('magicdns-unavailable')
  if (!Array.isArray(value.CertDomains) || !value.CertDomains.some(dnsName))
    return result('https-unavailable')
  return result('ready')
}

export type TailscaleRunner = (
  done: (error: { code?: string | number } | null, output: string) => void,
) => void | (() => void)
/** Resolve only executable regular files from main's environment and native install locations. */
export async function resolveTailscaleExecutable(
  platform = process.platform,
  inheritedPath = process.env.PATH ?? '',
  loginPath: () => Promise<string | null> = getLoginShellPath,
): Promise<string | null> {
  const shellPath = await loginPath()
  const name = platform === 'win32' ? 'tailscale.exe' : 'tailscale'
  const candidates = [
    ...[inheritedPath, shellPath ?? '']
      .flatMap((value) => value.split(platform === 'win32' ? ';' : ':'))
      .filter((dir) => isAbsolute(dir))
      .map((dir) => join(dir, name)),
    ...tailscaleExecutableCandidates(platform),
  ]
  for (const candidate of new Set(candidates)) {
    if (!isAbsolute(candidate)) continue
    try {
      if (!(await stat(candidate)).isFile()) continue
      await access(candidate, constants.X_OK)
      return candidate
    } catch {
      // Missing, inaccessible or not executable: try the next local candidate.
    }
  }
  return null
}
const run: TailscaleRunner = (done) => {
  let cancelled = false
  let child: ReturnType<typeof execFile> | undefined
  void resolveTailscaleExecutable().then(
    (executable) => {
      if (cancelled) return
      if (!executable) return done({ code: 'ENOENT' }, '')
      child = execFile(executable, ['status', '--json'], TAILSCALE_OPTIONS, (error, stdout) =>
        // A resolved file that cannot start is a failed check, not a missing installation.
        done(error?.code === 'ENOENT' ? { code: 'EXEC_FAILED' } : error, stdout),
      )
    },
    () => done({ code: 'RESOLUTION_FAILED' }, ''),
  )
  return () => {
    cancelled = true
    child?.kill('SIGKILL')
  }
}
export function readTailscaleStatus(runner: TailscaleRunner = run): Promise<TailscaleStatus> {
  return new Promise((resolve) => {
    const failure = (code: TailscaleStatus['code'] = 'check-failed'): TailscaleStatus => ({
      code,
    })
    // execFile waits for stdio to close. Bound IPC even if a descendant holds a pipe open.
    const deadline = setTimeout(() => {
      resolve(failure())
      cancel?.()
    }, TAILSCALE_OPTIONS.timeout)
    const cancel = runner((error, output) => {
      clearTimeout(deadline)
      resolve(
        error
          ? failure(error.code === 'ENOENT' ? 'not-installed' : 'check-failed')
          : parseTailscaleStatus(output),
      )
    })
  })
}
