import { create } from 'zustand'
import { drop, keyedSlice } from './keyedSlice'
import { useLayoutStore } from './layout'
import { useSessionsStore } from './sessions'
import { ensureSessionControl, laneControlPolicy } from '@/platform/serviceLaneControl'
import { useRemoteLanesStore, canControlSession, sessionHostLane } from './remoteLanes'
import { hostFeatureRefusal } from './hostRefusals'
import { ipcErrorText } from '@shared/errors'
import type { HostsSnapshot } from '@shared/ipc'
import type { LiveSessionInfo } from '@shared/models'

export interface TerminalTab {
  ptyId: string
  title: string
  exited: boolean
  /** A foreground process (npm, vim, …) is running in this shell. */
  running: boolean
}

/**
 * Where a terminal pane's shells come from. A lane owns its shells in its own
 * directory; a machine owns one shared shell in the account's home folder,
 * outside any lane. Both are stored under `terminalOwner(target)`.
 *
 * `refusal` is the machine's, not the store's: only the Machines pages know the
 * machine's label and whether this device may open its shell.
 */
export type TerminalTarget =
  | { kind: 'lane'; sessionId: string; workspacePath: string }
  | { kind: 'machine'; hostId: string; refusal: string | null }

/** A lane's target. */
export function laneTarget(sessionId: string, workspacePath: string): TerminalTarget {
  return { kind: 'lane', sessionId, workspacePath }
}

/** A machine's shared shell. */
export function machineTarget(hostId: string, refusal: string | null): TerminalTarget {
  return { kind: 'machine', hostId, refusal }
}

/** Machine shells share the store with lane shells, under a key no session id takes. */
const MACHINE_OWNER_PREFIX = 'machine:'

export function terminalOwner(target: TerminalTarget): string {
  return target.kind === 'lane' ? target.sessionId : MACHINE_OWNER_PREFIX + target.hostId
}

/** Whether a store key belongs to a machine rather than to a lane. */
export function isMachineOwner(owner: string): boolean {
  return owner.startsWith(MACHINE_OWNER_PREFIX)
}

/**
 * Terminals for ONE owner, mirroring how artifacts are scoped: each chat
 * session owns its shells (spawned in the session's cwd, which for worktree
 * sessions is the worktree). Switching sessions swaps which set is shown
 * without killing the PTYs; disposing the session kills them.
 */
interface OwnerTerminals {
  tabs: TerminalTab[]
  activeId: string | null
  /**
   * Why the last spawn failed, or null. A shell that cannot start is the one
   * terminal failure a user can actually do something about (wrong cwd, a
   * broken node-pty install), so it has to reach the pane instead of being
   * swallowed by the fire-and-forget spawn on first open.
   */
  error: string | null
}

/**
 * Slice helpers over `byOwner`. The empty value is shared and frozen, so
 * selectors don't allocate a new object per render.
 */
const terminals = keyedSlice<OwnerTerminals>({
  tabs: [],
  activeId: null,
  error: null,
})

interface TerminalState {
  /** Owner key (a lane session id, or a machine's key) → that owner's tabs. */
  byOwner: Record<string, OwnerTerminals>
  /** Text waiting to be pasted into the active terminal once it exists. */
  pendingPaste: { ptyId: string; text: string; execute: boolean } | null

  createTab: (target: TerminalTarget) => Promise<string | null>
  closeTab: (owner: string, ptyId: string) => Promise<void>
  renameTab: (owner: string, ptyId: string, title: string) => void
  setActive: (owner: string, ptyId: string) => void
  /** ptyIds are globally unique, so exit/status updates locate their owner. */
  markExited: (ptyId: string) => void
  applyStatus: (statuses: Record<string, boolean>) => void
  /** Dismiss a spawn error so the pane can go back to trying. */
  clearError: (owner: string) => void
  /** Kill every PTY belonging to a disposed session and drop its state. */
  removeSession: (sessionId: string) => Promise<void>
  queuePaste: (ptyId: string, text: string, execute: boolean) => void
  consumePaste: (ptyId: string) => TerminalState['pendingPaste']
}

/** Terminals for an owner; stable empty value avoids per-render allocation. */
export function ownerTerminals(state: TerminalState, owner: string): OwnerTerminals {
  return terminals.read(state.byOwner, owner)
}

/** Apply a patch to one owner's terminal slice. */
function patchOwner(
  state: TerminalState,
  owner: string,
  update: (current: OwnerTerminals) => OwnerTerminals,
): Pick<TerminalState, 'byOwner'> {
  return { byOwner: terminals.patch(state.byOwner, owner, update) }
}

