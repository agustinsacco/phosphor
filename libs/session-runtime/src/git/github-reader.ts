import type {
  GhBranchCoverage,
  GhPrReadOptions,
  GhPullRequest,
  GhRepoPullRequests,
} from '@phosphor/shared/models'
import { git } from './git-exec'
import { toPullRequest } from './github'
import { GithubFailure, type GithubCommand } from './github-command'
import {
  discoverGithubPrs,
  githubRepository,
  refreshGithubPrs,
  type GithubRepository,
} from './github-queries'

interface Entry {
  pr?: GhPullRequest
  coverage: GhBranchCoverage
  discoveredAt: number
  retryAt: number
  failures: number
}
interface Repository {
  identity?: GithubRepository
  identityAt: number
  entries: Map<string, Entry>
  usedAt: number
}
export interface GithubReaderPorts {
  run: GithubCommand
  origin?: (cwd: string, signal: AbortSignal) => Promise<string | null>
  branches?: (cwd: string, signal: AbortSignal) => Promise<string[]>
  budgetMs?: number
}
const TTL = 60_000
const DISCOVERY_TTL = 5 * TTL
const entry = (): Entry => ({
  coverage: { state: 'unavailable', checkedAt: 0, attemptedAt: 0 },
  discoveredAt: 0,
  retryAt: 0,
  failures: 0,
})

async function localBranches(cwd: string, signal: AbortSignal): Promise<string[]> {
  const output = await git(cwd, ['worktree', 'list', '--porcelain', '-z'], {
    signal,
    timeout: 5_000,
    isolateEnv: true,
    maxBuffer: 1024 * 1024,
  })
  return [
    ...new Set(
      output
        .split('\0')
        .filter((s) => s.startsWith('branch refs/heads/'))
        .map((s) => s.slice(18)),
    ),
  ]
}
function snapshot(repo: Repository, branches: string[]): GhRepoPullRequests {
  const byBranch: Record<string, GhPullRequest> = Object.create(null)
  const coverage: Record<string, GhBranchCoverage> = Object.create(null)
  for (const branch of branches) {
    const current = repo.entries.get(branch) ?? entry()
    if (current.pr) byBranch[branch] = current.pr
    coverage[branch] = { ...current.coverage }
  }
  return { byBranch, coverage, complete: false }
}
function fail(current: Entry, reason: GhBranchCoverage['reason'] = 'unavailable'): void {
  current.failures++
  current.retryAt = Date.now() + Math.min(15 * TTL, TTL * 2 ** Math.min(4, current.failures - 1))
  current.coverage = { ...current.coverage, state: 'unavailable', attemptedAt: Date.now(), reason }
}
function observed(current: Entry, pr: GhPullRequest | undefined): void {
  current.pr = pr
  current.failures = 0
  current.retryAt = Date.now() + TTL
  current.coverage = {
    state: pr ? 'found' : 'absent',
    checkedAt: Date.now(),
    attemptedAt: Date.now(),
  }
}
function due(current: Entry | undefined, force = false): boolean {
  return (
    !current ||
    Date.now() >= current.retryAt ||
    (force && !current.failures && Date.now() - current.coverage.attemptedAt >= 5_000)
  )
}

/** Machine-owned cache and serialized gh queue. No session/process lifecycle ownership. */
class GithubReader {
  private repositories = new Map<string, Repository>()
  private flights = new Map<string, Promise<GhRepoPullRequests | null>>()
  private tail = Promise.resolve()
  private blockedUntil = 0
  constructor(private ports: GithubReaderPorts) {}

  private run: GithubCommand = async (cwd, args, signal) => {
    if (signal.aborted) throw new GithubFailure('timeout')
    if (Date.now() < this.blockedUntil) throw new GithubFailure('rate-limited')
    const result = await this.ports.run(cwd, args, signal)
    if (signal.aborted) throw new GithubFailure('timeout')
    if (!result.ok && result.reason === 'rate-limited')
      this.blockedUntil = Date.now() + Math.max(TTL, result.retryAfterMs ?? TTL)
    return result
  }

  private async identity(cwd: string, repo: Repository, branches: string[], signal: AbortSignal) {
    if (repo.identity && Date.now() - repo.identityAt < DISCOVERY_TTL) return repo.identity
    const origin = this.ports.origin
      ? await this.ports.origin(cwd, signal)
      : await git(cwd, ['remote', 'get-url', 'origin'], {
          signal,
          timeout: 5_000,
          isolateEnv: true,
          trim: true,
          allowFail: true,
        })
    const identity = await githubRepository(this.run, cwd, origin, signal)
    if (repo.identity && JSON.stringify(identity) !== JSON.stringify(repo.identity)) {
      repo.entries.clear()
      for (const branch of branches) repo.entries.set(branch, entry())
    }
    repo.identity = identity
    repo.identityAt = Date.now()
    return identity
  }

  private async discover(
    cwd: string,
    repo: Repository,
    identity: GithubRepository,
    branches: string[],
    signal: AbortSignal,
  ) {
    const missing = branches.filter((branch) => {
      const current = repo.entries.get(branch)!
      return (
        !current.discoveredAt || !current.pr || Date.now() - current.discoveredAt >= DISCOVERY_TTL
      )
    })
    const failed = new Set<string>()
    if (!missing.length) return failed
    const found = await discoverGithubPrs(this.run, cwd, identity, missing, signal)
    for (const branch of missing) {
      const current = repo.entries.get(branch)!
      const raw = found.get(branch)
      if (raw === undefined) {
        fail(current)
        failed.add(branch)
        continue
      }
      current.discoveredAt = Date.now()
      const pr = raw ? (toPullRequest(raw) ?? undefined) : undefined
      if (pr) pr.checks = null
      observed(current, pr)
    }
    return failed
  }

