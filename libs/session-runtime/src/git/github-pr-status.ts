import type {
  GhBranchCoverage,
  GhPrFailure,
  GhPrKey,
  GhPrRead,
  GhPrRef,
  GhPrSummary,
} from '@phosphor/shared/models'
import { parsePrRefs, parsePrSummaryOptions, prKey } from '@phosphor/shared/github-pr-refs'
import { GithubFailure } from './github-command'
import type { GithubGate } from './github-gate'
import { readSummaries } from './github-pr-summary'

/**
 * PR status read by number, so a lane's PR on another branch or in another
 * repository reads the same way as its checkout's. Shares the branch reader's
 * gate: one queue, one rate-limit pause.
 *
 * The renderer owns the schedule. This only reuses a read inside `FRESH`,
 * so two windows asking at once cost one query, and backs off on failure.
 */

const FRESH = 15_000
const FORCE_FLOOR = 5_000
const TERMINAL = 30 * 60_000
const MAX_ENTRIES = 500

interface Entry {
  summary?: GhPrSummary
  coverage: GhBranchCoverage
  retryAt: number
  failures: number
  usedAt: number
}

export interface GithubPrStatusPorts {
  gate: GithubGate
  /** Where gh runs. It names the host per call, so any directory works. */
  cwd: string
  budgetMs?: number
}

const repoOf = (ref: GhPrRef) => `${ref.host}/${ref.owner}/${ref.repo}`.toLowerCase()

class GithubPrStatusReader {
  private entries = new Map<GhPrKey, Entry>()
  private flights = new Map<GhPrKey, Promise<void>>()
  constructor(private ports: GithubPrStatusPorts) {}

  async read(refsValue: unknown, optionsValue?: unknown): Promise<GhPrRead | null> {
    const refs = parsePrRefs(refsValue)
    const options = parsePrSummaryOptions(optionsValue)
    if (!refs || !options) return null
    const waits: Promise<void>[] = []
    const due: GhPrRef[] = []
    for (const ref of refs) {
      const flight = this.flights.get(prKey(ref))
      if (flight) waits.push(flight)
      else if (this.due(prKey(ref), options.force)) due.push(ref)
    }
    if (due.length) {
      const work = this.fetch(due).finally(() => {
        for (const ref of due)
          if (this.flights.get(prKey(ref)) === work) this.flights.delete(prKey(ref))
      })
      for (const ref of due) this.flights.set(prKey(ref), work)
      waits.push(work)
    }
    await Promise.all(waits)
    return this.snapshot(refs)
  }

  private due(key: GhPrKey, force = false): boolean {
    const entry = this.entries.get(key)
    if (!entry) return true
    const now = Date.now()
    if (force && !entry.failures) return now - entry.coverage.attemptedAt >= FORCE_FLOOR
    return now >= entry.retryAt
  }

  private entry(ref: GhPrRef): Entry {
    const key = prKey(ref)
    const entry = this.entries.get(key) ?? {
      coverage: { state: 'unavailable', checkedAt: 0, attemptedAt: 0 },
      retryAt: 0,
      failures: 0,
      usedAt: 0,
    }
    entry.usedAt = Date.now()
    this.entries.delete(key)
    this.entries.set(key, entry)
    while (this.entries.size > MAX_ENTRIES) {
      const oldest = this.entries.keys().next().value
      if (oldest === undefined) break
      this.entries.delete(oldest)
    }
    return entry
  }

  private observed(ref: GhPrRef, summary: GhPrSummary | null): void {
    const entry = this.entry(ref)
    const now = Date.now()
    entry.failures = 0
    entry.coverage = { state: summary ? 'found' : 'absent', checkedAt: now, attemptedAt: now }
    if (summary) entry.summary = summary
    else delete entry.summary
    const terminal = !summary || summary.state === 'MERGED' || summary.state === 'CLOSED'
    entry.retryAt = now + (terminal ? TERMINAL : FRESH)
  }

  /** Keeps the last known summary: a failed read never makes a PR disappear. */
  private failed(ref: GhPrRef, reason: GhPrFailure): void {
    const entry = this.entry(ref)
    const now = Date.now()
    entry.failures++
    entry.retryAt = now + Math.min(15 * 60_000, 60_000 * 2 ** Math.min(4, entry.failures - 1))
    entry.coverage = { ...entry.coverage, state: 'unavailable', attemptedAt: now, reason }
  }

  private async fetch(refs: GhPrRef[]): Promise<void> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.ports.budgetMs ?? 20_000)
    timer.unref?.()
    const groups = new Map<string, GhPrRef[]>()
    for (const ref of refs) groups.set(repoOf(ref), [...(groups.get(repoOf(ref)) ?? []), ref])
    try {
      for (const group of groups.values()) {
        // The renderer never chooses where gh connects: only hosts a checkout resolved.
        if (!this.ports.gate.trusts(group[0]!.host)) {
          for (const ref of group) this.failed(ref, 'unavailable')
          continue
        }
        try {
          const found = await this.ports.gate.enqueue(() =>
            readSummaries(this.ports.gate.run, this.ports.cwd, group, controller.signal),
          )
          for (const ref of group) {
            const summary = found.get(prKey(ref))
            if (summary === undefined) this.failed(ref, 'unavailable')
            else this.observed(ref, summary)
          }
        } catch (error) {
          const reason = controller.signal.aborted
            ? 'timeout'
            : error instanceof GithubFailure
              ? error.reason
              : 'unavailable'
          for (const ref of group) this.failed(ref, reason)
        }
      }
    } finally {
      clearTimeout(timer)
    }
  }

  private snapshot(refs: GhPrRef[]): GhPrRead {
    const byKey: Record<GhPrKey, GhPrSummary> = Object.create(null)
    const coverage: Record<GhPrKey, GhBranchCoverage> = Object.create(null)
    for (const ref of refs) {
      const entry = this.entries.get(prKey(ref))
      if (entry?.summary) byKey[prKey(ref)] = entry.summary
      coverage[prKey(ref)] = entry
        ? { ...entry.coverage }
        : { state: 'unavailable', checkedAt: 0, attemptedAt: Date.now(), reason: 'timeout' }
    }
    return { byKey, coverage }
  }
}

export const createGithubPrStatusReader = (ports: GithubPrStatusPorts) =>
  new GithubPrStatusReader(ports)
export type { GithubPrStatusReader }