/**
 * The one place a new shell is born. A lane shell spawns in the lane's own
 * directory and names its session, so main can attribute this shell's process
 * tree (builds, tests, dev servers) to it in the resource monitor; a machine
 * shell is the Host account's login shell in its home, opened by the Host.
 */
async function spawnShell(target: TerminalTarget): Promise<string> {
  if (target.kind === 'machine')
    return (await window.phosphor.invoke('hosts:machineShell', target.hostId, 80, 24)).ptyId
  // Viewers can attach read-only. Claim only on an explicit new shell, not the pane's mount.
  if (terminalAccess(target.sessionId) === 'claimable') await ensureSessionControl(target.sessionId)
  return (
    await window.phosphor.invoke('pty:create', target.workspacePath, 80, 24, target.sessionId)
  ).ptyId
}

export const useTerminalStore = create<TerminalState>((set, get) => ({
  byOwner: {},
  pendingPaste: null,

  createTab: async (target) => {
    const owner = terminalOwner(target)
    let ptyId: string
    try {
      ptyId = await spawnShell(target)
    } catch (error) {
      // Resolve with null rather than rejecting: every caller is a UI action
      // ("+", first open, run-in-terminal) whose only sane response is to show
      // the message, and an unhandled rejection here is exactly how this used
      // to become a permanent "Starting shell…".
      set((s) => patchOwner(s, owner, (t) => ({ ...t, error: ipcErrorText(error) })))
      return null
    }
    set((s) =>
      patchOwner(s, owner, (t) => ({
        error: null,
        // A shared shell answers with its own id: a re-attach, not a second tab.
        tabs: t.tabs.some((tab) => tab.ptyId === ptyId)
          ? t.tabs
          : [
              ...t.tabs,
              { ptyId, title: `Terminal ${t.tabs.length + 1}`, exited: false, running: false },
            ],
        activeId: ptyId,
      })),
    )
    return ptyId
  },

  clearError: (owner) =>
    set((s) => patchOwner(s, owner, (t) => (t.error === null ? t : { ...t, error: null }))),

  closeTab: async (owner, ptyId) => {
    await window.phosphor.invoke('pty:kill', ptyId)
    set((s) =>
      patchOwner(s, owner, (t) => {
        const tabs = t.tabs.filter((tab) => tab.ptyId !== ptyId)
        return {
          ...t,
          tabs,
          activeId: t.activeId === ptyId ? (tabs[tabs.length - 1]?.ptyId ?? null) : t.activeId,
        }
      }),
    )
  },

  renameTab: (owner, ptyId, title) =>
    set((s) =>
      patchOwner(s, owner, (t) => ({
        ...t,
        tabs: t.tabs.map((tab) => (tab.ptyId === ptyId ? { ...tab, title } : tab)),
      })),
    ),

  setActive: (owner, ptyId) => set((s) => patchOwner(s, owner, (t) => ({ ...t, activeId: ptyId }))),

  markExited: (ptyId) =>
    set((s) => ({
      byOwner: Object.fromEntries(
        Object.entries(s.byOwner).map(([owner, t]) => [
          owner,
          t.tabs.some((tab) => tab.ptyId === ptyId)
            ? {
                ...t,
                tabs: t.tabs.map((tab) =>
                  tab.ptyId === ptyId ? { ...tab, exited: true, running: false } : tab,
                ),
              }
            : t,
        ]),
      ),
    })),

  applyStatus: (statuses) =>
    set((s) => ({
      byOwner: Object.fromEntries(
        Object.entries(s.byOwner).map(([owner, t]) => [
          owner,
          t.tabs.some((tab) => statuses[tab.ptyId] !== undefined)
            ? {
                ...t,
                tabs: t.tabs.map((tab) =>
                  statuses[tab.ptyId] !== undefined && tab.running !== statuses[tab.ptyId]
                    ? { ...tab, running: statuses[tab.ptyId] ?? false }
                    : tab,
                ),
              }
            : t,
        ]),
      ),
    })),

  removeSession: async (sessionId) => {
    const tabs = get().byOwner[sessionId]?.tabs ?? []
    await Promise.allSettled(tabs.map((tab) => window.phosphor.invoke('pty:kill', tab.ptyId)))
    set((s) => ({ byOwner: drop(s.byOwner, sessionId) }))
  },

  queuePaste: (ptyId, text, execute) => set({ pendingPaste: { ptyId, text, execute } }),
  consumePaste: (ptyId) => {
    const paste = get().pendingPaste
    if (paste?.ptyId !== ptyId) return null
    set({ pendingPaste: null })
    return paste
  },
}))

