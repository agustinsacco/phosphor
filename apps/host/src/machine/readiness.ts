import { realpath, stat } from 'node:fs/promises'
import { basename, dirname } from 'node:path'
import type { Readiness } from '@phosphor/shared/control-api'
import { MIN_PI_VERSION } from '@phosphor/shared/models'
import { compareVersions, extractVersion } from '@phosphor/session-runtime/pi/versions'
import type { HostConfigV1 } from '../config/schema'
import { parseLoggedIn } from './claude'
import { buildPiEnvironment } from './environment'
import { isNodeScript, which } from './executables'
import { probe, type ProbeResult } from './probe'

const clean = (run: ProbeResult) => !run.timedOut && !run.truncated && !run.error && !run.signal
export function piReadiness(run: ProbeResult | null): Readiness['pi'] {
  if (!run) return 'missing'
  if (!clean(run) || run.code !== 0) return 'unknown'
  const version = extractVersion(`${run.stdout}\n${run.stderr}`)
  return version ? (compareVersions(version, MIN_PI_VERSION) < 0 ? 'outdated' : 'ok') : 'unknown'
}
export function claudeReadiness(run: ProbeResult | null): Readiness['claude'] {
  if (!run) return 'missing'
  if (!clean(run) || (run.code !== 0 && run.code !== 1)) return 'unknown'
  const loggedIn = parseLoggedIn(run.stdout)
  return loggedIn === null ? 'unknown' : loggedIn ? 'ok' : 'signed-out'
}
export function tailscaleReadiness(run: ProbeResult | null): Readiness['tailscale'] {
  if (!run) return 'missing'
  if (!clean(run) || run.code !== 0) return 'unknown'
  try {
    const value: unknown = JSON.parse(run.stdout)
    if (
      value === null ||
      typeof value !== 'object' ||
      !('BackendState' in value) ||
      typeof value.BackendState !== 'string'
    )
      return 'unknown'
    if (value.BackendState !== 'Running') return 'stopped'
    if (!('CertDomains' in value) || value.CertDomains === null) return 'no-https'
    if (
      !Array.isArray(value.CertDomains) ||
      !value.CertDomains.every((item: unknown) => typeof item === 'string')
    )
      return 'unknown'
    return value.CertDomains.length === 0 ? 'no-https' : 'ok'
  } catch {
    return 'unknown'
  }
}

export const readinessPorts = {
  probe,
  which,
  isNodeScript,
  isFile: async (path: string) => (await stat(path).catch(() => null))?.isFile() ?? false,
  resolve: async (path: string) => realpath(path).catch(() => null),
}
export async function checkReadiness(
  config: HostConfigV1,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  ports = readinessPorts,
): Promise<Readiness> {
  const environment = buildPiEnvironment({
    hostEnv: env,
    platform,
    nodePath: config.pi.node,
    path: config.environment?.path,
    pass: config.environment?.pass,
  })
  const options = { ...environment, timeoutMs: 2000 }
  // Like doctor: classify the resolved file, not a symlink's name. A Node script
  // runs through the pinned node and needs no execute bit; only a file run
  // directly must be executable.
  const exe = await ports.resolve(config.pi.executable)
  let pi: Readiness['pi'] = 'missing'
  if (exe !== null && (await ports.isFile(exe))) {
    if (await ports.isNodeScript(exe))
      pi = config.pi.node
        ? piReadiness(await ports.probe(config.pi.node, [exe, '--version'], options))
        : 'unknown'
    else if (await ports.which(basename(exe), dirname(exe)))
      pi = piReadiness(await ports.probe(exe, ['--version'], options))
  }
  const claude = await ports.which('claude', environment.env.PATH ?? '')
  const tailscale = await ports.which('tailscale', env.PATH ?? '')
  return {
    pi,
    claude: claudeReadiness(claude ? await ports.probe(claude, ['auth', 'status'], options) : null),
    tailscale: tailscaleReadiness(
      tailscale ? await ports.probe(tailscale, ['status', '--json'], options) : null,
    ),
  }
}
