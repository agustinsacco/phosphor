import type { BrainStatus } from '@shared/brain'
import type { BrainTidyOperation, BrainTidySuggestion } from '@shared/brain-tidy'
import type { MockExplorer } from '../mockExplorer'
import { MockAgentJournal } from './mockAgentJournal'

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
    const first = item.subjects[0]!
    const kind =
      erase && first.type === 'memory' ? 'erase' : item.kind === 'same_entity' ? 'merge' : 'keep'
    const reason =
      kind === 'erase'
        ? 'This flag identifies an outdated memory.'
        : kind === 'merge'
          ? 'Both records describe the same project and evidence.'
          : 'The evidence supports keeping these separate.'
    const summary =
      kind === 'erase'
        ? `Erased a memory: ${reason}`
        : kind === 'merge'
          ? `Merged ${item.subjects[1]!.label} into ${first.label}`
          : 'Kept both as they are'
    this.change(
      runId,
      kind,
      summary,
      reason,
      () => {
        item.state = 'applied'
        if (kind === 'erase') this.journal.erase(first.id)
        if (kind === 'merge') this.explorer.merge(item.subjects[1]!.id, first.id)
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
