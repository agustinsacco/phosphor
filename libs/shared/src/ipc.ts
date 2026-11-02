/**
 * Typed IPC contract between main and renderer.
 *
 * Request/response methods use `ipcRenderer.invoke` on the channels in
 * `IpcInvokeMap`. Streams are pushed from main on per-session channels
 * (`pi:event:<sessionId>`) declared by `sessionEventChannel`.
 */
import type { HostsInvokeMap } from './ipc/hosts'
import type { AppInvokeMap } from './ipc/app'
import type { PiInvokeMap } from './ipc/pi'
import type { ClaudeInvokeMap, AccountInvokeMap, ControlInvokeMap } from './ipc/auth'
import type {
  SkillsInvokeMap,
  PackagesInvokeMap,
  McpInvokeMap,
  ArtifactsInvokeMap,
} from './ipc/resources'
import type { SessionsInvokeMap, GitInvokeMap, GhInvokeMap, FsInvokeMap } from './ipc/workspace'
import type {
  RoutinesInvokeMap,
  MaintenanceInvokeMap,
  HeadroomInvokeMap,
  OptimizationInvokeMap,
  VoiceInvokeMap,
  PtyInvokeMap,
  UpdatesInvokeMap,
  FeedbackInvokeMap,
  ClipboardInvokeMap,
  WritingInvokeMap,
} from './ipc/services'

export type {
  DesktopControlErrorCode,
  ControlResult,
  SessionTreeEntry,
  SessionTree,
  HostLaneView,
  HostConnectionView,
  HostsSnapshot,
  TrafficEntry,
  TrafficPage,
  RemoteLaneCreate,
  RemoteLaneStarted,
  LaneStartView,
  HostAttention,
} from './ipc/views'
export type { PhosphorApi, PhosphorPlatform } from './ipc/api'

export type IpcInvokeMap = HostsInvokeMap &
  AppInvokeMap &
  PiInvokeMap &
  ClaudeInvokeMap &
  AccountInvokeMap &
  ControlInvokeMap &
  SkillsInvokeMap &
  PackagesInvokeMap &
  McpInvokeMap &
  ArtifactsInvokeMap &
  SessionsInvokeMap &
  GitInvokeMap &
  GhInvokeMap &
  FsInvokeMap &
  RoutinesInvokeMap &
  MaintenanceInvokeMap &
  HeadroomInvokeMap &
  OptimizationInvokeMap &
  VoiceInvokeMap &
  PtyInvokeMap &
  UpdatesInvokeMap &
  FeedbackInvokeMap &
  ClipboardInvokeMap &
  WritingInvokeMap

export type IpcInvokeChannel = keyof IpcInvokeMap

export const sessionEventChannel = (sessionId: string): string => `pi:event:${sessionId}`
