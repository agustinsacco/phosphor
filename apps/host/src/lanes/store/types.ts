import type {
  LaneControl,
  LaneController,
  LaneSummary,
  Receipt,
} from '@phosphor/shared/host-protocol'

export type RepositoryIdentity = {
  home: string
  expected: { path: string; dev: number; ino: number }
}

export class LaneCapacityReached extends Error {
  constructor() {
    super('Host lane capacity reached.')
  }
}

export interface StoredLane extends LaneSummary {
  readonly sessionFile: string | null
  readonly removedAt: string | null
}
export interface LanePatch {
  title?: string | null
  branch?: string | null
  provider?: string | null
  model?: string | null
  updatedAt?: string
}
export interface LaneInput extends LanePatch {
  repositoryId: string
  cwd: string
  sessionFile: string | null
  worktree?: boolean
}
export type Controller = Pick<LaneController, 'clientId' | 'label'>
export type Admission =
  | { admitted: true; control: LaneControl }
  | { admitted: false; code: 'stale-fence' | 'not-controller'; control: LaneControl }
export type RequestStart =
  { kind: 'new' } | { kind: 'existing'; receipt: Receipt } | { kind: 'conflict' } | { kind: 'busy' }
export type StoreLimits = {
  [Key in 'receiptsKept' | 'lanesPerHost' | 'repositoriesPerHost']: number
}
export interface StorePorts {
  onLaneRemoved?: (laneId: string) => void
  now?: () => number
  receiptTtlMs?: number
  isConnected?: (clientId: string) => boolean
  limits?: Partial<StoreLimits>
  logCorruptReceipt?: (count: number) => void
  logCorruptLane?: (count: number) => void
}
