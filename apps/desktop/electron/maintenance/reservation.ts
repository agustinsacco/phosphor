import { sessionPathKey } from '@phosphor/session-runtime/pi/session-path-lock'
import { WorkspaceLeaseRefused, withWorkspaceLease } from '../local-machine/lease'
import { localRuntimeMode } from '../local-machine/mode'
import { sameMachine } from '../local-machine/same-machine'
import { registry } from '../registry'

/**
 * Who may be running lanes in a checkout Desktop is about to change. In-app,
 * Desktop's own session registry, as always. In daemon mode the registry is
 * empty: This Mac's service runs the lanes, so its projection says which are
 * live and a workspace lease (`local-machine/lease.ts`) keeps new ones out.
 */

const LIVE = new Set(['idle', 'working', 'needs-input'])

/**
 * Every live lane's folder: in-app, the registry's sessions; in daemon mode,
 * the service's lanes with a running pi. Undefined in daemon mode while the
 * service is not connected, so callers fail closed.
 */
export function liveLanePaths(): string[] | undefined {
  if (localRuntimeMode() !== 'daemon') return registry.list().map((s) => s.workspacePath)
  return sameMachine()
    ?.lanes.filter((lane) => LIVE.has(lane.activity))
    .map((lane) => lane.cwd)
}

/** True when a live lane runs in `path`, and in daemon mode while the service is not connected. */
export function workspaceHasLiveLane(path: string): boolean {
  const live = liveLanePaths()
  if (!live) return true
  const key = sessionPathKey(path)
  return live.some((cwd) => sessionPathKey(cwd) === key)
}

/**
 * Runs `run` with `path` kept free of new lanes. `free()` is what the caller
 * checks before it changes anything. In-app it is the registry check, as
 * before. In daemon mode the work runs inside a workspace lease, which the
 * service refuses over a live lane (that refusal reads as `live`), and
 * `free()` turns false only if the lease is lost.
 */
export async function reserveWorkspace<T>(
  path: string,
  live: string,
  run: (free: () => boolean) => Promise<T>,
): Promise<T> {
  if (localRuntimeMode() !== 'daemon') return run(() => !workspaceHasLiveLane(path))
  try {
    return await withWorkspaceLease([path], (lease) => run(() => lease.held()))
  } catch (error) {
    if (error instanceof WorkspaceLeaseRefused && error.refusal === 'live-lane')
      throw new Error(live)
    throw error
  }
}
