import type { BrainTidyOperation } from '@shared/brain-tidy'
import type { MockExplorer } from '../mockExplorer'

/** Agent-only mock journal. Erasures redact snapshots rather than reviving text on undo. */
export class MockAgentJournal {
  operations: BrainTidyOperation[] = []
  private restore = new Map<string, () => void>()
  private erased = new Set<string>()
  constructor(
    private explorer: MockExplorer,
    private now: () => number,
  ) {}
  record(
    runId: string,
    kind: BrainTidyOperation['kind'],
    summary: string,
    reason: string,
    apply: () => void,
    jobId: string | null = null,
    undo?: () => void,
  ): void {
    const entities = structuredClone(this.explorer.entities)
    const details = structuredClone(this.explorer.details)
    apply()
    const id = crypto.randomUUID()
    const operation: BrainTidyOperation = {
      id,
      kind,
      summary,
      reason,
      runId,
      jobId,
      who: 'agent',
      undoable: kind !== 'erase',
      createdAt: this.now(),
      undoneAt: null,
      suggestionId: null,
    }
    this.operations.unshift(operation)
    if (operation.undoable)
      this.restore.set(id, () => {
        this.explorer.entities = entities
        this.explorer.details = details.filter((d) => !this.erased.has(d.memory.id))
        undo?.()
      })
  }
  erase(memoryId: string): void {
    this.erased.add(memoryId)
    this.explorer.details = this.explorer.details.filter((d) => d.memory.id !== memoryId)
  }
  undo(id: string): void {
    const operation = this.operations.find((op) => op.id === id)
    const restore = this.restore.get(id)
    if (!operation?.undoable || !restore) throw new Error('This change can no longer be undone.')
    restore()
    this.restore.delete(id)
    operation.undoable = false
    operation.undoneAt = this.now()
  }
  reset(): void {
    this.operations = []
    this.restore.clear()
    this.erased.clear()
  }
}
