import type { LaneReceipt } from '../lane-receipt'
import type { HostCapability } from '../remote-host'
import type {
  RepositorySummary,
  LaneSummary,
  StoppedComposer,
  StreamCursor,
} from '../host-protocol'
import type { ControlErrorCode } from '../control-api'
import type { LocalStatus, ServicePauseState } from '../host-protocol-owner'

export type DesktopControlErrorCode = ControlErrorCode | 'signed-out' | 'offline'

export type ControlResult<T> =
  ({ ok: true } & T) | { ok: false; error: { code: DesktopControlErrorCode; message: string } }

/** Parsed session tree (subset of entries) for the tree view. */
export interface SessionTreeEntry {
  id: string
  parentId: string | null
  type: string
  timestamp: string
  messageTimestamp?: number
  role?: string
  preview?: string
  toolName?: string
  targetId?: string
  label?: string
  summary?: string
  name?: string
  /** model_change entries. */
  provider?: string
  modelId?: string
  /** thinking_level_change entries. */
  thinkingLevel?: string
}

export interface SessionTree {
  sessionId: string
  cwd: string
  entries: SessionTreeEntry[]
  leafId: string | null
}

export type HostLaneView = Omit<LaneSummary, 'control' | 'pinned'> & {
  /** Pinned on the Host; `marker` is the Host's explicit marker choice. */
  pinned?: boolean
  stoppedComposer?: StoppedComposer
  control: {
    fence: number
    controller: { label: string; connected: boolean; self: boolean } | null
  }
}

export interface HostConnectionView {
  /** Opaque main-owned transport incarnation, independent of the Host runtime epoch. */
  connectionToken: string
  state:
    | 'down'
    | 'no-address'
    | 'connecting'
    | 'ready'
    | 'reconnecting'
    | 'wrong-machine'
    | 'unsupported'
    | 'signed-out'
  hostVersion?: string
  /** Host supports settings before this client requests configuration authority. */
  configurationSupported?: boolean
  /** Host opens shells in its account's home folder, outside any lane. */
  machineShell?: boolean
  /** Host keeps lane pins and markers, so every client shows the same ones. */
  laneMarks?: boolean
  laneRename?: boolean
  partialModels?: boolean
  warmOnOpen?: boolean
  laneArchive?: boolean
  /** Host can send and receive lanes (`laneTransfer.*`). */
  laneTransfer?: boolean
  /** Host serves raw file bytes (`files.readBytes`): downloads and media previews. */
  fileBytes?: boolean
  /** Host reads PRs by number (`github.prSummaries`, `github.prDetail`) and sends lane PR signals. */
  prStatus?: boolean
  /** Host sends Web Push; its VAPID public key, which a browser subscribes with. */
  webPushKey?: string
  /** Browser only: whether this device's push subscription is registered with the Host. */
  pushRegistration?: 'registered' | 'failed'
  /** Host reads a lane's file again after Track or Hide, so its summary shows the write. */
  prTracking?: boolean
  /** This Mac's own daemon over its local socket, not a Host reached over the tailnet. */
  local?: true
  /** The enrolled Host id when `local` and enrolled; grants and `machine` principals use it. */
  enrolledHostId?: string
  /** Host serves agent-control catalog ops (`ops.run`). */
  ops?: boolean
  /** Only on a `local` connection: the daemon admitted this client as its owner. */
  ownerLocal?: boolean
  /** Host serves lane tree, label, jump, fork, clone and rewind as ops. */
  laneEditing?: boolean
  laneContext?: boolean
  laneReload?: boolean
  sandboxes?: boolean
  folderDirectives?: boolean
  configFiles?: boolean
  /** Host pages its folder and lane lists past the single-frame caps. */
  pagedLanes?: boolean
  capabilities: HostCapability[]
  repositories: RepositorySummary[]
  lanes: HostLaneView[]
  cursor?: StreamCursor
  lastError?: string
}

export type HostsSnapshot = Record<string, HostConnectionView>

/** Who runs This Mac's lanes: Desktop itself, or the local Phosphor service (daemon). */
export type LocalRuntimeMode = 'in-app' | 'daemon'

/** This Mac's runtime, its one-time move to the Phosphor service and that service's health. */
export interface LocalMachineStatus {
  mode: LocalRuntimeMode
  migration:
    | 'not-needed'
    | 'waiting'
    | 'running'
    | 'failed'
    | 'committed'
    | 'repairing'
    | 'reverted'
    | 'consent-needed'
  /** The migration step running or last run. */
  step?: string
  failure?: { step: string; code: string }
  service?: 'ready' | 'connecting' | 'down' | 'attestation-failed'
  serviceVersion?: string
  pause?: ServicePauseState
  lastUpdate?: LocalStatus['lastUpdate']
  /**
   * Why This Mac stays in-app: `no-bundle` (no service build for this Mac),
   * `limits` (a preflight that cannot page), `other-daemon` (a service Desktop
   * did not set up), `state-folder` (the service's state folder is not a
   * private folder of this user), `dev-build` (an unpackaged build over data
   * that belongs to the service).
   */
  notice?: 'no-bundle' | 'limits' | 'other-daemon' | 'state-folder' | 'dev-build'
  /**
   * While in-app: the Phosphor service install Desktop runs in the background, so a setup that
   * cannot finish says why. `detail` is the installer's own text; `version` the release.
   */
  install?: LocalServiceInstall
}

export interface LocalServiceInstall {
  state: 'checking' | 'installing' | 'waiting' | 'blocked' | 'failed' | 'installed'
  /** While installing: downloading the release, or running its setup. */
  step?: 'download' | 'setup'
  version?: string
  detail?: string
}

/** A button on This Mac's runtime card; main decides what is legal now. */
export type LocalMachineAction =
  | 'retry-migration'
  | 'consent-migration'
  | 'restart-to-finish'
  | 'start-service'
  | 'update-service'
  | 'update-abort-now'
  | 'update-cancel'
  | 'export-diagnostics'

/**
 * One line of Desktop's remote traffic log (`hosts:traffic`): what crossed the
 * wire and when, never what it said. Kinds, method names, ids, sizes, timings
 * and error codes only; no payload, grant or terminal input is ever recorded.
 */
export interface TrafficEntry {
  /** Monotonic within this app run; the poll cursor. */
  seq: number
  /** Epoch milliseconds. */
  at: number
  peer: 'control' | 'host'
  hostId?: string
  /** `call` is one request and its reply; `state` is a lifecycle change, not a frame. */
  direction: 'out' | 'in' | 'call' | 'state'
  kind: string
  detail?: string
  bytes?: number
  ms?: number
  outcome?: 'ok' | 'error'
  code?: string
}

export interface TrafficPage {
  entries: TrafficEntry[]
  /** Newest seq recorded so far: pass it back as `after`. */
  last: number
  /** True when entries after `after` were dropped before this read. */
  gap: boolean
}

/** A new lane on a Host (11). The Host picks the folder; never a path from here. */
export interface RemoteLaneCreate {
  repositoryId: string
  worktree?: { branch: string; fresh?: true }
  name?: string
  provider?: string
  model?: string
  thinkingLevel?: string
}

/** How far one `hosts:fileDownload` has got, pushed while it runs. */
export interface FileDownloadProgress {
  id: string
  received: number
  size: number
}

/** An attention event from any Host, for in-app and OS notifications (49). */
export interface HostAttention {
  receipt?: LaneReceipt
  hostId: string
  laneId: string
  kind: 'finished' | 'needs-input' | 'failed' | 'routine'
  title: string
  at: string
}
