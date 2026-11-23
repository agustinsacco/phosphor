/** Structural type for an individual lane control (the registry lives in lane-controls.ts). */
export interface LaneControl<F> {
  facts(): F
  agentSet(next: boolean, reason: string, ctx: unknown): void | Promise<void>
}
