import {
  emptyBrainTidyPage,
  emptyBrainTidySummary,
  type BrainTidyAction,
  type BrainTidyOperation,
  type BrainTidyPage,
  type BrainTidySuggestion,
  type BrainTidySummary,
} from '@shared/brain-tidy'
import type { BrainStatus } from '@shared/brain'
import type { MockExplorer } from '../mockExplorer'
import { seedMockTidy } from './mockTidyData'

export interface MockTidyOptions {
  count?: number
  failFirstLoad?: boolean
  /** A lane flag arrives this many milliseconds after the first Tidy read. */
  flagAfterMs?: number
}

export class MockTidy {
  private items: BrainTidySuggestion[] = []
  private operations: BrainTidyOperation[] = []
  private snapshots = new Map<
    string,
    { entities: MockExplorer['entities']; details: MockExplorer['details']; revision: number }
  >()
  private page = emptyBrainTidyPage()
  private initialized = false
  private failed = false
  private flagAt: number | null = null
  constructor(
    private explorer: MockExplorer,
    private state: BrainStatus,
    private now: () => number,
    private options: MockTidyOptions,
  ) {}

  summary(): BrainTidySummary {
    const automatic = this.operations.filter((op) => op.automatic && !op.undoneAt)
    return {
      ...emptyBrainTidySummary(),
      open: this.initialized
        ? this.items.filter((s) => s.state === 'open').length
        : (this.options.count ?? 12),
      newestSuggestionAt: this.items.at(-1)?.createdAt ?? null,
      running: !!this.page.run && ['queued', 'sweeping', 'checking'].includes(this.page.run.state),
      automaticFolds: automatic.length,
      newestAutomaticFoldAt: automatic[0]?.createdAt ?? null,
    }
  }
  reset(): void {
    this.initialized = true
    this.items = []
    this.operations = []
    this.snapshots.clear()
    this.page = emptyBrainTidyPage()
  }
  forget(id: string): void {
    this.items = this.items.filter((s) => !s.subjects.some((subject) => subject.id === id))
    // The mock conservatively drops all undo snapshots on permanent erasure.
    this.operations = []
    this.snapshots.clear()
  }
  tick(): void {
    const run = this.page.run
    if (run && this.summary().running) {
      const elapsed = this.now() - run.startedAt
      run.state = elapsed < 2000 ? 'sweeping' : elapsed < 6000 ? 'checking' : 'done'
      run.checked = Math.min(run.total, Math.max(0, Math.floor((elapsed - 2000) / 500)))
      if (run.state === 'done') {
        run.finishedAt = this.now()
        run.checked = run.total
        run.suggestions = this.items.filter((s) => s.state === 'open').length
        this.page.coverage = {
          phase: 'done',
          cursor: 0,
          entities: this.explorer.entities.length,
          totalEntities: this.explorer.entities.length,
          memories: this.explorer.details.length,
          totalMemories: this.explorer.details.length,
          cappedBuckets: 0,
          startedAt: run.startedAt,
          finishedAt: this.now(),
        }
      }
    }
    if (this.flagAt !== null && this.now() >= this.flagAt) {
      const source = this.items.find((s) => s.kind === 'flagged')
      if (source)
        this.items.push({
          ...structuredClone(source),
          id: 'tidy-arriving-flag',
          state: 'open',
          createdAt: this.now(),
          updatedAt: this.now(),
        })
      this.flagAt = null
    }
  }
  private init(): void {
    if (this.initialized) return
    this.items = seedMockTidy(this.explorer, this.options.count ?? 12, this.now())
    this.initialized = true
    if (this.options.flagAfterMs !== undefined) this.flagAt = this.now() + this.options.flagAfterMs
  }
  private check(revision: unknown): void {
    if (revision !== this.state.revision)
      throw new Error('Brain changed; refresh Tidy and try again.')
  }
  private journal(
    kind: BrainTidyOperation['kind'],
    summary: string,
    change: () => void,
    suggestionId: string | null = null,
  ): string {
    const id = `operation-${this.operations.length}`
    this.snapshots.set(id, {
      entities: structuredClone(this.explorer.entities),
      details: structuredClone(this.explorer.details),
      revision: this.state.revision + 1,
    })
    change()
    this.operations.unshift({
      id,
      kind,
      summary,
      suggestionId,
      automatic: false,
      createdAt: this.now(),
      undoneAt: null,
    })
    return id
  }
  merge(source: string, target: string, revision: number): string {
    this.check(revision)
    return this.journal(
      'merge',
      `Merged ${this.explorer.entity(source).entity.label} into ${this.explorer.entity(target).entity.label}`,
      () => this.explorer.merge(source, target),
    )
  }
  private apply(id: string, action: BrainTidyAction): string | null {
    const suggestion = this.items.find((s) => s.id === id && s.state === 'open')
    if (!suggestion) throw new Error('This suggestion was already settled.')
    suggestion.state = 'applied'
    const ids = suggestion.subjects.map((s) => s.id)
    if (action.kind === 'keep') return null
    if (action.kind === 'forget') {
      this.explorer.details = this.explorer.details.filter((d) => !ids.includes(d.memory.id))
      this.forget(ids[0]!)
      return null
    }
    return this.journal(
      action.kind,
      suggestion.subjects.map((s) => s.label).join(' · '),
      () => {
        if (action.kind === 'merge')
          this.explorer.merge(
            ids.find((id) => id !== action.survivorId)!,
            action.survivorId,
          )
        if (action.kind === 'fold') {
          const survivor = this.explorer.memory(action.survivorId)
          const other = this.explorer.memory(ids.find((id) => id !== action.survivorId)!)
          this.explorer.details = this.explorer.details.filter(
            (d) => d.memory.id !== other.memory.id,
          )
          this.explorer.details
            .find((d) => d.memory.id === survivor.memory.id)!
            .quotes.push(...other.quotes)
        }
        if (action.kind === 'dispute' || action.kind === 'replace')
          for (const d of this.explorer.details.filter((d) => ids.includes(d.memory.id)))
            d.memory.state =
              action.kind === 'dispute'
                ? 'disputed'
                : d.memory.id === action.newerId
                  ? 'active'
                  : 'superseded'
      },
      id,
    )
  }
  call(channel: string, args: unknown[]): unknown {
    this.init()
    this.tick()
    switch (channel) {
      case 'brain:tidy':
        return this.list(args)
      case 'brain:tidySuggestion': {
        const suggestion = this.items.find((s) => s.id === args[0] && s.state === 'open')
        if (!suggestion) throw new Error('This suggestion was already settled.')
        return {
          suggestion,
          revision: this.state.revision,
          subjects: suggestion.subjects.map((s) =>
            s.type === 'entity'
              ? { type: 'entity', value: this.explorer.entity(s.id) }
              : { type: 'memory', value: this.explorer.memory(s.id) },
          ),
        }
      }
      case 'brain:tidyChanges':
        return { items: this.operations.slice(0, args[0] as number), revision: this.state.revision }
      case 'brain:tidyRun':
        this.page.run = {
          state: 'sweeping',
          startedAt: this.now(),
          finishedAt: null,
          checked: 0,
          total: 8,
          suggestions: 0,
          folded: 0,
          message: null,
          error: null,
        }
        break
      case 'brain:tidyCancel':
        if (this.page.run)
          this.page.run = { ...this.page.run, state: 'cancelled', finishedAt: this.now() }
        break
      case 'brain:tidyApply': {
        this.check(args[2])
        const operationId = this.apply(args[0] as string, args[1] as BrainTidyAction)
        this.state.revision++
        return { ...this.state, tidy: this.summary(), operationId }
      }
      case 'brain:tidyDismiss': {
        this.check(args[1])
        const suggestion = this.items.find((s) => s.id === args[0])
        if (suggestion) suggestion.state = 'dismissed'
        this.state.revision++
        break
      }
      case 'brain:tidyUndo':
        this.undo(args[0] as string, args[1] as number)
        break
      default:
        throw new Error('Unknown Tidy channel')
    }
    return { ...this.state, tidy: this.summary() }
  }
  private undo(id: string, revision: number): void {
    this.check(revision)
    const snapshot = this.snapshots.get(id)
    const op = this.operations.find((op) => op.id === id)
    if (!snapshot || !op || op.undoneAt) throw new Error('This change can no longer be undone.')
    if (snapshot.revision !== revision) throw new Error('Later changes prevent a clean undo.')
    this.explorer.entities = snapshot.entities
    this.explorer.details = snapshot.details
    op.undoneAt = this.now()
    this.state.revision++
  }
  private list(args: unknown[]): BrainTidyPage {
    if (this.options.failFirstLoad && !this.failed) {
      this.failed = true
      throw new Error('Tidy is temporarily unavailable.')
    }
    const items = this.items.filter((s) => s.state === 'open')
    const matches = items.filter((s) => !args[0] || s.kind === args[0])
    const offset = Number(args[1] ?? 0),
      limit = args[2] as number
    return {
      ...this.page,
      revision: this.state.revision,
      items: matches.slice(offset, offset + limit),
      next: offset + limit < matches.length ? String(offset + limit) : null,
      counts: {
        same_entity: 0,
        same_memory: 0,
        conflict: 0,
        flagged: 0,
        ...Object.fromEntries(
          ['same_entity', 'same_memory', 'conflict', 'flagged'].map((kind) => [
            kind,
            items.filter((s) => s.kind === kind).length,
          ]),
        ),
      },
    }
  }
}
