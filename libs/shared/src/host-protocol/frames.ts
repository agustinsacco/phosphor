/** Every frame on the stream socket, the socket itself, and the client frame parse result. */
import type { BrainAccess } from '../brain-access'
import type { TerminalFrame, TerminalInput, TerminalSubscribe } from '../host-protocol-terminals'
import type { HOST_PROTOCOL_VERSION, HostCapability, HostHello } from '../remote-host'
import type { HostCloseCode } from './constants'
import type {
  AttentionEvent,
  LaneEvent,
  LaneSnapshot,
  LaneSummary,
  RepositorySummary,
  StreamCursor,
} from './lanes'
import type { HostResourceChange } from './resource-change'
import type { CallError, LaneOp, Receipt } from './operations'

export type ClientFrame =
  | TerminalInput
  | TerminalSubscribe
  /** First frame (with `challenge`), and later to renew (without). */
  | {
      readonly type: 'auth'
      readonly grant: string
      readonly challenge?: string
      readonly trace?: string
    }
  | {
      readonly type: 'subscribe'
      readonly id: string
      readonly topic: 'lanes'
      /** Older Hosts ignore this opt-in; newer Hosts never send the event without it. */
      readonly resourceChanges?: true
      readonly gitResourceChanges?: true
      /** Replays attention events after this cursor when the epoch matches. */
      readonly after?: StreamCursor
      readonly trace?: string
    }
  | {
      readonly type: 'subscribe'
      readonly id: string
      readonly topic: 'lane'
      readonly laneId: string
      readonly after?: StreamCursor
      readonly trace?: string
    }
  | { readonly type: 'unsubscribe'; readonly id: string }
  | {
      readonly type: 'command'
      readonly requestId: string
      readonly laneId?: string
      readonly fence?: number
      readonly op: LaneOp
      readonly trace?: string
    }
  | { readonly type: 'receipt-status'; readonly requestId: string }
  | {
      readonly type: 'call'
      readonly id: string
      readonly method: string
      readonly params?: unknown
      readonly trace?: string
    }
  | { readonly type: 'ping'; readonly at: number }

