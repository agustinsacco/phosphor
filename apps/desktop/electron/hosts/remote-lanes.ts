import { createRemoteLanes as createPortableLanes } from '@phosphor/host-client/remote-lanes'
import { desktopIdentity } from './connection'
export function createRemoteLanes(
  ports: Omit<Parameters<typeof createPortableLanes>[0], 'identity'>,
) {
  return createPortableLanes({ ...ports, identity: desktopIdentity })
}
