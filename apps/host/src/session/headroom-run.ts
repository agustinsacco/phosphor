import { join, basename, dirname } from 'node:path'
import type { RunContext } from '../commands/run'
import type { StartLocalSocket } from '../commands/run-local'
import { hostStateDirectory } from '../lanes/state-dir'
import {
  createLocalSocketStarter,
  localSocketPaths,
  type LocalSocketOptions,
} from '../owner/socket'
import { createHeadroomService } from './headroom'

/** Headless runs never invoke the starter. In standby only the persisted switch is available. */
export function headroomSocketStarter(
  context: RunContext,
  options: LocalSocketOptions = {},
): StartLocalSocket {
  return async (daemon, store) => {
    const candidates = (options.candidates ?? localSocketPaths(context)).map((path) =>
      join(
        dirname(path),
        basename(path) === 'phosphor.sock' ? 'headroom.sock' : `${basename(path, '.sock')}-hr.sock`,
      ),
    )
    const headroom = createHeadroomService({
      directory: hostStateDirectory(context.env, context.home),
      uid: context.uid,
      candidates,
      logFailed: () => context.log?.('host', 'headroom.unavailable', {}),
    })
    const start = createLocalSocketStarter(context, {
      ...options,
      handlers: { ...options.handlers, ...headroom.handlers },
    })
    const socket = await start(daemon, store)
    return {
      ...socket,
      headroom,
      async stop() {
        try {
          await headroom.stop()
        } finally {
          await socket.stop()
        }
      },
    }
  }
}
