import { isEndpoint, type Readiness } from '@phosphor/shared/control-api'
import { HOST_API_PORT } from '@phosphor/shared/host-protocol'
import { fail, pass, warn, EXIT, type Check } from '../checks'
import type { HostConfigV1 } from '../config/schema'
import { buildPiEnvironment } from './environment'
import { which } from './executables'
import { probe, PROBE_OUTPUT_CAP, type ProbeResult } from './probe'
const clean = (run: ProbeResult) => !run.timedOut && !run.truncated && !run.error && !run.signal
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

export type ServeRoute = 'absent' | 'ours' | 'funnel' | 'other' | 'unknown'
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)
function json(text: unknown): Record<string, unknown> | null {
  if (typeof text !== 'string' || Buffer.byteLength(text) > PROBE_OUTPUT_CAP) return null
  try {
    const value: unknown = JSON.parse(text)
    return record(value) ? value : null
  } catch {
    return null
  }
}
export function selfName(statusJson: unknown): string | null {
  const status = json(statusJson)
  if (!status || status.BackendState !== 'Running' || !record(status.Self)) return null
  const raw = status.Self.DNSName
  if (typeof raw !== 'string') return null
  const name = raw.replace(/\.$/, '')
  return /^[a-z0-9-]{1,63}(\.[a-z0-9-]{1,63})*\.ts\.net$/.exec(name)?.[0] === name &&
    Array.isArray(status.CertDomains) &&
    status.CertDomains.includes(name)
    ? name
    : null
}
export function serveRoute(
  serveJson: unknown,
  httpsPort: number,
  name: string,
  apiPort: number,
): ServeRoute {
  const config = json(serveJson)
  if (!config) return 'unknown'
  const key = `${name}:${httpsPort}`
  const port = String(httpsPort)
  const { TCP = {}, Web = {}, AllowFunnel = {} } = config
  if (!record(AllowFunnel)) return 'unknown'
  if (AllowFunnel[key] === true) return 'funnel'
  if (!record(TCP) || !record(Web)) return 'unknown'
  const webKeys = Object.keys(Web).filter((entry) => entry.endsWith(`:${port}`))
  const funnelKeys = Object.keys(AllowFunnel).filter((entry) => entry.endsWith(`:${port}`))
  if (!(port in TCP) && webKeys.length === 0 && funnelKeys.length === 0) return 'absent'
  const tcp = TCP[port]
  const web = Web[key]
  if (
    !record(tcp) ||
    tcp.HTTPS !== true ||
    Object.keys(tcp).length !== 1 ||
    webKeys.length !== 1 ||
    !record(web) ||
    Object.keys(web).length !== 1 ||
    !record(web.Handlers) ||
    Object.keys(web.Handlers).length !== 1 ||
    !record(web.Handlers['/']) ||
    Object.keys(web.Handlers['/']).length !== 1 ||
    web.Handlers['/'].Proxy !== `http://127.0.0.1:${apiPort}` ||
    (funnelKeys.length > 0 && !(funnelKeys.length === 1 && AllowFunnel[key] === false))
  )
    return 'other'
  return 'ours'
}

export interface TailscaleInspection {
  name: string | null
  readiness: Readiness['tailscale']
  state: ServeRoute
  endpoint: string | null
  executable: string | null
  port: number
}
export const tailscalePorts = { probe, which }
export function tailscaleOptions(
  config: HostConfigV1,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
) {
  return {
    ...buildPiEnvironment({
      hostEnv: env,
      platform,
      nodePath: config.pi.node,
      path: config.environment?.path,
      pass: config.environment?.pass,
    }),
    timeoutMs: 2000,
  }
}
export const successfulProbe = (run: ProbeResult) =>
  run.code === 0 && !run.timedOut && !run.truncated && !run.error && !run.signal
export async function inspectTailscale(
  config: HostConfigV1,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  ports = tailscalePorts,
): Promise<TailscaleInspection> {
  const port = config.api?.port ?? HOST_API_PORT
  const executable = await ports.which('tailscale', env.PATH ?? '')
  const options = tailscaleOptions(config, env, platform)
  const status = executable ? await ports.probe(executable, ['status', '--json'], options) : null
  const readiness = tailscaleReadiness(status)
  const name = status && successfulProbe(status) ? selfName(status.stdout) : null
  let state: ServeRoute = 'unknown'
  if (executable && status && successfulProbe(status) && readiness !== 'stopped') {
    const serve = await ports.probe(executable, ['serve', 'status', '--json'], options)
    if (successfulProbe(serve)) state = serveRoute(serve.stdout, port, name ?? '', port)
  }
  return { name, readiness, state, endpoint: serveEndpoint(name, state, port), executable, port }
}
export function serveEndpoint(name: string | null, state: ServeRoute, port: number): string | null {
  if (!name || state !== 'ours' || !name.endsWith('.ts.net')) return null
  const candidate = `https://${name}:${port}`
  return isEndpoint(candidate) ? candidate : null
}

export function tailscaleMessage(readiness: Readiness['tailscale']): string {
  switch (readiness) {
    case 'ok':
      return 'Tailscale is running with HTTPS available.'
    case 'missing':
      return 'Tailscale is missing: install Tailscale first.'
    case 'stopped':
      return 'Tailscale is stopped: start it and sign in first.'
    case 'no-https':
      return 'Tailscale HTTPS is not available: enable HTTPS on your tailnet.'
    case 'unknown':
      return 'Tailscale status could not be verified.'
  }
}
export function routeMessage(state: ServeRoute, port: number): string {
  if (state === 'funnel' || state === 'other')
    return (
      `Port ${port}: the Host will not replace a route it did not make.` +
      (state === 'funnel'
        ? ' Turn off Funnel because it would publish the Host to the internet.'
        : '')
    )
  if (state === 'absent') return 'Run phosphor tailscale enable.'
  if (state === 'unknown')
    return 'Tailscale serve status could not be verified; check tailscale status.'
  return 'Tailscale serve is ready.'
}
export function tailscaleChecks(found: TailscaleInspection): Check[] {
  const checks = [
    found.readiness === 'ok'
      ? pass('Tailscale', tailscaleMessage(found.readiness))
      : warn('Tailscale', tailscaleMessage(found.readiness)),
  ]
  if (found.readiness === 'missing' || found.readiness === 'stopped') return checks
  const message = routeMessage(found.state, found.port)
  checks.push(
    found.state === 'ours'
      ? pass('Tailscale serve', message)
      : found.state === 'other' || found.state === 'funnel'
        ? fail('Tailscale serve', message, EXIT.config)
        : warn('Tailscale serve', message),
  )
  return checks
}
export function setupTailscaleHint(found: TailscaleInspection): string[] {
  return found.readiness === 'ok' && found.name !== null && found.state === 'absent'
    ? [`Port ${found.port}: Run phosphor tailscale enable.`]
    : []
}
