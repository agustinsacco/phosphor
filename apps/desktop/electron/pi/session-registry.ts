import { SessionRegistry as CoreSessionRegistry } from '@phosphor/session-runtime/pi/session-registry'
import { PiRpcClient } from './desktop-rpc-client'
import { shutdownApproval } from '../shutdown-approval'

/** Desktop bindings. electron/registry.ts remains the only live desktop registry. */
export class SessionRegistry extends CoreSessionRegistry {
  constructor() {
    super({
      createClient: (options) => new PiRpcClient(options),
      assertCanStart: () => shutdownApproval.assertCanStart(),
    })
  }
}
