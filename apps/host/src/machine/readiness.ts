import { realpath, stat } from 'node:fs/promises'
import { basename, dirname } from 'node:path'
import type { Readiness } from '@phosphor/shared/control-api'
import { listPackages } from '@phosphor/session-runtime/pi/packages'
import { claudeContextProviderShortfall } from '@phosphor/session-runtime/pi/provider-detect'
import { MIN_PI_VERSION } from '@phosphor/shared/models'
import { compareVersions, extractVersion } from '@phosphor/session-runtime/pi/versions'
import type { HostConfigV1 } from '../config/schema'
import { parseLoggedIn } from './claude'
import { buildPiEnvironment } from './environment'
import { isNodeScript, which } from './executables'
import { probe, type ProbeResult } from './probe'
import { inspectTailscale, type TailscaleInspection } from './tailscale'
export { tailscaleReadiness } from './tailscale'

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
  ports: typeof readinessPorts & {
    listPackages?: typeof listPackages
  } = readinessPorts,
  onTailscale?: (found: TailscaleInspection) => void,
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
  const providerReady =
    claudeContextProviderShortfall(await (ports.listPackages ?? listPackages)()) === null
  const claude = await ports.which('claude', environment.env.PATH ?? '')
  const tailscale = await inspectTailscale(config, env, platform, ports)
  onTailscale?.(tailscale)
  return {
    pi,
    claude: claudeReadiness(
      claude && providerReady ? await ports.probe(claude, ['auth', 'status'], options) : null,
    ),
    tailscale: tailscale.readiness,
  }
}
