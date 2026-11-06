import { afterEach, expect, it, vi } from 'vitest'
import { join } from 'node:path'
import { createBrainBridge, type BrainCapability } from './bridge'
import { createBrainProcessor } from './processor'
import { adapterFixture, deferred } from './__fixtures__/adapter-fixture'

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); vi.useRealTimers() })
async function fixture() {
  const f = await adapterFixture(); cleanup.push(f.cleanup)
  const bridge = await createBrainBridge({ allowed: async () => false, invoke: async () => undefined }); cleanup.push(() => bridge.close())
  const processor = createBrainProcessor(f.options, f.store, bridge, join(f.directory, 'sessions')); cleanup.push(() => processor.dispose())
  const start = () => processor.process(f.scope, { model: f.model, policyEpoch: f.snapshot.policyEpoch })
  return { ...f, bridge, processor, start }
}
it('requires exact epoch and model consent before startup and permits only one processor', async () => {
  const f = await fixture()
  await expect(f.processor.process(f.scope, { model: f.model, policyEpoch: undefined as unknown as number })).rejects.toThrow('epoch')
  await expect(f.processor.process(f.scope, { model: f.model, policyEpoch: f.snapshot.policyEpoch - 1 })).rejects.toThrow('consent')
  await expect(f.processor.process(f.scope, { model: { ...f.model, id: 'other' }, policyEpoch: f.snapshot.policyEpoch })).rejects.toThrow('consent')
  const pending = deferred<Awaited<ReturnType<typeof f.options.processor.resolve>>>()
  vi.mocked(f.options.processor.resolve).mockReturnValue(pending.promise)
  await f.start()
  await expect(f.start()).rejects.toThrow('One Brain processor')
  expect(f.options.sessions.create).not.toHaveBeenCalled()
})
it('disposes a processor whose startup resolves after cancellation', async () => {
  const f = await fixture()
  const pending = deferred<{ sessionId: string; workspacePath: string }>()
  vi.mocked(f.options.sessions.create).mockReturnValue(pending.promise)
  const job = await f.start()
  await vi.waitFor(() => expect(f.options.sessions.create).toHaveBeenCalled())
  await f.processor.cancel(job.id)
  const { live } = await f.processorSession(job.id)
  pending.resolve({ sessionId: live.sessionId, workspacePath: live.workspacePath })
  await vi.waitFor(() => expect(f.options.sessions.disposeBrain).toHaveBeenCalledWith(live.sessionId, { kind: 'brain', jobId: job.id }))
  expect(f.engine.job(job.id).state).toBe('cancelled')
})
it('includes a stalled launch resolver in the 120-second whole-job deadline', async () => {
  const f = await fixture()
  vi.useFakeTimers()
  vi.mocked(f.options.processor.resolve).mockReturnValue(new Promise(() => {}))
  const job = await f.start()
  await vi.advanceTimersByTimeAsync(120_001)
  await vi.waitFor(() => expect(f.engine.job(job.id).state).toBe('cancelled'))
  expect(f.options.sessions.create).not.toHaveBeenCalled()
})
it.each(['1.3.9', '1.4.0-unverified'])('refuses unsupported or unverified pi %s before startup', async (version) => {
  const f = await fixture()
  vi.mocked(f.options.processor.resolve).mockResolvedValue({ binaryPath: '/synthetic/pi', version, env: {} })
  const job = await f.start()
  await vi.waitFor(() => expect(f.engine.job(job.id).state).toBe('failed'))
  expect(f.options.sessions.create).not.toHaveBeenCalled()
})
it('fails closed if the audited active-tools hook refuses readiness', async () => {
  const f = await fixture()
  let session: Awaited<ReturnType<typeof f.processorSession>> | undefined
  vi.mocked(f.options.sessions.create).mockImplementation(async (_options, _delivery, execution) => {
    session = await f.processorSession(execution!.brain!.owner.jobId)
    return { sessionId: session.live.sessionId, workspacePath: session.live.workspacePath }
  })
  vi.mocked(f.options.processor.verifyTools).mockRejectedValue(new Error('Unexpected MCP tool'))
  const job = await f.start()
  await vi.waitFor(() => expect(f.engine.job(job.id).state).toBe('failed'))
  expect(session!.client.request.mock.calls.some(([command]) => command.type === 'prompt')).toBe(false)
})
it('fences evidence delivery after disable even while the fake inference prompt is pending', async () => {
  const f = await fixture()
  let session: Awaited<ReturnType<typeof f.processorSession>> | undefined
  vi.mocked(f.options.sessions.create).mockImplementation(async (_options, _delivery, execution) => {
    session = await f.processorSession(execution!.brain!.owner.jobId)
    return { sessionId: session.live.sessionId, workspacePath: session.live.workspacePath }
  })
  const job = await f.start()
  await vi.waitFor(() => expect(session?.client.request.mock.calls.some(([command]) => command.type === 'prompt')).toBe(true))
  const capability: BrainCapability = { kind: 'processor', scope: f.scope, policyEpoch: job.policyEpoch, jobId: job.id, fence: job.fence, sessionId: session!.live.sessionId }
  await expect(f.processor.invoke(capability, 'job', {})).resolves.toMatchObject({ job: { id: job.id }, evidence: [{ id: f.evidence.id }] })
  f.engine.setPrefs({ ...f.snapshot.prefs, enabled: false })
  await f.processor.revoke()
  await expect(f.processor.invoke(capability, 'job', {})).rejects.toThrow('unavailable')
  expect(f.options.sessions.disposeBrain).toHaveBeenCalled()
})
it('stops on any non-audited tool event and on the seventeenth allowed tool', async () => {
  const f = await fixture()
  let session: Awaited<ReturnType<typeof f.processorSession>> | undefined
  vi.mocked(f.options.sessions.create).mockImplementation(async (_options, _delivery, execution) => {
    session = await f.processorSession(execution!.brain!.owner.jobId)
    return { sessionId: session.live.sessionId, workspacePath: session.live.workspacePath }
  })
  const job = await f.start()
  await vi.waitFor(() => expect(session?.client.request.mock.calls.some(([command]) => command.type === 'prompt')).toBe(true))
  for (let count = 0; count < 17; count++) session!.client.emit('event', { type: 'tool_execution_start', toolName: 'brain_job' })
  await vi.waitFor(() => expect(f.engine.job(job.id).state).toBe('cancelled'))
})
