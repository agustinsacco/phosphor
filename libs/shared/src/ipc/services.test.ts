import { expectTypeOf, it } from 'vitest'
import type { IpcInvokeMap } from '../ipc'
import type { EditCommand, WritingPrefs } from '../writing'
import type {
  RoutineCheck,
  RoutineInput,
  RoutineLaneIndex,
  RoutineRun,
  RoutinesSnapshot,
} from '../routines'
import type { FeedbackDraft, FeedbackState, FeedbackSubmitResult } from '../feedback'
import type { VoicePrefs, VoiceStatus } from '../voice'
import type {
  MaintenancePrefs,
  MaintenanceReport,
  HeadroomStatus,
  OptimizationStats,
  UpdateState,
} from '../models'
export interface BaselineRoutinesInvokeMap {
  'routines:list': { args: [machine?: string]; result: RoutinesSnapshot }

  'routines:save': {
    args: [
      input: RoutineInput & { repositoryId?: string },
      id?: string,
      revision?: number,
      machine?: string,
    ]
    result: void
  }

  'routines:check': { args: [input: RoutineInput]; result: RoutineCheck }

  'routines:history': { args: [routineId: string, offset: number]; result: RoutineRun[] }

  'routines:laneIndex': { args: []; result: RoutineLaneIndex }

  'routines:promoteRun': { args: [runId: string]; result: void }

  'routines:run': { args: [routineId: string, requestId: string]; result: RoutineRun }

  'routines:cancel': { args: [runId: string]; result: void }

  'routines:skipNext': { args: [routineId: string]; result: void }

  'routines:archive': { args: [routineId: string]; result: void }

  /** Removes the routine and its history; trashes lanes it still owns. */
  'routines:delete': { args: [routineId: string]; result: void }

  'routines:pauseAll': { args: [machine?: string]; result: void }

  'routines:background': { args: [enabled: boolean]; result: void }
}
export interface BaselineMaintenanceInvokeMap {
  /**
   * Measure what the janitor could reclaim, one report per workspace the
   * scheduled sweep covers (the recent-workspace list). Never deletes.
   * `maintenance:run` is what deletes, and it still obeys the same policy —
   * the button cannot reclaim anything a sweep would have held.
   */
  'maintenance:scan': { args: []; result: MaintenanceReport[] }

  'maintenance:run': { args: []; result: MaintenanceReport[] }

  'maintenance:setPrefs': { args: [MaintenancePrefs]; result: void }
}
export interface BaselineHeadroomInvokeMap {
  // ---- Optimization (Settings → Optimization) ----
  /** Headroom install/proxy state. Read-only; probes /health, spawns nothing. */
  'headroom:status': { args: []; result: HeadroomStatus }

  /** Persist the flag; on enable, bring the proxy up (adopt or spawn). */
  'headroom:setEnabled': { args: [enabled: boolean]; result: HeadroomStatus }

  'headroom:start': { args: []; result: HeadroomStatus }

  /** Stops only a proxy Phosphor spawned; an adopted proxy is left alone. */
  'headroom:stop': { args: []; result: HeadroomStatus }

  /** Guided install as a streamed job on the `packages:output/exit` channels. */
  'headroom:install': { args: []; result: { jobId: string } }
}
export interface BaselineOptimizationInvokeMap {
  /** Folded savings + Advisor findings for one workspace. Read-only. */
  'optimization:stats': { args: [workspacePath: string]; result: OptimizationStats }
}
export interface BaselineVoiceInvokeMap {
  // ---- Voice input (Settings → Voice, docs/voice.md) ----
  'voice:status': { args: []; result: VoiceStatus }

  /**
   * Persist the prefs. Enabled downloads the selected model when it is not on
   * disk yet (progress on `voice:statusChanged`); disabled deletes every
   * model file.
   */
  'voice:setPrefs': { args: [prefs: VoicePrefs]; result: VoiceStatus }

  /**
   * Begin a dictation for this window, loading the model if it is not
   * resident. Rejects when voice is not ready or the microphone is refused.
   * One dictation at a time: a new one cancels the last.
   */
  'voice:start': { args: []; result: void }

