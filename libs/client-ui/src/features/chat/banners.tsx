import { usePlatform } from '@/platform/Platform'
import { TooltipButton } from '@/components/Tooltip'
import { useMemo } from 'react'
import type { SessionMeta } from '@shared/models'
import { useChatStore } from '@/stores/chat'
import { useSessionsStore } from '@/stores/sessions'
import { machineLabel } from '@/stores/remoteLanes'
import { useLaneControl } from '@/features/machines/useLaneControl'
import { ModelActionButtons } from './composer/ModelActionButtons'
import { useSessionModelActions } from './composer/useSessionModelActions'
import { MODELS_READ_FAILED } from '@/stores/machineCatalogues'
import { sessionTitle } from '@/lib/sessionTitle'
import {
  latestRewoundVersion,
  presentSessionFiles,
  sessionFileName,
} from '@/features/sessions/rewound'

/** Inline banners: pi crashed, no models configured, and an old version of a rewound chat. */

/** A crashed lane: what pi said, how to bring it back, and why this window may not. */
interface Crash {
  message: string
  resume: () => Promise<unknown>
  blocked: string | undefined
  error: string | null
}

/**
 * This Mac's session learns of the crash from its own process exit; a Host lane
 * from the Host, as `activity: 'failed'`, and resumes there under lane control.
 */
function useCrash(sessionId: string, workspacePath: string): Crash | null {
  const error = useChatStore((s) => s.sessions[sessionId]?.error)
  const entry = useSessionsStore((s) => s.live[sessionId])
  const control = useLaneControl(sessionId)
  if (control) {
    if (control.activity !== 'failed') return null
    return {
      message: `pi exited unexpectedly on ${machineLabel(control.hostId)}. The session file is preserved.`,
      resume: () => control.act('hosts:resumeLane'),
      blocked: control.busy ? 'Resuming…' : control.hint,
      error: control.error,
    }
  }
  if (!error || !error.includes('exited unexpectedly')) return null
  const resume = async (): Promise<void> => {
    const store = useSessionsStore.getState()
    await store.disposeSession(sessionId)
    const diskPath = entry?.diskPath
    if (diskPath) {
      const metas = await window.phosphor.invoke('sessions:list', workspacePath)
      const meta = metas.find((m) => m.path === diskPath)
      if (meta) {
        await store.openDiskSession(workspacePath, meta)
        return
      }
    }
    await store.createSession(workspacePath)
  }
  return { message: error, resume, blocked: undefined, error: null }
}

export function CrashBanner({
  sessionId,
  workspacePath,
}: {
  sessionId: string
  workspacePath: string
}): React.JSX.Element | null {
  const crash = useCrash(sessionId, workspacePath)
  if (!crash) return null
  return (
    <div className="mx-auto w-full max-w-3xl px-6 pt-2">
      <div className="bg-danger-soft border-danger/25 flex items-center gap-3 rounded-lg border px-3.5 py-2.5">
        <span className="text-danger text-lg font-medium">pi crashed</span>
        <span className="text-text-secondary flex-1 truncate text-base">
          {crash.error ?? crash.message}
        </span>
        <TooltipButton
          onClick={() => void crash.resume()}
          disabled={crash.blocked !== undefined}
          tooltip={crash.blocked}
          className="bg-accent hover:bg-accent-hover text-accent-text shrink-0 rounded-md px-2.5 py-1 text-sm font-medium transition-colors disabled:opacity-50"
        >
          Resume session
        </TooltipButton>
      </div>
    </div>
  )
}

