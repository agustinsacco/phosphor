import { createHash } from 'node:crypto'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { McpResolvedServer } from '@phosphor/shared/mcp'
import {
  parseMcpInspection,
  type McpCheckSnapshot,
  type McpInspection,
} from '@phosphor/shared/mcp-inspection'

const MAX_BYTES = 4 * 1024 * 1024
const MAX_ENTRIES = 64

/** Fingerprints include scope and config, never a resolved secret. Only the digest is stored. */
export function inspectionKey(workspace: string, server: McpResolvedServer): string {
  return createHash('sha256')
    .update(JSON.stringify([workspace, server.name, server.scope, server.config]))
    .digest('hex')
}

function snapshot(value: unknown): McpCheckSnapshot | null {
  if (!value || typeof value !== 'object') return null
  const s = value as McpCheckSnapshot
  if (!Number.isFinite(s.checkedAt) || typeof s.report?.name !== 'string') return null
  const report = parseMcpInspection({ version: 1, server: s.report }, s.report.name)
  const previous = parseMcpInspection(
    { version: 1, server: { ...s.report, tools: s.tools } },
    s.report.name,
  )
  if (!report || !previous) return null
  return {
    checkedAt: s.checkedAt,
    report,
    tools: previous.tools,
    ...(Number.isFinite(s.discoveredAt) ? { discoveredAt: s.discoveredAt } : {}),
  }
}

/** Private, bounded display cache. A damaged/old cache is disposable, never a configuration error. */
export class McpInspectionCache {
  private entries = new Map<string, McpCheckSnapshot>()
  private loading: Promise<void> | undefined
  private writing = Promise.resolve()
  constructor(private readonly path: string) {}

  private load(): Promise<void> {
    this.loading ??= (async () => {
      try {
        if ((await stat(this.path)).size > MAX_BYTES) return
        const data: unknown = JSON.parse(await readFile(this.path, 'utf8'))
        if (!Array.isArray(data)) return
        for (const entry of data.slice(-MAX_ENTRIES)) {
          if (!Array.isArray(entry) || !/^[a-f0-9]{64}$/.test(String(entry[0]))) continue
          const parsed = snapshot(entry[1])
          if (parsed) this.entries.set(String(entry[0]), parsed)
        }
      } catch {
        /* Missing, malformed or unreadable cache: rediscover. */
      }
    })()
    return this.loading
  }

  async get(key: string): Promise<McpCheckSnapshot | undefined> {
    await this.load()
    return this.entries.get(key)
  }

  async put(key: string, report: McpInspection): Promise<McpCheckSnapshot> {
    await this.load()
    const previous = this.entries.get(key)
    const checkedAt = Date.now()
    const result: McpCheckSnapshot = {
      checkedAt,
      report,
      tools: report.state === 'connected' ? report.tools : (previous?.tools ?? []),
      ...(report.state === 'connected'
        ? { discoveredAt: checkedAt }
        : previous?.discoveredAt
          ? { discoveredAt: previous.discoveredAt }
          : {}),
    }
    this.entries.delete(key)
    this.entries.set(key, result)
    while (this.entries.size > MAX_ENTRIES) this.entries.delete(this.entries.keys().next().value!)
    // Serialize writes; interrupted writes only lose disposable metadata. Never fail a good probe.
    this.writing = this.writing
      .then(async () => {
        let data = JSON.stringify([...this.entries])
        while (data.length > MAX_BYTES / 2 && this.entries.size > 1) {
          this.entries.delete(this.entries.keys().next().value!)
          data = JSON.stringify([...this.entries])
        }
        if (Buffer.byteLength(data) > MAX_BYTES) return
        await mkdir(dirname(this.path), { recursive: true, mode: 0o700 })
        await writeFile(this.path, data, { mode: 0o600 })
      })
      .catch(() => {})
    await this.writing
    return result
  }
}