  /** 16 kHz mono samples for the running dictation; ignored from any other window. */
  'voice:audio': { args: [samples: Float32Array]; result: void }

  /** End the dictation and return everything it heard. */
  'voice:stop': { args: []; result: { text: string } }

  'voice:cancel': { args: []; result: void }
}
export interface BaselinePtyInvokeMap {
  'pty:create': {
    /**
     * `sessionId` is the OWNING chat session. Main needs it to attribute a
     * terminal's process tree (a build, a test run, a dev server) to that
     * session in the resource monitor; without it that mapping lives only in
     * the renderer's terminal store and main cannot see it.
     */
    args: [workspacePath: string, cols: number, rows: number, sessionId?: string]
    result: { ptyId: string }
  }

  /**
   * Recent output for a view that is (re)binding to an already-live PTY —
   * closing the terminal pane disposes the xterm but keeps the shell, so
   * without a replay reopening shows a blank pane in front of a running
   * shell. See `PtyManager.attach` for why this needs no de-duplication.
   */
  'pty:attach': { args: [ptyId: string]; result: { scrollback: string } }

  'pty:write': { args: [ptyId: string, data: string]; result: void }

  'pty:resize': { args: [ptyId: string, cols: number, rows: number]; result: void }

  'pty:kill': { args: [ptyId: string]; result: void }
}
export interface BaselineUpdatesInvokeMap {
  /**
   * Auto-update. Checks are driven by main on a timer; the renderer only reads
   * state and asks for the install. Installing is ALWAYS user-initiated.
   */
  'updates:state': { args: []; result: UpdateState }

  'updates:check': { args: []; result: void }

  'updates:restartAndInstall': { args: []; result: void }
}
export interface BaselineFeedbackInvokeMap {
  /**
   * App rating and feedback, filed as a GitHub issue. Main owns the network
   * leg because the relay path is a request and the browser path is
   * `shell.openExternal` — neither belongs in a sandboxed renderer.
   */
  'feedback:state': { args: []; result: FeedbackState }

  'feedback:submit': { args: [draft: FeedbackDraft]; result: FeedbackSubmitResult }

  /** Records the one-time "not now"; the nudge never returns after it. */
  'feedback:dismiss': { args: []; result: void }
}
export interface BaselineClipboardInvokeMap {
  /**
   * Put an image on the system clipboard (base64 payload).
   *
   * The renderer is sandboxed and cannot reach Electron's clipboard itself,
   * and the web `ClipboardItem` API accepts png/jpeg only — pi's image set
   * also carries gif/webp/bmp, so the write happens in main, where
   * `nativeImage` sniffs the buffer and accepts all five.
   */
  'clipboard:writeImage': { args: [image: { data: string; mimeType: string }]; result: void }

  /**
   * The clipboard's image as base64 PNG, or null when it holds none. For the
   * image annotator's Paste/Replace buttons: a button click has no paste
   * event, and the sandboxed renderer cannot read the clipboard itself.
   */
  'clipboard:readImage': { args: []; result: { data: string; mimeType: string } | null }

  'clipboard:writeFiles': { args: [paths: string[], cut: boolean]; result: void }

  'clipboard:readFiles': { args: []; result: { paths: string[]; cut: boolean } }
}
export interface BaselineWritingInvokeMap {
  /** Saves Settings → Writing and applies the spellchecker switch to the window. */
  'writing:setPrefs': { args: [prefs: WritingPrefs]; result: void }

  /**
   * Runs an edit command on the sender's focused field, the way the Edit menu
   * does. The text-field menu needs it for Paste: the sandboxed renderer cannot
   * read the clipboard, and this path still fires the field's paste event.
   */
  'writing:edit': { args: [command: EditCommand]; result: void }

  /** Adds a word to the spellchecker's dictionary (the OS one on macOS/Windows). */
  'writing:learnWord': { args: [word: string]; result: boolean }

  /** Prompts kept to learn from, oldest first. */
  'writing:prompts': { args: []; result: string[] }

