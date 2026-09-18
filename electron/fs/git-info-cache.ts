import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import type { GitInfo } from '@shared/models'

type Kind = 'full' | 'summary'
interface Entry {
  cwd: string
  generation: number
  loadingGeneration?: number
  loading?: Promise<GitInfo>
  value?: GitInfo
  expires: number
}

function canonical(cwd: string): string {
  try {
    return realpathSync.native(cwd)
  } catch {
    return resolve(cwd)
  }
}

/** Display-only cache. Safety checks must continue calling uncached gitInfo. */
export class GitInfoCache {
  private entries = new Map<string, Entry>()
  private active = 0
  private waiting: Array<() => void> = []

  constructor(
    private readonly capacity = 128,
    private readonly concurrency = 4,
  ) {}

  invalidate(cwd?: string): void {
    const path = cwd === undefined ? undefined : canonical(cwd)
    for (const entry of this.entries.values()) {
      if (path !== undefined && entry.cwd !== path) continue
      entry.generation++
      entry.value = undefined
      entry.expires = 0
    }
  }

  async get(cwd: string, kind: Kind, load: (path: string) => Promise<GitInfo>): Promise<GitInfo> {
    const path = canonical(cwd)
    const key = `${kind}:${path}`
    const entry = this.entries.get(key) ?? { cwd: path, generation: 0, expires: 0 }
    this.entries.delete(key)
    this.entries.set(key, entry)
    if (entry.value && Date.now() < entry.expires) return entry.value
    if (entry.loading) {
      if (entry.loadingGeneration === entry.generation) return entry.loading
      // A post-invalidation reader waits for the old query, then shares one
      // replacement. Never start overlapping queries for the same key.
      await entry.loading.catch(() => {})
      return this.get(path, kind, load)
    }
    const generation = entry.generation
    entry.loadingGeneration = generation
    entry.loading = this.run(() => load(path))
      .then((value) => {
        // Missing metadata and non-repo fallbacks can be transient failures.
        if (
          generation === entry.generation &&
          value.isRepo &&
          value.branch &&
          value.isWorktree !== undefined &&
          value.dirtyCount !== undefined
        ) {
          entry.value = value
          entry.expires = Date.now() + (kind === 'full' ? 1000 : 5000)
        }
        return value
      })
      .finally(() => {
        entry.loading = undefined
        if (!entry.value) this.entries.delete(key)
        this.trim()
      })
    this.trim()
    return entry.loading
  }

  private async run(load: () => Promise<GitInfo>): Promise<GitInfo> {
    if (this.active >= this.concurrency) await new Promise<void>((done) => this.waiting.push(done))
    else this.active++
    try {
      return await load()
    } finally {
      const next = this.waiting.shift()
      if (next)
        next() // Hand over this slot without letting a new caller steal it.
      else this.active--
    }
  }

  private trim(): void {
    // Outstanding callers pin their entries until completion. Only retained
    // results are evicted, so capacity pressure cannot break in-flight dedupe.
    for (const [key, entry] of this.entries) {
      if (this.entries.size <= this.capacity) break
      if (!entry.loading) this.entries.delete(key)
    }
  }
}

export const gitInfoCache = new GitInfoCache()
