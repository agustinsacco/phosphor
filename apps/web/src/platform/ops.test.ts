import { expect, it, vi } from 'vitest'
import { createBrowserHandlers, type BrowserHandlerPorts } from './handlers'

// The bridge and host-client transport are real; only the selected connection is a port.
function bridge(ops?: boolean) {
  const result = { status: 'ok', text: 'Done', applies: 'now', data: [] }
  const call = vi.fn(async () => ({ ok: true, data: result }))
  const send = vi.fn(async () => ({ status: 'done', data: result }))
  const connection = vi.fn(() => ({ snapshot: () => ({ state: 'ready', ops }), call, send }))
  const unused = new Proxy({}, { get: () => () => undefined })
  const run = createBrowserHandlers({
    hosts: { connection },
    resources: unused,
    lanes: unused,
    control: unused,
    prefs: unused,
    drafts: unused,
  } as unknown as BrowserHandlerPorts)['ops:run']
  return { run, call, send, connection, result }
}
const target = { kind: 'remote', hostId: 'selected-machine' } as const
const list = { op: 'confirm.list', args: {} }

it('calls the selected Host for reads and sends a command for its confirmation decision', async () => {
  const b = bridge(true)
  expect(await b.run(target, list)).toEqual(b.result)
  expect(b.call).toHaveBeenCalledWith('ops.run', list)
  const decision = {
    op: 'confirm.deny',
    args: { confirmId: '12345678-1234-4234-8234-123456789012' },
  }
  expect(await b.run(target, decision)).toEqual(b.result)
  expect(b.send).toHaveBeenCalledWith({ type: 'ops.run', ...decision })
  expect(b.connection.mock.calls).toEqual([[target.hostId], [target.hostId]])
})

it('does not send ops to a Host without ready.ops or route This Mac to any Host', async () => {
  const b = bridge()
  for (const host of [target, { kind: 'local' } as const])
    expect(await b.run(host, list)).toMatchObject({ status: 'denied', code: 'unsupported' })
  expect(b.call).not.toHaveBeenCalled()
  expect(b.send).not.toHaveBeenCalled()
})