  /** Keep one sent prompt to learn from. Main drops what `isLearnablePrompt` rejects. */
  'writing:recordPrompt': { args: [text: string]; result: void }

  /** Forget every learned prompt. */
  'writing:clearPrompts': { args: []; result: void }
}
it('freezes routines, maintenance, headroom, optimization, voice, pty, updates, feedback, clipboard, writing channel tuples and results through ipc.ts', () => {
  expectTypeOf<
    Pick<IpcInvokeMap, keyof BaselineRoutinesInvokeMap>
  >().toEqualTypeOf<BaselineRoutinesInvokeMap>()
  expectTypeOf<
    Pick<IpcInvokeMap, keyof BaselineMaintenanceInvokeMap>
  >().toEqualTypeOf<BaselineMaintenanceInvokeMap>()
  expectTypeOf<
    Pick<IpcInvokeMap, keyof BaselineHeadroomInvokeMap>
  >().toEqualTypeOf<BaselineHeadroomInvokeMap>()
  expectTypeOf<
    Pick<IpcInvokeMap, keyof BaselineOptimizationInvokeMap>
  >().toEqualTypeOf<BaselineOptimizationInvokeMap>()
  expectTypeOf<
    Pick<IpcInvokeMap, keyof BaselineVoiceInvokeMap>
  >().toEqualTypeOf<BaselineVoiceInvokeMap>()
  expectTypeOf<
    Pick<IpcInvokeMap, keyof BaselinePtyInvokeMap>
  >().toEqualTypeOf<BaselinePtyInvokeMap>()
  expectTypeOf<
    Pick<IpcInvokeMap, keyof BaselineUpdatesInvokeMap>
  >().toEqualTypeOf<BaselineUpdatesInvokeMap>()
  expectTypeOf<
    Pick<IpcInvokeMap, keyof BaselineFeedbackInvokeMap>
  >().toEqualTypeOf<BaselineFeedbackInvokeMap>()
  expectTypeOf<
    Pick<IpcInvokeMap, keyof BaselineClipboardInvokeMap>
  >().toEqualTypeOf<BaselineClipboardInvokeMap>()
  expectTypeOf<
    Pick<IpcInvokeMap, keyof BaselineWritingInvokeMap>
  >().toEqualTypeOf<BaselineWritingInvokeMap>()
})

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
} from './services'

it('keeps routines leaf exact and confined to its prefix', () => {
  expectTypeOf<RoutinesInvokeMap>().toEqualTypeOf<BaselineRoutinesInvokeMap>()
  expectTypeOf<keyof RoutinesInvokeMap>().toEqualTypeOf<
    Extract<keyof IpcInvokeMap, `routines:${string}`>
  >()
})

it('keeps maintenance leaf exact and confined to its prefix', () => {
  expectTypeOf<MaintenanceInvokeMap>().toEqualTypeOf<BaselineMaintenanceInvokeMap>()
  expectTypeOf<keyof MaintenanceInvokeMap>().toEqualTypeOf<
    Extract<keyof IpcInvokeMap, `maintenance:${string}`>
  >()
})

it('keeps headroom leaf exact and confined to its prefix', () => {
  expectTypeOf<HeadroomInvokeMap>().toEqualTypeOf<BaselineHeadroomInvokeMap>()
  expectTypeOf<keyof HeadroomInvokeMap>().toEqualTypeOf<
    Extract<keyof IpcInvokeMap, `headroom:${string}`>
  >()
})

it('keeps optimization leaf exact and confined to its prefix', () => {
  expectTypeOf<OptimizationInvokeMap>().toEqualTypeOf<BaselineOptimizationInvokeMap>()
  expectTypeOf<keyof OptimizationInvokeMap>().toEqualTypeOf<
    Extract<keyof IpcInvokeMap, `optimization:${string}`>
  >()
})

it('keeps voice leaf exact and confined to its prefix', () => {
  expectTypeOf<VoiceInvokeMap>().toEqualTypeOf<BaselineVoiceInvokeMap>()
  expectTypeOf<keyof VoiceInvokeMap>().toEqualTypeOf<
    Extract<keyof IpcInvokeMap, `voice:${string}`>
  >()
})

