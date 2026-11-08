import { machineRecord } from './host-protocol-machine'
import { isMachinePackageSpec, type MachineSettings } from './machine-settings'
import { WEB_ACCESS_KEYS } from './web-access'
export const text = (v: unknown, max = 512): v is string =>
  typeof v === 'string' && v.length <= max && !v.includes('\0')
export const list = (v: unknown, limit: number): v is unknown[] =>
  Array.isArray(v) && v.length <= limit
export const number = (v: unknown): v is number =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0
export const optional = (v: unknown): v is string | undefined => v === undefined || text(v)
function parsePackageContents(
  value: unknown,
):
  | NonNullable<NonNullable<MachineSettings['resources']>['packages'][number]['contents']>
  | undefined {
  if (
    !machineRecord(value) ||
    !['extensions', 'skills', 'prompts', 'themes'].every(
      (key) => number(value[key]) && Number.isSafeInteger(value[key]) && value[key] <= 100_000,
    )
  )
    return undefined
  return {
    extensions: value.extensions as number,
    skills: value.skills as number,
    prompts: value.prompts as number,
    themes: value.themes as number,
  }
}
export function parseResources(
  value: Record<string, unknown>,
  base: MachineSettings,
): MachineSettings | null {
  const r = value.resources
  if (!machineRecord(r) || !list(r.packages, 256)) return null
  const packages: NonNullable<MachineSettings['resources']>['packages'] = []
  for (const p of r.packages) {
    if (
      !machineRecord(p) ||
      !text(p.spec, 512) ||
      !text(p.name) ||
      !optional(p.version) ||
      typeof p.installed !== 'boolean' ||
      !text(p.scope, 32)
    )
      return null
    packages.push({
      spec: isMachinePackageSpec(p.spec) ? p.spec : 'Source managed on Host',
      name: p.name,
      ...(p.version ? { version: p.version } : {}),
      installed: p.installed,
      scope: p.scope,
      ...(typeof p.filtered === 'boolean' ? { filtered: p.filtered } : {}),
      ...(parsePackageContents(p.contents) ? { contents: parsePackageContents(p.contents)! } : {}),
    })
  }
  const webAccess = parseWebAccess(r.webAccess)
  return { ...base, resources: { packages, ...(webAccess ? { webAccess } : {}) } }
}
/** Names only: anything that is not an allowlisted key name is dropped, as is a bad shape. */
function parseWebAccess(
  value: unknown,
): NonNullable<MachineSettings['resources']>['webAccess'] | undefined {
  if (
    !machineRecord(value) ||
    typeof value.exists !== 'boolean' ||
    typeof value.malformed !== 'boolean' ||
    !list(value.configured, 64)
  )
    return undefined
  const configured = WEB_ACCESS_KEYS.filter((key) => (value.configured as unknown[]).includes(key))
  return { configured, exists: value.exists, malformed: value.malformed }
}
export function parseAdvanced(
  value: Record<string, unknown>,
  base: MachineSettings,
): MachineSettings | null {
  const a = value.advanced
  if (
    !machineRecord(a) ||
    !text(a.platform, 32) ||
    !text(a.hostVersion, 64) ||
    !text(a.configPath, 4096) ||
    !text(a.piAgentDir, 4096) ||
    !list(a.path, 128) ||
    !a.path.every((p) => text(p, 4096)) ||
    !list(a.environment, 64)
  )
    return null
  const environment: NonNullable<MachineSettings['advanced']>['environment'] = []
  for (const e of a.environment) {
    if (
      !machineRecord(e) ||
      !text(e.name, 128) ||
      typeof e.available !== 'boolean' ||
      typeof e.passed !== 'boolean'
    )
      return null
    environment.push({ name: e.name, available: e.available, passed: e.passed })
  }
  return {
    ...base,
    advanced: {
      platform: a.platform,
      hostVersion: a.hostVersion,
      configPath: a.configPath,
      piAgentDir: a.piAgentDir,
      path: a.path as string[],
      environment,
      ...(parseAdvancedPi(a.pi) ? { pi: parseAdvancedPi(a.pi)! } : {}),
    },
  }
}
function parseAdvancedPi(
  value: unknown,
): NonNullable<MachineSettings['advanced']>['pi'] | undefined {
  if (
    !machineRecord(value) ||
    !text(value.path, 4096) ||
    !text(value.agentDir, 4096) ||
    !(value.version === undefined || text(value.version, 64))
  )
    return undefined
  return {
    ...(value.version ? { version: value.version } : {}),
    path: value.path,
    agentDir: value.agentDir,
  }
}
