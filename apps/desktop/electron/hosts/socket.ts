import { openHostSocket as openPortableSocket } from '@phosphor/host-client/socket'
import type { FrameSocket } from '@shared/host-protocol'
import type { TraceLog } from '../control/observations'

/** Only a dev Desktop may reach the disposable loopback Host. */
export function e2eHostEndpoint(env: NodeJS.ProcessEnv, packaged: boolean): string | undefined {
  if (packaged) return undefined
  const value = env.PHOSPHOR_E2E_HOST_ENDPOINT
  const match = /^https:\/\/127\.0\.0\.1:([1-9][0-9]{3,4})$/.exec(value ?? '')
  return match && Number(match[1]) >= 1024 && Number(match[1]) <= 65535 ? value : undefined
}

export function hostSocketUrl(url: string, testEndpoint?: string): string {
  return testEndpoint && url === `${testEndpoint.replace('https:', 'wss:')}/v1/stream`
    ? url.replace('wss:', 'ws:')
    : url
}

export function openHostSocket(
  url: string,
  log: TraceLog = () => {},
  testEndpoint?: string,
): Promise<FrameSocket> {
  return openPortableSocket(hostSocketUrl(url, testEndpoint), log)
}
