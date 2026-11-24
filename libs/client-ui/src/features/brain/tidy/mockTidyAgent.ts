import type { BrainStatus } from '@shared/brain'
import type { BrainTidyOperation, BrainTidySuggestion } from '@shared/brain-tidy'
import type { MockExplorer } from '../mockExplorer'
import { MockAgentJournal } from './mockAgentJournal'
import { decide } from './mockAgentDecisions'

/** The mock curator's decisions over the same suggestions Knowledge edits use. */
export class MockTidyAgent {
  private journal: MockAgentJournal
  constructor(
    private explorer: MockExplorer,
    private state: BrainStatus,
    now: () => number,
    private items: () => BrainTidySuggestion[],
  ) {
    this.journal = new MockAgentJournal(explorer, now)
  }
  get operations(): BrainTidyOperation[] {
    return this.journal.operations
  }
  reset(): void {
    this.journal.reset()
  }
  undo(id: string): void {
    this.journal.undo(id)
  }
  waitingCounts() {
    const items = this.items().filter((item) => item.state === 'open')
    return {
      entities: items.filter((s) => s.kind === 'same_entity').length,
      groups: items.filter((s) => s.kind === 'group').length,
      unlinked: items.filter((s) => s.kind === 'unlinked').length,
      repeats: items.filter((s) => s.kind === 'same_memory').length,
      conflicts: items.filter((s) => s.kind === 'conflict').length,
      flags: items.filter((s) => s.kind === 'flagged').length,
    }
  }
  waitingIds(): string[] {
    return this.items()
      .filter((s) => s.state === 'open')
      .map((s) => s.id)
  }
  runChanges(id: string): BrainTidyOperation[] {
    return this.operations.filter((op) => op.runId === id)
  }
  change(...args: Parameters<MockAgentJournal['record']>): void {
    this.journal.record(...args)
    this.state.revision++
  }
  resolve(runId: string, id: string, erase: boolean): void {
    const item = this.items().find((s) => s.id === id)!
    const decision = decide(item, erase)
    this.change(
      runId,
      decision.kind,
      decision.summary,
      decision.reason,
      () => {
        item.state = 'applied'
        decision.apply(this.explorer, this.journal)
      },
      null,
      () => {
        item.state = 'open'
      },
    )
  }
  undoRun(id: string): { undone: number; kept: number } {
    let undone = 0,
      kept = 0
    for (const op of this.runChanges(id)) {
      if (op.undoneAt) continue
      if (!op.undoable) {
        kept++
        continue
      }
      try {
        this.journal.undo(op.id)
        undone++
      } catch {
        kept++
      }
    }
    this.state.revision++
    return { undone, kept }
  }
}
