import { handle } from './handle'
import { remoteLanes } from './hosts-handlers'
import { isRemoteHandle } from '../hosts/remote-lanes'
import { desktopSessions } from '../pi/session-runtime'
import { cachedPiHealth } from '../pi/health'
import { piStubPath } from '../pi/stub'
import { generateSessionTitle } from '../pi/session-title'
import { MIN_PI_VERSION, type CreateSessionOptions } from '@shared/models'
import type { ExtensionUIResponse, RpcCommand } from '@shared/rpc'
import { log } from '../debug-log'

/** pi subprocess lifecycle: health, session create/dispose, RPC passthrough. */
export function registerPiSessionHandlers(): void {
  handle('pi:health', async () => {
    if (piStubPath()) {
      return {
        ok: true,
        binaryPath: piStubPath(),
        version: MIN_PI_VERSION,
        minVersion: MIN_PI_VERSION,
      }
    }
    const health = await cachedPiHealth()
    // Beside the spawn argv, record WHICH node.exe and entry script the
    // Windows launcher settled on (also asserted by the packaged-app smoke).
    const { message: _message, ...facts } = health
    log('pi', 'health', facts)
    return health
  })

  handle('pi:createSession', (event, options: CreateSessionOptions) =>
    desktopSessions.create(options, event.sender),
  )
  handle('pi:command', (event, sessionId: string, command: RpcCommand) =>
    isRemoteHandle(sessionId)
      ? remoteLanes().command(event.sender.id, sessionId, command)
      : desktopSessions.command(sessionId, command),
  )
  handle('pi:extensionUiResponse', (event, sessionId: string, response: ExtensionUIResponse) =>
    isRemoteHandle(sessionId)
      ? remoteLanes().respond(event.sender.id, sessionId, response)
      : desktopSessions.respond(sessionId, response),
  )
  handle('pi:disposeSession', (event, sessionId: string) =>
    isRemoteHandle(sessionId)
      ? remoteLanes().dispose(event.sender.id, sessionId)
      : desktopSessions.dispose(sessionId),
  )
  handle('pi:listLiveSessions', (event) => [
    ...desktopSessions.list(),
    ...remoteLanes().list(event.sender.id),
  ])

  handle(
    'pi:generateTitle',
    (_event, workspacePath: string, message: string, existingNames: string[]) =>
      generateSessionTitle(workspacePath, message, existingNames),
  )
}