it('keeps pty leaf exact and confined to its prefix', () => {
  expectTypeOf<PtyInvokeMap>().toEqualTypeOf<BaselinePtyInvokeMap>()
  expectTypeOf<keyof PtyInvokeMap>().toEqualTypeOf<Extract<keyof IpcInvokeMap, `pty:${string}`>>()
})

it('keeps updates leaf exact and confined to its prefix', () => {
  expectTypeOf<UpdatesInvokeMap>().toEqualTypeOf<BaselineUpdatesInvokeMap>()
  expectTypeOf<keyof UpdatesInvokeMap>().toEqualTypeOf<
    Extract<keyof IpcInvokeMap, `updates:${string}`>
  >()
})

it('keeps feedback leaf exact and confined to its prefix', () => {
  expectTypeOf<FeedbackInvokeMap>().toEqualTypeOf<BaselineFeedbackInvokeMap>()
  expectTypeOf<keyof FeedbackInvokeMap>().toEqualTypeOf<
    Extract<keyof IpcInvokeMap, `feedback:${string}`>
  >()
})

it('keeps clipboard leaf exact and confined to its prefix', () => {
  expectTypeOf<ClipboardInvokeMap>().toEqualTypeOf<BaselineClipboardInvokeMap>()
  expectTypeOf<keyof ClipboardInvokeMap>().toEqualTypeOf<
    Extract<keyof IpcInvokeMap, `clipboard:${string}`>
  >()
})

it('keeps writing leaf exact and confined to its prefix', () => {
  expectTypeOf<WritingInvokeMap>().toEqualTypeOf<BaselineWritingInvokeMap>()
  expectTypeOf<keyof WritingInvokeMap>().toEqualTypeOf<
    Extract<keyof IpcInvokeMap, `writing:${string}`>
  >()
})

import type { HostsInvokeMap } from './hosts'
import type { AppInvokeMap } from './app'
import type { PiInvokeMap } from './pi'
import type { ClaudeInvokeMap, AccountInvokeMap, ControlInvokeMap } from './auth'
import type {
  SkillsInvokeMap,
  PackagesInvokeMap,
  McpInvokeMap,
  ArtifactsInvokeMap,
} from './resources'
import type { SessionsInvokeMap, GitInvokeMap, GhInvokeMap, FsInvokeMap } from './workspace'

// A duplicate is rejected even when its argument and result types agree.
type MapKeys = [
  keyof HostsInvokeMap,
  keyof AppInvokeMap,
  keyof PiInvokeMap,
  keyof ClaudeInvokeMap,
  keyof AccountInvokeMap,
  keyof ControlInvokeMap,
  keyof SkillsInvokeMap,
  keyof PackagesInvokeMap,
  keyof McpInvokeMap,
  keyof ArtifactsInvokeMap,
  keyof SessionsInvokeMap,
  keyof GitInvokeMap,
  keyof GhInvokeMap,
  keyof FsInvokeMap,
  keyof RoutinesInvokeMap,
  keyof MaintenanceInvokeMap,
  keyof HeadroomInvokeMap,
  keyof OptimizationInvokeMap,
  keyof VoiceInvokeMap,
  keyof PtyInvokeMap,
  keyof UpdatesInvokeMap,
  keyof FeedbackInvokeMap,
  keyof ClipboardInvokeMap,
  keyof WritingInvokeMap,
]
type OverlappingKeys<Keys extends readonly PropertyKey[]> = Keys extends readonly [
  infer First extends PropertyKey,
  ...infer Rest extends PropertyKey[],
]
  ? Extract<First, Rest[number]> | OverlappingKeys<Rest>
  : never
it('composes disjoint prefix maps with no missing channels', () => {
  expectTypeOf<OverlappingKeys<MapKeys>>().toEqualTypeOf<never>()
  expectTypeOf<MapKeys[number]>().toEqualTypeOf<keyof IpcInvokeMap>()
})
