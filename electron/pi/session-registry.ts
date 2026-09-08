import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { PiRpcClient, type PiSpawnOptions } from './rpc-client'
import type { LiveSessionInfo } from '@shared/models'

export interface LiveSession {
  sessionId: string
  workspacePath: string
  client: PiRpcClient
}

interface SessionRegistryEvents {
  created: [LiveSession]
  disposed: [{ sessionId: string }]
}

/**
 * Registry of live pi subprocesses, keyed by a phosphor-side session id.
 * The single source of truth for what's running; renderer stores are
 * projections fed over IPC.
 *
 * It emits `created` / `disposed` so cross-session observers can attach
 * without every creation path having to remember to tell them. Putting that
 * here rather than in the IPC handler is what makes a future second creation
 * path (a CLI entry point, say) visible to them for free.
 */
export class SessionRegistry extends EventEmitter<SessionRegistryEvents> {
  private readonly sessions = new Map<string, LiveSession>()

  create(workspacePath: string, spawnOptions: Omit<PiSpawnOptions, 'cwd'>): LiveSession {
    const sessionId = randomUUID()
    const client = new PiRpcClient({ ...spawnOptions, cwd: workspacePath })
    const session: LiveSession = { sessionId, workspacePath, client }
    this.sessions.set(sessionId, session)

    // No 'exit' listener on purpose: the entry outlives the child process so the
    // renderer can observe a crash and offer resume. dispose() removes it.

    client.spawn()
    // After spawn, so a listener that immediately sends RPC has a live process.
    this.emit('created', session)
    return session
  }

  get(sessionId: string): LiveSession | undefined {
    return this.sessions.get(sessionId)
  }

  list(): LiveSessionInfo[] {
    return [...this.sessions.values()].map((s) => ({
      sessionId: s.sessionId,
      workspacePath: s.workspacePath,
      pid: s.client.pid,
    }))
  }

  async dispose(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (!session) return
    this.sessions.delete(sessionId)
    this.emit('disposed', { sessionId })
    await session.client.dispose()
  }

  async disposeAll(): Promise<void> {
    const all = [...this.sessions.keys()]
    await Promise.allSettled(all.map((id) => this.dispose(id)))
  }

  /**
   * Synchronous SIGTERM to every child, for signal-initiated shutdown
   * (Ctrl-C in dev) where awaiting exits would lose the race with the
   * parent process going away.
   */
  killAllSync(): void {
    for (const session of this.sessions.values()) session.client.killNow()
    this.sessions.clear()
  }
}
