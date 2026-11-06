import { expect, it, vi } from 'vitest'
import type { WriteLane } from '@phosphor/host-client/ports'
import { REMOTE_UNAVAILABLE } from '@phosphor/host-client/lane-ops'
import { createBrowserHandlers } from './handlers'

const root = 'host:12345678-1234-4234-8234-123456789012/0123456789abcdef'

/* The browser routes Host file writes and uploads through the focused lane's write port. */
function setup(lane: WriteLane | null) {
  const readLane = vi.fn((_windowId: number, _key?: string) => lane)
  const proxy = new Proxy({}, { get: () => () => undefined })
  const handlers = createBrowserHandlers({
    ...{ control: proxy, hosts: proxy, resources: proxy, prefs: proxy, drafts: proxy },
    lanes: { readLane },
    window: () => proxy,
    openExternal: () => {},
    broadcastLogout: () => {},
    machinesChanged: () => {},
  } as never) as unknown as Record<string, ((...args: unknown[]) => Promise<unknown>) | undefined>
  return { handlers, readLane }
}
function lane(data: unknown) {
  const write = vi.fn(async (_op: { type: string }): Promise<unknown> => data)
  return { laneId: 'lane', workspacePath: root, call: vi.fn(), write } satisfies WriteLane
}

it("writes a Host file through the focused lane's write port", async () => {
  const l = lane({ revision: 'a'.repeat(64), mtimeMs: 1 })
  const s = setup(l)
  expect(s.handlers['fs:writeFile']).toBeTypeOf('function')
  await expect(s.handlers['fs:writeFile']!(`${root}/a`, 'bytes', null)).resolves.toEqual({
    revision: 'a'.repeat(64),
    mtimeMs: 1,
  })
  expect(s.readLane).toHaveBeenCalledWith(1, `${root}/a`)
  expect(l.write).toHaveBeenCalledWith({
    type: 'files.write',
    path: 'a',
    content: 'bytes',
    expected: null,
  })
})

it('refuses a write to a path that is not a Host path, without reaching a lane', async () => {
  const l = lane(undefined)
  const s = setup(l)
  expect(s.handlers['fs:writeFile']).toBeTypeOf('function')
  await expect(s.handlers['fs:writeFile']!('/Users/local/a', 'bytes', null)).rejects.toThrow(
    REMOTE_UNAVAILABLE,
  )
  expect(l.write).not.toHaveBeenCalled()
})

it('uploads attachments to the focused lane and refuses without one', async () => {
  const l = lane(undefined)
  l.write.mockImplementation(async (op: { type: string }) =>
    op.type === 'attachments.begin'
      ? { uploadId: 'a'.repeat(32) }
      : op.type === 'attachments.commit'
        ? { path: '/host/attachments/report.pdf' }
        : undefined,
  )
  const files = [{ name: 'report.pdf', mime: 'application/pdf', data: 'YWJj' }]
  const upload = setup(l).handlers['hosts:uploadAttachments']
  expect(upload).toBeTypeOf('function')
  await expect(upload!('remote-1', files)).resolves.toEqual(['/host/attachments/report.pdf'])
  await expect(setup(null).handlers['hosts:uploadAttachments']!('remote-1', files)).rejects.toThrow(
    REMOTE_UNAVAILABLE,
  )
})
