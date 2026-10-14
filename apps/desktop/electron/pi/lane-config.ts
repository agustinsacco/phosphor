import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { mcpConfigPaths, mcpDirs, type McpDirs } from './mcp-config'

/**
 * Every MCP config file pi reads for a lane in `cwd`: the global and the
 * project `mcp.json`. Servers an extension registers itself are not config,
 * and a trust decision made later reaches new lanes only.
 */
export function laneConfigPaths(cwd: string, dirs: McpDirs = mcpDirs()): string[] {
  return mcpConfigPaths(cwd, dirs).map(({ path }) => path)
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
 * A lane's MCP config fingerprint, for `createLaneReload`. It runs before every
 * prompt, so a file is only read again when its stat changed; an unchanged
 * set of files costs a handful of `stat` calls.
 */
export function createLaneConfigFingerprint(dirs?: () => McpDirs) {
  const cache = new Map<string, { signature: string; digest: string }>()

  async function fileDigest(path: string): Promise<string> {
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
      value = canonical(JSON.parse(text))
    } catch {
      // pi will fail on it too; any edit to it is still a change.
      value = text
    }
    const result = digest(value)
    cache.set(path, { signature, digest: result })
    return result
  }

  return async function fingerprint(cwd: string): Promise<string> {
    const paths = laneConfigPaths(cwd, dirs?.())
    const parts = await Promise.all(paths.map(async (path) => `${path}=${await fileDigest(path)}`))
    return digest(parts.join('\n'))
  }
}
