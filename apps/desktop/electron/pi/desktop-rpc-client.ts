import {
  PiRpcClient as CorePiRpcClient,
  type PiSpawnOptions,
} from '@phosphor/session-runtime/pi/rpc-client'
import { log } from '../debug-log'
import { shutdownApproval } from '../shutdown-approval'

/** Desktop environment adapter. The RPC transport itself has no Electron dependency. */
export class PiRpcClient extends CorePiRpcClient {
  constructor(options: PiSpawnOptions) {
    super(options, { log, isClosing: () => shutdownApproval.closing })
  }
}
