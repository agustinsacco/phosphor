import chokidar, { type FSWatcher } from 'chokidar'
import { mkdirSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join, normalize } from 'node:path'
import { piAgentDir } from './pi-paths'

/**
 * Noticing when the MCP adapter rewrites its metadata cache.
 *
 * `mcp-cache.json` is what every pi without a live connection believes about a
 * server: its tools (the Connectors tab's tool list) and its prompts (the
 * `mcp__<server>__*` commands a throwaway `get_commands` pi registers for the
 * home composer's `/` menu). The adapter rewrites it on every fresh
 * connection — a Test, a Reload, a finished sign-in, a lazy connect mid-turn,
 * even a pi in a terminal — and none of those paths goes through a Phosphor
 * mutation that could invalidate what was read from it. So main watches the
 * file instead of guessing which actions touched it.
 *
 * Most rewrites change nothing but `cachedAt`: a lazily connected server
 * re-caches on every call, and each session flushes the cache on shutdown.
 * Only a change in what the cache SAYS fires, so a busy session does not turn
 * into a stream of command-list refreshes.
 */

const CACHE_FILE = 'mcp-cache.json'

/**
 * What the cache says, minus when it was said. Null for a missing or
 * unparseable file — a half-written cache is not a change worth announcing.
 */
export function mcpCacheFingerprint(text: string | null): string | null {
  if (text === null) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object') return null
  const servers = (parsed as { servers?: unknown }).servers
  if (!servers || typeof servers !== 'object') return JSON.stringify(parsed)
  const stripped: Record<string, unknown> = {}
  for (const [name, entry] of Object.entries(servers)) {
    if (entry && typeof entry === 'object') {
      const { cachedAt: _cachedAt, ...rest } = entry as Record<string, unknown>
      stripped[name] = rest
    } else {
      stripped[name] = entry
    }
  }
  return JSON.stringify({ ...(parsed as object), servers: stripped })
}

async function fingerprintOf(path: string): Promise<string | null> {
  try {
    return mcpCacheFingerprint(await readFile(path, 'utf8'))
  } catch {
    return null
  }
}

let watcher: FSWatcher | undefined
let debounce: NodeJS.Timeout | undefined

/**
 * Start watching. `onChange` runs after the content changes, debounced.
 * Idempotent; `dir` is injectable for tests.
 */
export function watchMcpCache(onChange: () => void, dir: string = piAgentDir()): void {
  if (watcher) return
  const root = normalize(dir)
  const path = normalize(join(dir, CACHE_FILE))

  // A missing watch target is a dead watcher (see session-watcher.ts), and a
  // fresh install has no agent dir until pi first runs.
  try {
    mkdirSync(dir, { recursive: true })
  } catch {
    // Unwritable agent dir: watching still beats not watching.
  }

  let last: string | null | undefined
  void fingerprintOf(path).then((initial) => {
    last ??= initial
  })

  // The directory, not the file: the adapter writes a `.tmp` and renames it
  // over the cache, which replaces the file a file watch would be holding.
  // Everything but the cache is ignored, so the agent dir's sessions, auth and
  // settings cost nothing.
  watcher = chokidar.watch(dir, {
    ignoreInitial: true,
    depth: 0,
    ignored: (rawPath: string) => {
      const candidate = normalize(rawPath)
      return candidate !== root && candidate !== path
    },
    awaitWriteFinish: { stabilityThreshold: 250, pollInterval: 100 },
  })
  watcher.on('error', (error) => {
    // Never let a watcher error become an uncaught exception in main.
    console.warn('[Phosphor] mcp cache watcher error:', error)
  })

  const check = (): void => {
    if (debounce) clearTimeout(debounce)
    debounce = setTimeout(() => {
      debounce = undefined
      void fingerprintOf(path).then((next) => {
        // Unwatched while the read was in flight: shutting down, say nothing.
        if (!watcher || next === last) return
        last = next
        onChange()
      })
    }, 300)
  }
  watcher.on('add', check)
  watcher.on('change', check)
  watcher.on('unlink', check)
}

/** Stop watching and drop any pending notification. */
export async function unwatchMcpCache(): Promise<void> {
  if (debounce) clearTimeout(debounce)
  debounce = undefined
  const closing = watcher
  watcher = undefined
  await closing?.close()
}
