import { isSkillFile, machineRecord } from './host-protocol-machine'

/**
 * Skill sharing copies one skill bundle from one machine to another machine's global skills
 * folder. A bundle travels whole, as base64, inside one call: the limits keep a Host install
 * inside the 8 MiB inbound frame and an export inside the 16 MiB outbound frame.
 */
export const SKILL_SHARE_LIMITS = {
  files: 200,
  fileBytes: 2 * 1024 * 1024,
  totalBytes: 4 * 1024 * 1024,
} as const

export interface SkillBundleFile {
  /** Relative to the bundle folder, `/`-separated. */
  path: string
  /** File bytes, base64. */
  data: string
}
export interface SkillBundle {
  name: string
  files: SkillBundleFile[]
}
/** `conflict.replaceable` is false when the same name comes from outside the skills folder. */
export type SkillInstallResult =
  { status: 'installed'; replaced: boolean } | { status: 'conflict'; replaceable: boolean }

/** Provenance sidecars belong to the machine that installed the skill; they never travel. */
const SIDECARS = new Set(['.phosphor-skill.json', '.pidex-skill.json'])

export function isShareableSkillName(v: unknown): v is string {
  return typeof v === 'string' && v.length <= 64 && /^[a-z0-9]+(-[a-z0-9]+)*$/.test(v)
}

/** Decoded size of canonical base64, or null when the text is not canonical base64. */
export function base64Bytes(data: string): number | null {
  if (data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) return null
  const padding = data.endsWith('==') ? 2 : data.endsWith('=') ? 1 : 0
  return (data.length / 4) * 3 - padding
}

/** A bundle path: no escapes, no dot folders, no sidecar. */
export function isShareablePath(path: unknown): path is string {
  if (!isSkillFile(path)) return false
  const parts = path.split('/')
  const file = parts[parts.length - 1] ?? ''
  return !SIDECARS.has(file) && parts.slice(0, -1).every((part) => !part.startsWith('.'))
}

export function bundleBytes(bundle: SkillBundle): number {
  return bundle.files.reduce((total, file) => total + (base64Bytes(file.data) ?? 0), 0)
}

/** Validate a whole bundle. One bad file rejects it; nothing is dropped or truncated. */
export function parseSkillBundle(v: unknown): SkillBundle | null {
  if (!machineRecord(v) || Object.keys(v).some((key) => key !== 'name' && key !== 'files'))
    return null
  const { name, files } = v
  if (!isShareableSkillName(name) || !Array.isArray(files)) return null
  if (files.length === 0 || files.length > SKILL_SHARE_LIMITS.files) return null
  const paths = new Set<string>()
  const out: SkillBundleFile[] = []
  let total = 0
  for (const file of files) {
    if (!machineRecord(file) || Object.keys(file).length !== 2) return null
    const { path, data } = file
    if (!isShareablePath(path) || typeof data !== 'string' || paths.has(path)) return null
    const bytes = base64Bytes(data)
    if (bytes === null || bytes > SKILL_SHARE_LIMITS.fileBytes) return null
    total += bytes
    if (total > SKILL_SHARE_LIMITS.totalBytes) return null
    paths.add(path)
    out.push({ path, data })
  }
  // A file cannot also be a folder of another entry.
  for (const path of paths) {
    const parts = path.split('/')
    for (let i = 1; i < parts.length; i++) if (paths.has(parts.slice(0, i).join('/'))) return null
  }
  if (!paths.has('SKILL.md')) return null
  return { name, files: out }
}

export function parseSkillInstallParams(
  v: unknown,
): { bundle: SkillBundle; overwrite: boolean } | null {
  if (!machineRecord(v) || Object.keys(v).some((key) => key !== 'bundle' && key !== 'overwrite'))
    return null
  if (v.overwrite !== undefined && typeof v.overwrite !== 'boolean') return null
  const bundle = parseSkillBundle(v.bundle)
  return bundle ? { bundle, overwrite: v.overwrite === true } : null
}

export function parseSkillInstallResult(v: unknown): SkillInstallResult | null {
  if (!machineRecord(v) || Object.keys(v).length !== 2) return null
  if (v.status === 'installed' && typeof v.replaced === 'boolean')
    return { status: 'installed', replaced: v.replaced }
  if (v.status === 'conflict' && typeof v.replaceable === 'boolean')
    return { status: 'conflict', replaceable: v.replaceable }
  return null
}