// First-open and chat actions share one in-flight spawn per owner.
const openingTabs = new Map<string, Promise<string | null>>()

export function ensureTerminalTab(target: TerminalTarget): Promise<string | null> {
  const owner = terminalOwner(target)
  const pending = openingTabs.get(owner)
  if (pending) return pending
  const store = useTerminalStore.getState()
  const current = ownerTerminals(store, owner)
  const active = current.tabs.find((tab) => tab.ptyId === current.activeId)
  if (active && !active.exited && !active.running) return Promise.resolve(active.ptyId)
  const opening = store.createTab(target).finally(() => openingTabs.delete(owner))
  openingTabs.set(owner, opening)
  return opening
}

/** Count of terminals with a running foreground process, for badges. */
export function runningCount(state: TerminalState, owner: string): number {
  return ownerTerminals(state, owner).tabs.filter((t) => t.running && !t.exited).length
}

/**
 * "Run in terminal" from chat code blocks: open the terminal pane, ensure the
 * active session has a tab, and paste the command. The signature keeps
 * `workspacePath` as the spawn cwd fallback; the owning session is the active
 * one (both callers live in the active chat).
 *
 * Pasting does NOT execute by default — a code block the model wrote is the
 * user's call to review and run. `execute: true` is for commands Phosphor itself
 * proposes (a known remediation with a play button), where the click IS the
 * confirmation.
 */
export async function runInTerminal(
  workspacePath: string,
  command: string,
  options: { execute?: boolean } = {},
): Promise<void> {
  const sessions = useSessionsStore.getState()
  const sessionId = sessions.activeSessionId
  if (!sessionId) return
  const cwd = sessions.live[sessionId]?.workspacePath || workspacePath
  useLayoutStore.getState().setRightPane('terminal', sessionId)
  const ptyId = await ensureTerminalTab(laneTarget(sessionId, cwd))
  if (ptyId === null) return // The pane displays the spawn error.
  // A fence's closing newline is formatting, not permission to run it.
  useTerminalStore.getState().queuePaste(ptyId, command.replace(/[\r\n]+$/, ''), !!options.execute)
}

const targetTerminalRefusal = (
  target: LiveSessionInfo['target'],
  hosts: HostsSnapshot,
): string | undefined =>
  target?.kind === 'remote' ? hostFeatureRefusal(hosts[target.hostId], 'terminal') : undefined

/** Why this device cannot open a shell on the lane's Host, or undefined (This Mac always can). */
export function terminalRefusal(sessionId: string): string | undefined {
  const target = useSessionsStore.getState().live[sessionId]?.target
  return targetTerminalRefusal(target, useRemoteLanesStore.getState().hosts)
}

/** terminalRefusal, re-rendering when the lane's target or its Host changes. */
export function useTerminalRefusal(sessionId: string): string | undefined {
  const target = useSessionsStore((s) => s.live[sessionId]?.target)
  return useRemoteLanesStore((s) => targetTerminalRefusal(target, s.hosts))
}

/** Remote terminals use the same tabs, but never inherit local input authority. */
export function terminalAccess(
  sessionId: string,
): 'control' | 'claimable' | 'viewer' | 'unavailable' {
  if (terminalRefusal(sessionId)) return 'unavailable'
  if (!canControlSession(sessionId)) return 'viewer'
  const remote = sessionHostLane(sessionId)
  return laneControlPolicy(remote?.host?.local, remote?.lane).auto ? 'claimable' : 'control'
}

/** Why this device cannot open shells for this target, or undefined when it can. */
export function targetRefusal(target: TerminalTarget): string | undefined {
  return target.kind === 'machine'
    ? (target.refusal ?? undefined)
    : terminalRefusal(target.sessionId)
}

/**
 * Whether the pane may type. A machine shell has no viewer role: this device
 * either holds `terminal` and `sessions.control` on that Host or is refused.
 */
export function targetAccess(
  target: TerminalTarget,
): 'control' | 'claimable' | 'viewer' | 'unavailable' {
  if (targetRefusal(target)) return 'unavailable'
  return target.kind === 'lane' ? terminalAccess(target.sessionId) : 'control'
}