export type HostFrame =
  | TerminalFrame
  | {
      readonly type: 'ready'
      readonly protocolVersion: typeof HOST_PROTOCOL_VERSION
      readonly hello: HostHello
      /** base64url Ed25519 over `helloProofMessage(hostId, runtimeEpoch, challenge)`. */
      readonly proof: string
      readonly connectionId: string
      readonly grantExpiresAt: string
      readonly client: { readonly id: string; readonly label: string }
      /** Additive support marker; legacy grants keep their original capabilities. */
      readonly settings?: boolean
      /** Additive support marker: `terminal.create` without a lane opens a machine shell. */
      readonly machineShell?: boolean
      /** Additive support marker: the Host keeps lane pins and markers (`lane.marks`). */
      readonly laneMarks?: boolean
      /** The catalog can rename both live and saved lanes. */
      readonly laneRename?: boolean
      /** Host accepts the partial opt-in on machine.models. */
      readonly partialModels?: boolean
      /** Retained-worktree lane archive, restore and explicit cleanup. */
      readonly warmOnOpen?: boolean
      readonly laneArchive?: boolean
      /** Additive support marker: the Host exports and imports lanes (`laneTransfer.*`). */
      readonly laneTransfer?: boolean
      /** Additive support marker: the Host serves raw file bytes (`files.readBytes`). */
      readonly fileBytes?: boolean
      /**
       * Additive support marker: the Host reads PRs by number (`github.prSummaries`,
       * `github.prDetail`) and sends lane summaries' `pullRequests`.
       */
      readonly prStatus?: boolean
      /**
       * Additive support marker: the Host sends Web Push (`notifications.subscribe`). The value
       * is its VAPID public key, the `applicationServerKey` a browser subscribes with.
       */
      readonly webPushKey?: string
      /**
       * Additive support marker: after Track or Hide (`/phosphor-prs`) the Host reads
       * the lane's file again, so its summary's `pullRequests` carry the write.
       */
      readonly prTracking?: boolean
      readonly brain?: boolean
      readonly brainAccess?: readonly BrainAccess[]
      /** `ops.run` (call and command) is served. `READY_OP_FLAGS` lists these booleans. */
      readonly ops?: boolean
      /** This connection is the attested owner on the machine's Unix socket. */
      readonly ownerLocal?: boolean
      /** Catalog ops `lane.tree|label|jump|fork|clone|rewind`. */
      readonly laneEditing?: boolean
      /** Catalog ops `contextFiles.set`, `mcp.lane` and the new-lane default. */
      readonly laneContext?: boolean
      /** Catalog op `lane.reload`. */
      readonly laneReload?: boolean
      /** Catalog ops `sandbox.*`. */
      readonly sandboxes?: boolean
      /** Catalog op `directives.set --project`. */
      readonly folderDirectives?: boolean
      /** Catalog ops `config.*`, `skill.create|edit|delete` and the raw MCP file. */
      readonly configFiles?: boolean
      /**
       * Catalog ops `folder.list` and `lane.list` page past the `lanes` topic's 64
       * folders and 1000 lanes. The topic itself keeps those bounds for older clients.
       */
      readonly pagedLanes?: boolean
      /** Effective capabilities for this connection. */
      readonly capabilities: readonly HostCapability[]
    }
  | {
      readonly type: 'auth-renewed'
      readonly brainAccess?: readonly BrainAccess[]
      readonly grantExpiresAt: string
      readonly capabilities?: readonly HostCapability[]
    }
  | {
      readonly type: 'lanes'
      readonly id: string
      readonly cursor: StreamCursor
      readonly repositories: readonly RepositorySummary[]
      readonly lanes: readonly LaneSummary[]
    }
  | {
      readonly type: 'lanes-delta'
      readonly id: string
      readonly cursor: StreamCursor
      readonly upsert: readonly LaneSummary[]
      readonly remove: readonly string[]
    }
  | { readonly type: 'resource-changed'; readonly id: string; readonly change: HostResourceChange }
  | { readonly type: 'routines-changed'; readonly id: string; readonly cursor: StreamCursor }
  | {
      readonly type: 'attention'
      readonly id: string
      readonly cursor: StreamCursor
      readonly event: AttentionEvent
    }
  | {
      readonly type: 'snapshot'
      readonly id: string
      readonly laneId: string
      /** True when it replaces state the client already had. */
      readonly reset: boolean
      readonly snapshot: LaneSnapshot
    }
  | {
      readonly type: 'event'
      readonly id: string
      readonly laneId: string
      readonly cursor: StreamCursor
      readonly event: LaneEvent
    }
  | {
      readonly type: 'subscribe-failed'
      readonly id: string
      readonly code: 'unknown-lane' | 'too-many' | 'forbidden' | 'bad-request' | 'too-large'
    }
  | { readonly type: 'receipt'; readonly receipt: Receipt }
  | { readonly type: 'result'; readonly id: string; readonly ok: true; readonly data: unknown }
  | { readonly type: 'result'; readonly id: string; readonly ok: false; readonly error: CallError }
  /** Sent just before the Host closes the socket with a 44xx code. */
  | { readonly type: 'error'; readonly code: HostCloseCode; readonly message: string }
  | { readonly type: 'pong'; readonly at: number }

export interface FrameSocket {
  send(text: string): void
  close(code: number, reason: string): void
  onMessage(cb: (text: string) => void): void
  onClose(cb: (code: number, reason: string) => void): void
  isOpen(): boolean
  bufferedBytes(): number
}

export type ClientFrameParse =
  | { ok: true; frame: ClientFrame }
  | {
      ok: false
      reason: string
      reply?:
        | { kind: 'receipt'; requestId: string; code: 'unsupported' | 'bad-request' }
        | { kind: 'result'; id: string; code: 'bad-request' }
    }
