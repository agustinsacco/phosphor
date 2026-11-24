import { MockTidyAgent } from './mockTidyAgent'
import { checkMockTidyArguments } from './mockTidyArguments'
import {
  emptyBrainTidySummary,
  type BrainTidyOperation,
  type BrainTidySuggestion,
  type BrainTidySummary,
} from '@shared/brain-tidy'
import type { BrainStatus } from '@shared/brain'
import type { MockExplorer } from '../mockExplorer'
import { seedMockTidy } from './mockTidyData'
import { mockEdit } from './mockEdits'

export interface MockTidyOptions {
  count?: number
  /** A lane flag arrives this many milliseconds after the first Tidy read. */
  flagAfterMs?: number
}

export class MockTidy {
  readonly agent: MockTidyAgent
  private items: BrainTidySuggestion[] = []
  private operations: BrainTidyOperation[] = []
  private snapshots = new Map<
    string,
    {
      entities: MockExplorer['entities']
      details: MockExplorer['details']
      revision: number
      undone?: () => void
    }
  >()
  private initialized = false
  private flagAt: number | null = null
  constructor(
    private explorer: MockExplorer,
    private state: BrainStatus,
    private now: () => number,
    private options: MockTidyOptions,
  ) {
    this.agent = new MockTidyAgent(explorer, state, now, () => {
      this.init()
      return this.items
    })
  }

  summary(): BrainTidySummary {
    const automatic = this.operations.filter((op) => op.kind === 'fold' && !op.undoneAt)
    return {
      ...emptyBrainTidySummary(),
      automaticFolds: automatic.length,
      newestAutomaticFoldAt: automatic[0]?.createdAt ?? null,
    }
  }
  reset(): void {
    this.initialized = true
    this.items = []
    this.operations = []
    this.agent.reset()
    this.snapshots.clear()
  }
  forget(id: string): void {
    this.items = this.items.filter((s) => !s.subjects.some((subject) => subject.id === id))
    // The mock conservatively drops all undo snapshots on permanent erasure.
    this.operations = []
    this.snapshots.clear()
  }
  tick(): void {
    if (this.flagAt !== null && this.now() >= this.flagAt) {
      const source = this.items.find((s) => s.kind === 'flagged')
      if (source) {
        const memory = structuredClone(this.explorer.memory(source.subjects[0]!.id))
        memory.memory.id = 'tidy-arriving-memory'
        this.explorer.details.push(memory)
        this.items.push({
          ...structuredClone(source),
          id: 'tidy-arriving-flag',
          subjects: [{ type: 'memory', id: memory.memory.id, label: memory.memory.summary }],
          state: 'open',
          createdAt: this.now(),
          updatedAt: this.now(),
        })
      }
      this.flagAt = null
    }
  }
  private init(): void {
    if (this.initialized) return
    this.items = seedMockTidy(this.explorer, this.options.count ?? 12, this.now())
    if (this.items.length) {
      const exact = structuredClone(this.explorer.details[0]!)
      exact.memory.id = 'tidy-exact-repeat'
      this.explorer.details.push(exact)
    }
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
    extra: { who?: BrainTidyOperation['who']; jobId?: string; undone?: () => void } = {},
  ): string {
    const id = `operation-${this.operations.length}`
    this.snapshots.set(id, {
      entities: structuredClone(this.explorer.entities),
      details: structuredClone(this.explorer.details),
      revision: this.state.revision + 1,
      undone: extra.undone,
    })
    change()
    this.operations.unshift({
      id,
      kind,
      summary,
      suggestionId: null,
      who: extra.who ?? 'you',
      reason: null,
      runId: null,
      jobId: extra.jobId ?? null,
      undoable: true,
      createdAt: this.now(),
      undoneAt: null,
    })
    return id
  }
  /** A read saved when it finished: one automatic operation; Undo removes what it added. */
  recordRead(jobId: string, summary: string, save: () => void, undone: () => void): string {
    return this.journal('read', summary, save, { who: 'automatic', jobId, undone })
  }
  /** `brain:describe`, `brain:removeName` and `brain:split`: journaled, so Undo restores them. */
  edit(channel: string, args: unknown[]): string {
    checkMockTidyArguments(channel, args)
    this.check(args.at(-1))
    const edit = mockEdit(this.explorer, channel, args)
    return this.journal(edit.kind, edit.summary, edit.apply)
  }
  merge(source: string, target: string, revision: number): string {
    this.check(revision)
    return this.journal(
      'merge',
      `Merged ${this.explorer.entity(source).entity.label} into ${this.explorer.entity(target).entity.label}`,
      () => this.explorer.merge(source, target),
    )
  }
  call(channel: string, args: unknown[]): unknown {
    checkMockTidyArguments(channel, args)
    this.init()
    this.tick()
    switch (channel) {
      case 'brain:tidyChanges':
        return {
          items: [...this.agent.operations, ...this.operations].slice(0, args[0] as number),
          revision: this.state.revision,
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
    if (this.agent.operations.some((op) => op.id === id)) {
      this.agent.undo(id)
      this.state.revision++
      return
    }
    const snapshot = this.snapshots.get(id)
    const op = this.operations.find((op) => op.id === id)
    if (!snapshot || !op || op.undoneAt) throw new Error('This change can no longer be undone.')
    if (snapshot.revision !== revision) throw new Error('Later changes prevent a clean undo.')
    this.explorer.entities = snapshot.entities
    this.explorer.details = snapshot.details
    snapshot.undone?.()
    op.undoneAt = this.now()
    op.undoable = false
    this.state.revision++
  }
}
