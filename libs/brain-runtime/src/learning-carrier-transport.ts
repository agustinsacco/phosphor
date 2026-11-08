import { realpath } from 'node:fs/promises'
import type { ExtensionUIRequest, PiEvent } from '@phosphor/shared/rpc'
import type { PiRpcClient } from '@phosphor/session-runtime/pi/rpc-client'
import { abortable } from './processor-wait'

import {
  BRAIN_LEARNING_COMMAND,
  BRAIN_LEARNING_STATUS_KEY,
} from '@phosphor/pi-extensions/status-keys'
const COMMAND = BRAIN_LEARNING_COMMAND
export async function verifyLearningCommand(
  client: PiRpcClient,
  extensionPath: string,
  signal: AbortSignal,
): Promise<void> {
  const response = await abortable(client.request({ type: 'get_commands' }), signal)
  const commands = response.success ? response.data?.commands : undefined
  const command = commands?.find((item) => item.name === COMMAND)
  if (
    !commands ||
    commands.length !== 1 ||
    command?.source !== 'extension' ||
    !command.sourceInfo?.path ||
    (await realpath(command.sourceInfo.path)) !== (await realpath(extensionPath))
  )
    throw new Error(
      'Learning requires exactly its audited private carrier command; no discovery or unaudited commands',
    )
}
/** An authenticated extension command MUST acknowledge handled, never started/queued inference. */
export async function commandLearningCarrier(
  client: PiRpcClient,
  jobId: string,
  nonce: string,
  operation: 'prepare' | 'run',
  signal: AbortSignal,
): Promise<boolean> {
  signal.throwIfAborted()
  let status: (request: ExtensionUIRequest) => void = () => {}
  let event: (value: PiEvent) => void = () => {}
  let exit: () => void = () => {}
  const ack = new Promise<boolean>((resolve, reject) => {
    status = (request) => {
      if (request.method !== 'setStatus' || request.statusKey !== BRAIN_LEARNING_STATUS_KEY) return
      if (typeof request.statusText !== 'string' || Buffer.byteLength(request.statusText) > 512) {
        reject(new Error('Oversized learning acknowledgement'))
        return
      }
      try {
        const frame = JSON.parse(request.statusText) as {
          version?: number
          nonce?: string
          jobId?: string
          operation?: string
          ok?: boolean
        }
        if (
          frame.version !== 1 ||
          frame.nonce !== nonce ||
          frame.jobId !== jobId ||
          frame.operation !== operation ||
          typeof frame.ok !== 'boolean'
        )
          throw new Error('Learning acknowledgement ownership mismatch')
        resolve(frame.ok)
      } catch {
        reject(new Error('Invalid learning acknowledgement'))
      }
    }
    event = (value) => {
      if (
        ['agent_start', 'tool_execution_start', 'auto_retry_start', 'compaction_start'].includes(
          value.type,
        )
      ) {
        client.killNow()
        reject(new Error('Learning carrier attempted an agent/tool/retry/compaction operation'))
      }
    }
    exit = () => reject(new Error('Learning carrier exited before acknowledgement'))
    client.on('extension-ui', status)
    client.on('event', event)
    client.once('exit', exit)
  })
  try {
    const response = client.request({
      type: 'prompt',
      message: `/${COMMAND} ${nonce} ${operation}`,
    })
    const [ok, handled] = await abortable(Promise.all([ack, response]), signal)
    if (!handled.success || handled.data?.disposition !== 'handled') {
      client.killNow()
      throw new Error('Learning carrier command was not handled without inference')
    }
    return ok
  } finally {
    client.off('extension-ui', status)
    client.off('event', event)
    client.off('exit', exit)
  }
}