/** No models, or a failed read of them: the start picker's actions, and pi's terminal on This Mac. */
export function NoModelsBanner({ sessionId }: { sessionId: string }): React.JSX.Element | null {
  const platform = usePlatform()
  const meta = useChatStore((s) => s.sessions[sessionId]?.meta)
  const models = useChatStore((s) => s.sessions[sessionId]?.models)
  const failed = useChatStore((s) => s.sessions[sessionId]?.modelsFailed ?? false)
  const lanePath = useSessionsStore((s) => s.live[sessionId]?.workspacePath)
  const { machine, actions } = useSessionModelActions(sessionId)
  if (!meta || models === undefined || models === null) return null
  if (models.length > 0) return null
  const workspacePath = machine === 'local' ? lanePath : undefined

  return (
    <div className="mx-auto w-full max-w-3xl px-6 pt-2">
      <div className="bg-warning/10 border-warning/30 rounded-lg border px-4 py-3 text-lg">
        <div className="flex items-center gap-3">
          <div className="text-text flex-1 font-medium">
            {failed ? MODELS_READ_FAILED : 'No models configured'}
          </div>
          <ModelActionButtons actions={actions} />
          {workspacePath && platform.terminal && (
            <TooltipButton
              onClick={() => {
                void import('@/stores/terminal').then(({ runInTerminal }) =>
                  runInTerminal(workspacePath, 'pi'),
                )
              }}
              className="bg-accent hover:bg-accent-hover text-accent-text shrink-0 rounded-md px-2.5 py-1 text-sm font-medium transition-colors"
            >
              Open terminal with `pi`
            </TooltipButton>
          )}
        </div>
        {!failed && (
          <div className="text-text-secondary mt-1 leading-relaxed">
            Sign in to a provider, set an API key env var (e.g.{' '}
            <code className="bg-code-bg rounded px-1 font-mono text-base">ANTHROPIC_API_KEY</code>),
            or add a custom endpoint in{' '}
            <code className="bg-code-bg rounded px-1 font-mono text-base">
              ~/.pi/agent/models.json
            </code>
            .
          </div>
        )}
      </div>
    </div>
  )
}

/**
 * This file is what a chat looked like before a rewind, and the chat carries
 * on in another file.
 *
 * The sidebar folds such a file away, but it can still be opened from the
 * command palette, a pin or a restored last session. Without this banner it
 * looked exactly like the live chat: a user typed "continue" into one, and a
 * second agent started working in the same worktree as the first.
 */
export function RewoundBanner({ sessionId }: { sessionId: string }): React.JSX.Element | null {
  const diskPath = useSessionsStore((s) => s.live[sessionId]?.diskPath)
  const rewound = useSessionsStore((s) => s.rewound)
  const disk = useSessionsStore((s) => s.disk)
  const live = useSessionsStore((s) => s.live)
  const successor = useMemo(() => {
    if (!diskPath) return null
    const liveByName = new Map<string, string>()
    for (const entry of Object.values(live)) {
      if (entry.diskPath) liveByName.set(sessionFileName(entry.diskPath), entry.phosphorId)
    }
    const latest = latestRewoundVersion(
      rewound,
      diskPath,
      presentSessionFiles(
        disk,
        Object.values(live).map((entry) => entry.diskPath),
      ),
    )
    if (!latest) return null
    let found: { workspacePath: string; meta: SessionMeta } | undefined
    for (const [workspacePath, metas] of Object.entries(disk)) {
      const meta = metas.find((m) => sessionFileName(m.path) === latest)
      if (meta) found = { workspacePath, meta }
    }
    return { ...found, livePhosphorId: liveByName.get(latest) }
  }, [diskPath, rewound, disk, live])
  // A live version's title leads its file by a whole turn (docs/pi-integration.md).
  const liveName = useChatStore((s) =>
    successor?.livePhosphorId ? s.sessions[successor.livePhosphorId]?.meta?.sessionName : undefined,
  )
  if (!successor) return null

  const { workspacePath, meta, livePhosphorId } = successor
  const name =
    sessionTitle({ explicitName: liveName ?? meta?.name, firstUserText: meta?.firstUserText }) ??
    'its newer version'
  const open = (): void => {
    const store = useSessionsStore.getState()
    if (livePhosphorId) store.activate(livePhosphorId)
    else if (meta && workspacePath) void store.openDiskSession(workspacePath, meta).catch(() => {})
  }
  return (
    <div className="mx-auto w-full max-w-3xl px-6 pt-2" data-testid="rewound-banner">
      <div className="bg-warning/10 border-warning/30 text-text-secondary rounded-lg border px-3.5 py-2.5 text-base">
        This is the chat before a rewind. It continues in{' '}
        {/* Body-coloured, not accent: the accent link measured 3.96:1 on this
            tint in the light theme, under the 4.5:1 minimum for text. */}
        <TooltipButton
          onClick={open}
          className="text-text hover:text-accent font-medium underline underline-offset-2"
        >
          {name}
        </TooltipButton>
        .
      </div>
    </div>
  )
}
