import { describe, expect, it } from 'vitest'
import type { RpcResponse } from '@shared/rpc'
import { SessionActivity } from './session-activity'

function response(id: string, command = 'get_state', success = true): RpcResponse {
  return {
    type: 'response',
    id,
    command,
    success,
    data: {
      isStreaming: false,
      isCompacting: false,
      pendingMessageCount: 0,
    },
  } as RpcResponse
}
function idle(activity: SessionActivity): void {
  activity.requested('state', 'get_state')
  activity.responded(response('state'))
}

describe('SessionActivity', () => {
  it('treats startup and failed state probes as unknown, until fresh state arrives', () => {
    const activity = new SessionActivity()
    expect(activity.busy).toBe(true)
    activity.requested('state', 'get_state')
    activity.responded(response('state', 'get_state', false))
    expect(activity.busy).toBe(true)
    idle(activity)
    expect(activity.busy).toBe(false)
  })

  it('reserves a prompt before events and waits for settled, not agent_end', () => {
    const activity = new SessionActivity()
    idle(activity)
    activity.requested('prompt', 'prompt')
    expect(activity.busy).toBe(true)
    activity.event({ type: 'agent_start' })
    activity.responded(response('prompt', 'prompt'))
    activity.event({ type: 'agent_end', messages: [], willRetry: true })
    idle(activity) // get_state has no retry field.
    expect(activity.busy).toBe(true)
    activity.event({ type: 'auto_retry_end', success: true, attempt: 1 })
    activity.event({ type: 'agent_start' })
    activity.event({ type: 'agent_end', messages: [] })
    expect(activity.busy).toBe(true)
    activity.event({ type: 'agent_settled' })
    expect(activity.busy).toBe(false)
  })

  it('does not accept a state snapshot requested before newer work', () => {
    const activity = new SessionActivity()
    idle(activity)
    activity.requested('old', 'get_state')
    activity.requested('prompt', 'prompt')
    activity.responded(response('prompt', 'prompt'))
    activity.responded(response('old'))
    expect(activity.busy).toBe(true)
    idle(activity) // Older pi without agent_settled can recover through a fresh probe.
    expect(activity.busy).toBe(false)
  })

  it('keeps direct bash pending even when the agent and get_state say idle', () => {
    const activity = new SessionActivity()
    idle(activity)
    activity.requested('bash', 'bash')
    activity.event({ type: 'agent_settled' })
    idle(activity)
    expect(activity.busy).toBe(true)
    activity.responded(response('bash', 'bash'))
    expect(activity.busy).toBe(false)
  })

  it('tracks queues, compaction, and summarization recovery independently', () => {
    const activity = new SessionActivity()
    idle(activity)
    activity.event({ type: 'queue_update', steering: [], followUp: ['next'] })
    activity.event({ type: 'agent_settled' })
    expect(activity.busy).toBe(true)
    activity.event({ type: 'queue_update', steering: [], followUp: [] })
    activity.event({ type: 'compaction_start', reason: 'manual' })
    expect(activity.busy).toBe(true)
    activity.event({ type: 'summarization_retry_attempt_start', source: 'branchSummary' })
    activity.event({ type: 'compaction_end', reason: 'manual', result: null, aborted: false })
    idle(activity)
    expect(activity.busy).toBe(true)
    activity.event({ type: 'summarization_retry_finished' })
    expect(activity.busy).toBe(false)
  })

  it('does not mistake display status for a blocking dialog', () => {
    const activity = new SessionActivity()
    idle(activity)
    activity.dialog({
      type: 'extension_ui_request',
      id: 'status',
      method: 'setStatus',
      statusKey: 'key',
      statusText: 'hello',
    })
    expect(activity.busy).toBe(false)
    activity.dialog({
      type: 'extension_ui_request',
      id: 'dialog',
      method: 'confirm',
      title: 'Confirm',
      message: 'Continue?',
    })
    idle(activity)
    expect(activity.busy).toBe(true)
    activity.answered('dialog')
    expect(activity.busy).toBe(false)
  })

  it('does not clear an executing tool just because another signal is idle', () => {
    const activity = new SessionActivity()
    idle(activity)
    activity.event({ type: 'tool_execution_start', toolCallId: 'tool', toolName: 'bash', args: {} })
    activity.event({ type: 'agent_settled' })
    expect(activity.busy).toBe(true)
    activity.event({
      type: 'tool_execution_end',
      toolCallId: 'tool',
      toolName: 'bash',
      result: { content: [] },
      isError: false,
    })
    expect(activity.busy).toBe(false)
  })

  it('keeps failed writes uncertain and releases all facts on process exit', () => {
    const activity = new SessionActivity()
    idle(activity)
    activity.requested('bash', 'bash')
    activity.failed('bash')
    expect(activity.busy).toBe(true)
    activity.exited()
    activity.failed('bash') // Late stdin callback after exit.
    expect(activity.busy).toBe(false)
  })
})
