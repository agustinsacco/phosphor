import { expect, it } from 'vitest'
import { ForkTracer, traceDiagnostic } from './fork-trace'

it('times first assistant activity, counts turns and updates, and retains only whitelisted metadata', () => {
  let clock = 100
  const tracer = new ForkTracer(() => clock)
  clock = 110
  tracer.stdout()
  tracer.event({
    type: 'message_start',
    message: { role: 'user', content: [{ type: 'text', text: 'private Harbor lane' }] },
  })
  clock = 120
  tracer.stdout()
  tracer.event({ type: 'agent_start' })
  tracer.event({ type: 'turn_start' })
  tracer.event({ type: 'message_start', message: { role: 'assistant' } })
  clock = 140
  tracer.event({ type: 'message_update', usage: { totalTokens: 7, cost: { total: 0.01 } } })
  tracer.event({ type: 'message_update' })
  tracer.event({ type: 'turn_start' })
  tracer.event({
    type: 'message_end',
    message: {
      role: 'assistant',
      stopReason: 'stop',
      content: [{ type: 'text', text: 'private Rina Okafor answer' }],
      usage: {
        input: 90,
        output: 20,
        cacheRead: 8,
        cacheWrite: 2,
        totalTokens: 120,
        cost: { total: 0.02 },
      },
    },
  })
  clock = 160
  tracer.finish('completed')
  expect(tracer.trace).toEqual({
    firstStdoutMs: 10,
    firstMessageStartMs: 20,
    firstMessageUpdateMs: 40,
    agentStarts: 1,
    turns: 2,
    messageUpdates: 2,
    retries: [],
    compactions: [],
    stopReason: 'stop',
    usage: { tokens: 120, cost: 0.02, input: 90, output: 20, cacheRead: 8, cacheWrite: 2 },
    providerError: undefined,
    totalMs: 60,
    reason: 'completed',
  })
  expect(JSON.stringify(tracer.trace)).not.toMatch(/private|Rina|Harbor/)
})

it('records every retry and compaction outcome, scrubbing errors before clipping', () => {
  const tracer = new ForkTracer(() => 10)
  tracer.event({
    type: 'auto_retry_start',
    attempt: 1,
    delayMs: 2000,
    errorMessage: '429 Bearer harbor-secret',
  })
  tracer.event({
    type: 'auto_retry_end',
    attempt: 2,
    success: false,
    finalError: 'Email rina@example.test',
  })
  tracer.event({
    type: 'summarization_retry_scheduled',
    attempt: 1,
    delayMs: 4000,
    errorMessage: 'token=harbor-secret',
  })
  tracer.event({ type: 'compaction_start', reason: 'overflow' })
  tracer.event({
    type: 'compaction_end',
    reason: 'overflow',
    aborted: false,
    willRetry: true,
    errorMessage: 'password=harbor-secret',
  })
  expect(tracer.trace.retries).toEqual([
    {
      type: 'auto_retry_start',
      atMs: 0,
      attempt: 1,
      delayMs: 2000,
      errorMessage: '429 [redacted]',
    },
    {
      type: 'auto_retry_end',
      atMs: 0,
      attempt: 2,
      success: false,
      errorMessage: 'Email [redacted]',
    },
    {
      type: 'summarization_retry_scheduled',
      atMs: 0,
      attempt: 1,
      delayMs: 4000,
      errorMessage: '[redacted]',
    },
  ])
  expect(tracer.trace.compactions).toEqual([
    { type: 'compaction_start', atMs: 0, reason: 'overflow' },
    {
      type: 'compaction_end',
      atMs: 0,
      reason: 'overflow',
      aborted: false,
      willRetry: true,
      errorMessage: '[redacted]',
    },
  ])
  const diagnostic = 'x'.repeat(589) + ' Bearer ' + 'h'.repeat(1000)
  expect(traceDiagnostic(diagnostic)).toBe('x'.repeat(589) + ' [redacted]')
  expect(traceDiagnostic('x'.repeat(1000))).toHaveLength(600)
  expect(JSON.stringify(tracer.trace)).not.toMatch(/harbor-secret|rina@example/)
})

it('describes current progress, resets retry state after recovery and rejects arbitrary stop reasons', () => {
  const tracer = new ForkTracer(() => 10)
  expect(tracer.timeoutMessage('example/fast')).toBe(
    'Timed out after 300 s waiting for example/fast (no reply yet)',
  )
  tracer.event({ type: 'auto_retry_start', attempt: 1, errorMessage: '429 overloaded' })
  expect(tracer.timeoutMessage('example/fast')).toBe(
    'Timed out after 300 s waiting for example/fast (retrying: 429 overloaded)',
  )
  tracer.event({ type: 'auto_retry_end', success: true, attempt: 1 })
  tracer.event({ type: 'message_update', usage: { totalTokens: NaN, cost: { total: Infinity } } })
  tracer.event({
    type: 'message_end',
    message: {
      role: 'assistant',
      stopReason: 'private answer',
      errorMessage: 'token=harbor-secret',
    },
  })
  expect(tracer.timeoutMessage('example/fast')).toBe(
    'Timed out after 300 s waiting for example/fast (reply started)',
  )
  expect(tracer.trace.stopReason).toBeNull()
  expect(tracer.trace.providerError).toBe('[redacted]')
  expect(tracer.trace.usage).toEqual({
    tokens: 0,
    cost: 0,
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
  })
})
