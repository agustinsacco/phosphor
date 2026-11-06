import { randomBytes } from 'node:crypto'
import { resolve } from 'node:path'
import type { PiRpcClient } from '@phosphor/session-runtime/pi/rpc-client'
import { BRAIN_PROCESSOR_TOOLS } from '@shared/brain'
import type { ExtensionUIRequest, PiEvent } from '@shared/rpc'
import { BRAIN_AUDIT_COMMAND, BRAIN_AUDIT_STATUS_KEY } from '@phosphor/pi-extensions/status-keys'

type AuditClient = Pick<PiRpcClient, 'request' | 'on' | 'off'>

function validAttestation(value: Record<string, unknown>, jobId: string): boolean {
  return (
    value.version === 1 &&
    value.jobId === jobId &&
    Array.isArray(value.tools) &&
    value.tools.length === BRAIN_PROCESSOR_TOOLS.length &&
    value.tools.every((tool, index) => tool === BRAIN_PROCESSOR_TOOLS[index])
  )
}

function auditWaiter(
  client: AuditClient,
  jobId: string,
  nonce: string,
  signal: AbortSignal,
  timeoutMs: number,
) {
  let accept!: () => void
  let fail!: (error: Error) => void
  let failure: Error | undefined
  const ready = new Promise<void>((resolve) => {
    accept = resolve
  })
  const stopped = new Promise<never>((_resolve, reject) => {
    fail = (error) => {
      failure ??= error
      reject(error)
    }
  })
  const onAbort = () => fail(new Error('Brain tool audit cancelled'))
  const onExit = () => fail(new Error('Brain processor exited during its tool audit'))
  const onEvent = (event: PiEvent) => {
    if (event.type === 'agent_start') fail(new Error('Brain audit unexpectedly started inference'))
  }
  const onUi = (request: ExtensionUIRequest) => {
    if (request.method !== 'setStatus' || request.statusKey !== BRAIN_AUDIT_STATUS_KEY) return
    try {
      if (!request.statusText || request.statusText.length > 2048) throw new Error('Invalid audit')
      const value = JSON.parse(request.statusText) as Record<string, unknown> | null
      if (!value || value.nonce !== nonce) return
      if (!validAttestation(value, jobId)) throw new Error('Invalid audit')
      accept()
    } catch {
      fail(new Error('Brain processor tool attestation was invalid'))
    }
  }
  const timer = setTimeout(() => fail(new Error('Brain tool audit timed out')), timeoutMs)
  signal.addEventListener('abort', onAbort, { once: true })
  client.on('extension-ui', onUi)
  client.on('exit', onExit)
  client.on('event', onEvent)
  return {
    ready,
    stopped,
    assertOpen() {
      if (failure) throw failure
    },
    close() {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      client.off('extension-ui', onUi)
      client.off('exit', onExit)
      client.off('event', onEvent)
    },
  }
}

/** No model call: only a command proven to come from the explicit audited resource. */
export async function verifyBrainTools(
  client: AuditClient,
  jobId: string,
  extensionPath: string,
  signal: AbortSignal,
  timeoutMs = 10_000,
): Promise<void> {
  signal.throwIfAborted()
  const nonce = randomBytes(16).toString('hex')
  const wait = auditWaiter(client, jobId, nonce, signal, timeoutMs)
  try {
    const commands = await Promise.race([client.request({ type: 'get_commands' }), wait.stopped])
    const matches = commands.success
      ? commands.data?.commands.filter((c) => c.name === BRAIN_AUDIT_COMMAND)
      : []
    if (
      matches?.length !== 1 ||
      matches[0]?.source !== 'extension' ||
      !matches[0].sourceInfo?.path ||
      resolve(matches[0].sourceInfo.path) !== resolve(extensionPath)
    )
      throw new Error('The audited Brain processor command is unavailable')
    signal.throwIfAborted()
    wait.assertOpen()
    const response = await Promise.race([
      client.request({ type: 'prompt', message: `/${BRAIN_AUDIT_COMMAND} ${nonce}` }),
      wait.stopped,
    ])
    if (!response.success || response.data?.disposition !== 'handled')
      throw new Error('Brain tool audit was not handled as a local command')
    await Promise.race([wait.ready, wait.stopped])
    wait.assertOpen()
  } finally {
    wait.close()
  }
}
