import { machineRecord } from './host-protocol-machine'
import { isMcpExposure, type McpServerConfig } from './mcp'
import { text, keys, boundedString } from './machine-settings-fields'

function privateHttpUrl(v: unknown): boolean {
  if (!text(v, 8192)) return false
  try {
    const url = new URL(v)
    return (
      !url.username &&
      !url.password &&
      (url.protocol === 'https:' ||
        (url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))
    )
  } catch {
    return false
  }
}
/** Reviewed settings only. No opaque options that might introduce another code path. */
export function validMcpConfig(v: unknown): v is McpServerConfig {
  if (
    !machineRecord(v) ||
    !keys(v, [
      'type',
      'url',
      'headers',
      'oauth',
      'auth',
      'command',
      'args',
      'env',
      'cwd',
      'exposure',
      'toolExposure',
      'enabled',
      'description',
      'timeout',
    ])
  )
    return false
  const stdio = typeof v.command === 'string'
  if (
    stdio
      ? !text(v.command, 4096) ||
        /[\r\n]/.test(v.command) ||
        v.url !== undefined ||
        (v.type !== undefined && v.type !== 'stdio')
      : !privateHttpUrl(v.url) ||
        (v.type !== undefined && !['http', 'streamable-http'].includes(String(v.type)))
  )
    return false
  if (
    v.args !== undefined &&
    (!stdio ||
      !Array.isArray(v.args) ||
      v.args.length > 64 ||
      !v.args.every((arg) => boundedString(arg)))
  )
    return false
  if (v.cwd !== undefined && (!stdio || !text(v.cwd, 4096) || !v.cwd.startsWith('/'))) return false
  if (!validVariables(v, stdio) || !validOAuth(v, stdio)) return false
  if (
    v.auth !== undefined &&
    (stdio || !machineRecord(v.auth) || !keys(v.auth, ['provider']) || !text(v.auth.provider, 100))
  )
    return false
  if (v.exposure !== undefined && !isMcpExposure(v.exposure)) return false
  if (
    v.toolExposure !== undefined &&
    (!machineRecord(v.toolExposure) ||
      Object.keys(v.toolExposure).length > 128 ||
      !Object.entries(v.toolExposure).every(
        ([name, exposure]) => text(name, 200) && isMcpExposure(exposure),
      ))
  )
    return false
  if (
    (v.enabled !== undefined && typeof v.enabled !== 'boolean') ||
    (v.description !== undefined && !boundedString(v.description, 2000)) ||
    (v.timeout !== undefined &&
      (typeof v.timeout !== 'number' ||
        !Number.isFinite(v.timeout) ||
        v.timeout <= 0 ||
        v.timeout > 300))
  )
    return false
  return JSON.stringify(v).length <= 32_000
}

function validVariables(v: Record<string, unknown>, stdio: boolean): boolean {
  for (const key of ['headers', 'env'] as const) {
    const record = v[key]
    if (record === undefined) continue
    if (
      (key === 'env' && !stdio) ||
      !machineRecord(record) ||
      Object.keys(record).length > 64 ||
      !Object.entries(record).every(
        ([name, value]) =>
          (key === 'env'
            ? /^[A-Za-z_][A-Za-z0-9_]*$/.test(name)
            : /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name)) &&
          boundedString(value) &&
          (key !== 'headers' || !/[\r\n]/.test(value)),
      )
    )
      return false
  }
  return true
}

function validOAuth(v: Record<string, unknown>, stdio: boolean): boolean {
  if (v.oauth !== undefined) {
    const oauth = v.oauth
    if (
      stdio ||
      !machineRecord(oauth) ||
      !keys(oauth, [
        'clientId',
        'clientSecret',
        'callbackPort',
        'callbackUrl',
        'scope',
        'clientName',
        'clientRegistration',
        'authServerMetadataUrl',
      ]) ||
      !Object.entries(oauth).every(([name, value]) =>
        name === 'callbackPort'
          ? Number.isInteger(value) && Number(value) > 0 && Number(value) < 65536
          : name === 'callbackUrl' || name === 'authServerMetadataUrl'
            ? privateHttpUrl(value)
            : name === 'clientRegistration'
              ? value === 'dcr' || value === 'cimd'
              : boundedString(value),
      )
    )
      return false
  }
  return true
}
