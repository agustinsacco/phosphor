import { create } from 'zustand'
import type { LaneMoveMarks } from '@shared/host-protocol-lane-transfer'
import type { LaneMoveSource } from '@shared/lane-move'

/** The lane a "Move to…" dialog is open for. One at a time; `LaneMoveHost` renders it. */
export interface LaneMoveDraft {
  source: LaneMoveSource
  title: string
  marks: LaneMoveMarks
}

export const useLaneMoveStore = create<{
  draft: LaneMoveDraft | null
  open: (draft: LaneMoveDraft) => void
  close: () => void
}>((set) => ({
  draft: null,
  open: (draft) => set({ draft }),
  close: () => set({ draft: null }),
}))
