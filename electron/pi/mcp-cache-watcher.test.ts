import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mcpCacheFingerprint, unwatchMcpCache, watchMcpCache } from './mcp-cache-watcher'

const cache = (tools: string[], cachedAt: number): string =>
  JSON.stringify({
    version: 1,
    servers: { linear: { configHash: 'h', tools: tools.map((name) => ({ name })), cachedAt } },
  })

describe('mcpCacheFingerprint', () => {
  it('ignores a rewrite that only moves cachedAt', () => {
    // A lazy server re-caches on every call and each session flushes on exit;
    // announcing those would refresh command lists all turn long.
    expect(mcpCacheFingerprint(cache(['a'], 1))).toBe(mcpCacheFingerprint(cache(['a'], 2)))
  })

  it('sees a change in what a server offers', () => {
    expect(mcpCacheFingerprint(cache(['a'], 1))).not.toBe(mcpCacheFingerprint(cache(['a', 'b'], 1)))
  })

  it('treats a missing or half-written file as no content', () => {
    expect(mcpCacheFingerprint(null)).toBeNull()
    expect(mcpCacheFingerprint('{"version":1,"serv')).toBeNull()
  })
})

describe('watchMcpCache', () => {
  let dir: string
  let fired = 0

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'phosphor-mcp-cache-'))
    fired = 0
  })

  afterEach(async () => {
    await unwatchMcpCache()
    await rm(dir, { recursive: true, force: true })
  })

  /** The adapter's own write: a temp file renamed over the cache. */
  const adapterWrite = async (text: string): Promise<void> => {
    const tmp = join(dir, `mcp-cache.json.${process.pid}.tmp`)
    await writeFile(tmp, text)
    await rename(tmp, join(dir, 'mcp-cache.json'))
  }

  /** Long enough for write-finish and the debounce to have run. */
  const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 1200))

  it('fires once the content changes, and not for a cachedAt-only rewrite', async () => {
    await writeFile(join(dir, 'mcp-cache.json'), cache(['a'], 1))
    watchMcpCache(() => fired++, dir)
    await settle()

    await adapterWrite(cache(['a'], 2))
    await settle()
    expect(fired).toBe(0)

    await adapterWrite(cache(['a', 'b'], 3))
    await vi.waitFor(() => expect(fired).toBe(1), { timeout: 5_000 })
  }, 10_000)

  it('ignores the rest of the agent dir', async () => {
    watchMcpCache(() => fired++, dir)
    await settle()
    await writeFile(join(dir, 'settings.json'), '{}')
    await settle()
    expect(fired).toBe(0)
  }, 10_000)
})
