import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { registerPackagesHandlers } from './packages-handlers'
import type { JobSender } from '../pi/packages'
import type * as Handle from './handle'

const h = vi.hoisted(() => ({
  handle: vi.fn<typeof Handle.handle>(),
  spawn: vi.fn(),
  models: vi.fn(),
  commands: vi.fn(),
  order: [] as string[],
}))
vi.mock('./handle', () => ({ handle: h.handle }))
vi.mock('../pi/catalogue', () => ({
  invalidateCatalogueModels: h.models,
  invalidatePiCommands: h.commands,
}))
vi.mock('node:child_process', () => ({ spawn: h.spawn, execFile: vi.fn() }))
vi.mock('../pi/stub', () => ({ piStubPath: () => '/stub.cjs', claudeBinOverride: () => undefined }))
vi.mock('../pi/print-mode', () => ({
  OWN_GROUP: true,
  killProcessTree: vi.fn(),
  runPrintMode: vi.fn(),
}))

let child: EventEmitter & { stdout: PassThrough; stderr: PassThrough }
beforeEach(() => {
  vi.clearAllMocks()
  h.order.length = 0
  h.models.mockImplementation(() => h.order.push('models'))
  h.commands.mockImplementation(() => h.order.push('commands'))
  child = Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
  })
  h.spawn.mockReturnValue(child)
  registerPackagesHandlers()
})
afterEach(() => vi.restoreAllMocks())

async function run(sender: JobSender): Promise<{ jobId: string }> {
  const handler = h.handle.mock.calls.find(([channel]) => channel === 'packages:run')?.[1]
  const invoke = handler as unknown as (
    event: { sender: JobSender },
    action: string,
    spec: string,
    scope: string,
  ) => Promise<{ jobId: string }>
  return invoke({ sender }, 'install', 'npm:pkg', 'global')
}

it.each([0, 1, 127])(
  'invalidates both caches before forwarding mutation exit %s, once',
  async (code) => {
    const send = vi.fn((channel: string) => {
      if (channel.startsWith('packages:exit:')) h.order.push('exit')
    })
    const { jobId } = await run({ isDestroyed: () => false, send })
    child.emit('close', code)
    child.emit('close', code)
    expect(h.order).toEqual(['models', 'commands', 'exit'])
    expect(send).toHaveBeenCalledWith(`packages:exit:${jobId}`, code)
  },
)

it('forwards spawn errors and invalidates before the UI exit', async () => {
  const send = vi.fn((channel: string) => {
    h.order.push(channel.startsWith('packages:exit:') ? 'exit' : 'output')
  })
  const { jobId } = await run({ isDestroyed: () => false, send })
  child.emit('error', new Error('spawn failed'))
  child.emit('close', -1)
  expect(h.order).toEqual(['output', 'models', 'commands', 'exit'])
  expect(send.mock.calls).toHaveLength(2)
  expect(send).toHaveBeenCalledWith(`packages:output:${jobId}`, 'spawn failed\n')
  expect(send).toHaveBeenCalledWith(`packages:exit:${jobId}`, 127)
})
