import { useChatStore } from '@/stores/chat'
import { useSessionsStore } from '@/stores/sessions'

/** Inline banners: pi crashed, and no models configured. */

export function CrashBanner({
  sessionId,
  workspacePath,
}: {
  sessionId: string
  workspacePath: string
}): React.JSX.Element | null {
  const error = useChatStore((s) => s.sessions[sessionId]?.error)
  const diskPath = useSessionsStore((s) => s.live[sessionId]?.diskPath)
  if (!error || !error.includes('exited unexpectedly')) return null

  const resume = async (): Promise<void> => {
    const store = useSessionsStore.getState()
    await store.disposeSession(sessionId)
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

  return (
    <div className="mx-auto w-full max-w-3xl px-6 pt-2">
      <div className="bg-danger-soft border-danger/25 flex items-center gap-3 rounded-lg border px-3.5 py-2.5">
        <span className="text-danger text-lg font-medium">pi crashed</span>
        <span className="text-text-secondary flex-1 truncate text-base">{error}</span>
        <button
          onClick={() => void resume()}
          className="bg-accent hover:bg-accent-hover text-accent-text shrink-0 rounded-md px-2.5 py-1 text-sm font-medium transition-colors"
        >
          Resume session
        </button>
      </div>
    </div>
  )
}

/** No models configured: hand off to the built-in terminal for `pi` login. */
export function NoModelsBanner({ sessionId }: { sessionId: string }): React.JSX.Element | null {
  const meta = useChatStore((s) => s.sessions[sessionId]?.meta)
  const models = useChatStore((s) => s.sessions[sessionId]?.models)
  const workspacePath = useSessionsStore((s) => s.live[sessionId]?.workspacePath)
  if (!meta || models === undefined || models === null) return null
  if (models.length > 0) return null

  return (
    <div className="mx-auto w-full max-w-3xl px-6 pt-2">
      <div className="bg-warning/10 border-warning/30 rounded-lg border px-4 py-3 text-lg">
        <div className="flex items-center justify-between gap-3">
          <div className="text-text font-medium">No models configured</div>
          {workspacePath && (
            <button
              onClick={() => {
                void import('@/stores/terminal').then(({ runInTerminal }) =>
                  runInTerminal(workspacePath, 'pi'),
                )
              }}
              className="bg-accent hover:bg-accent-hover text-accent-text shrink-0 rounded-md px-2.5 py-1 text-sm font-medium transition-colors"
            >
              Open terminal with `pi`
            </button>
          )}
        </div>
        <div className="text-text-secondary mt-1 leading-relaxed">
          Run <code className="bg-code-bg rounded px-1 font-mono text-base">pi</code> in the
          terminal and use{' '}
          <code className="bg-code-bg rounded px-1 font-mono text-base">/login</code> for OAuth
          providers, set an API key env var (e.g.{' '}
          <code className="bg-code-bg rounded px-1 font-mono text-base">ANTHROPIC_API_KEY</code>),
          or add a custom endpoint in{' '}
          <code className="bg-code-bg rounded px-1 font-mono text-base">
            ~/.pi/agent/models.json
          </code>
          .
        </div>
      </div>
    </div>
  )
}
