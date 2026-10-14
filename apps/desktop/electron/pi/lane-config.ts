import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { mcpConfigPaths, mcpDirs, type McpDirs } from './mcp-config'

/** A file a lane's extensions read at startup, and the part of it that matters. */
export interface LaneConfigFile {
  path: string
  /** Narrow the parsed JSON to what decides the lane's extensions; whole file when absent. */
  pick?: (value: unknown) => unknown
}

/** The settings that decide which extensions load, and nothing pi rewrites on its own. */
function extensionSettings(value: unknown): unknown {
  if (!value || typeof value !== 'object') return value
  const { packages, extensions } = value as Record<string, unknown>
  return { packages, extensions }
}

/**
 * What pi reads for a lane in `cwd` that only a reload brings in: the global
 * and project `mcp.json`, and the `packages` / `extensions` of both
 * `settings.json` files. The settings matter for MCP too: moving off
 * pi-mcp-adapter removes its package and turns pi's built-in MCP back on
 * there. Servers an extension registers itself are not config, and a trust
 * decision made later reaches new lanes only.
 */
export function laneConfigFiles(cwd: string, dirs: McpDirs = mcpDirs()): LaneConfigFile[] {
  return [
    ...mcpConfigPaths(cwd, dirs).map(({ path }) => ({ path })),
    { path: join(dirs.piAgent, 'settings.json'), pick: extensionSettings },
    { path: join(cwd, '.pi', 'settings.json'), pick: extensionSettings },
  ]
}

/** JSON with object keys sorted, so a reformatted or re-saved file hashes the same. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    )
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

function digest(text: string): string {
  return createHash('sha256').update(text).digest('hex')
}

/**
 * A lane's config fingerprint, for `createLaneReload`. It runs before every
 * prompt, so a file is only read again when its stat changed; an unchanged
 * set of files costs a handful of `stat` calls.
 */
export function createLaneConfigFingerprint(dirs?: () => McpDirs) {
  const cache = new Map<string, { signature: string; digest: string }>()

  async function fileDigest({ path, pick }: LaneConfigFile): Promise<string> {
    let signature: string
    try {
      const s = await stat(path)
      signature = `${s.ino}:${s.size}:${s.mtimeMs}:${s.ctimeMs}`
    } catch {
      cache.delete(path)
      return 'absent'
    }
    const cached = cache.get(path)
    if (cached?.signature === signature) return cached.digest
    let text: string
    try {
      text = await readFile(path, 'utf8')
    } catch {
      return 'unreadable'
    }
    let value: string
    try {
      const parsed: unknown = JSON.parse(text)
      value = canonical(pick ? pick(parsed) : parsed)
    } catch {
      // pi will fail on it too; any edit to it is still a change.
      value = text
    }
    const result = digest(value)
    cache.set(path, { signature, digest: result })
    return result
  }

  return async function fingerprint(cwd: string): Promise<string> {
    const files = laneConfigFiles(cwd, dirs?.())
    const parts = await Promise.all(
      files.map(async (file) => `${file.path}=${await fileDigest(file)}`),
    )
    return digest(parts.join('\n'))
  }
}