  private async update(
    cwd: string,
    repo: Repository,
    branches: string[],
    force: boolean,
    signal: AbortSignal,
  ) {
    const requested = branches.filter((branch) => due(repo.entries.get(branch), force))
    if (!requested.length) return
    try {
      if (Date.now() < this.blockedUntil) throw new GithubFailure('rate-limited')
      const identity = await this.identity(cwd, repo, branches, signal)
      const failed = await this.discover(cwd, repo, identity, requested, signal)
      const known = requested.flatMap((branch) => {
        const current = repo.entries.get(branch)!
        return current.pr && !failed.has(branch) ? [{ branch, number: current.pr.number }] : []
      })
      if (!known.length) return
      const updated = await refreshGithubPrs(this.run, cwd, identity, known, signal)
      for (const { branch } of known) {
        const current = repo.entries.get(branch)!
        const pr = updated.get(branch)
        if (pr) observed(current, pr)
        else {
          current.discoveredAt = 0
          fail(current)
        }
      }
    } catch (error) {
      for (const branch of requested)
        fail(
          repo.entries.get(branch)!,
          signal.aborted
            ? 'timeout'
            : error instanceof GithubFailure
              ? error.reason
              : 'unavailable',
        )
    }
  }

  async read(cwd: string, options?: GhPrReadOptions): Promise<GhRepoPullRequests | null> {
    if (
      options &&
      (!Array.isArray(options.branches) ||
        !options.branches.length ||
        options.branches.length > 20 ||
        options.branches.some((b) => typeof b !== 'string' || !b || b.length > 4096))
    )
      return null
    const cached = this.repositories.get(cwd)
    if (
      cached &&
      options &&
      options.branches.every((branch) => !due(cached.entries.get(branch), options.force))
    ) {
      cached.usedAt = Date.now()
      return snapshot(cached, options.branches)
    }
    const key = JSON.stringify([cwd, options?.branches.slice().sort() ?? null])
    const pending = this.flights.get(key)
    if (pending) return pending
    if (this.flights.size >= 64) {
      if (!options) return null
      const result = snapshot(
        cached ?? { identityAt: 0, entries: new Map(), usedAt: Date.now() },
        options.branches,
      )
      for (const coverage of Object.values(result.coverage!)) {
        coverage.state = 'unavailable'
        coverage.attemptedAt = Date.now()
        coverage.reason = 'timeout'
      }
      return result
    }
    const work = this.timedRead(cwd, options)
    this.flights.set(key, work)
    try {
      return await work
    } finally {
      if (this.flights.get(key) === work) this.flights.delete(key)
    }
  }

  private repository(cwd: string): Repository {
    const repo = this.repositories.get(cwd) ?? {
      identityAt: 0,
      entries: new Map<string, Entry>(),
      usedAt: Date.now(),
    }
    repo.usedAt = Date.now()
    this.repositories.delete(cwd)
    this.repositories.set(cwd, repo)
    for (const [path, value] of this.repositories) {
      if (path !== cwd && (this.repositories.size > 64 || Date.now() - value.usedAt > 30 * TTL))
        this.repositories.delete(path)
    }
    return repo
  }

  private async timedRead(
    cwd: string,
    options?: GhPrReadOptions,
  ): Promise<GhRepoPullRequests | null> {
    const controller = new AbortController()
    const { signal } = controller
    const repo = this.repository(cwd)
    let branches = [...new Set(options?.branches ?? [])]
    let expired = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(() => {
        expired = true
        controller.abort()
        resolve()
      }, this.ports.budgetMs ?? 20_000)
      timer.unref?.()
    })
    const work = this.tail
      .then(async () => {
        if (signal.aborted) return
        if (!options)
          branches = (await (this.ports.branches ?? localBranches)(cwd, signal)).slice(0, 20)
        for (const branch of branches)
          if (!repo.entries.has(branch)) repo.entries.set(branch, entry())
        for (const branch of repo.entries.keys()) {
          if (repo.entries.size <= 1000) break
          if (!branches.includes(branch)) repo.entries.delete(branch)
        }
        await this.update(cwd, repo, branches, options?.force ?? false, signal)
      })
      .catch(() => {
        for (const branch of branches) {
          const current = repo.entries.get(branch)
          if (current) fail(current)
        }
      })
    this.tail = work
    try {
      await Promise.race([work, timeout])
      if (expired)
        for (const branch of branches) {
          const current = repo.entries.get(branch) ?? entry()
          fail(current, 'timeout')
          repo.entries.set(branch, current)
        }
      const result = snapshot(repo, branches)
      for (const branch of repo.entries.keys()) {
        if (repo.entries.size <= 1000) break
        if (!branches.includes(branch)) repo.entries.delete(branch)
      }
      return result
    } finally {
      clearTimeout(timer)
    }
  }
  remove(cwd: string): void {
    this.repositories.delete(cwd)
  }
}

export const createGithubReader = (ports: GithubReaderPorts) => new GithubReader(ports)
