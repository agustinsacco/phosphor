import { expect, it, vi } from 'vitest'
import { writeFeature, routeRemoteWrite, type WriteLane } from './write-features'
const root = 'host:12345678-1234-4234-8234-123456789012/0123456789abcdef'
function lane(data?: unknown): WriteLane {
  return {
    laneId: '12345678-1234-4234-8234-123456789012',
    workspacePath: root,
    call: vi.fn(),
    write: vi.fn(async () => data),
  }
}
it('maps writes to relative allowlisted commands with explicit revisions', async () => {
  const l = lane({ revision: 'a'.repeat(64), mtimeMs: 1 })
  expect(await writeFeature('fs:writeFile', [`${root}/a`, 'bytes', null], l)).toEqual({
    revision: 'a'.repeat(64),
    mtimeMs: 1,
  })
  expect(l.write).toHaveBeenCalledWith({
    type: 'files.write',
    path: 'a',
    content: 'bytes',
    expected: null,
  })
  await expect(writeFeature('fs:writeFile', [`${root}/a`, 'bytes'], l)).rejects.toThrow()
  for (const path of [`${root}/../a`, `${root}/.git/a`, '/Users/local/a', `${root}other/a`])
    await expect(writeFeature('fs:createFile', [path], l)).rejects.toThrow()
  expect(l.write).toHaveBeenCalledTimes(1)
})
it('maps create/rename/trash/transfer, refuses imports and untrusted results', async () => {
  const l = lane()
  await writeFeature('fs:createDir', [`${root}/dir`], l)
  await writeFeature('fs:rename', [`${root}/a`, `${root}/b`], l)
  await writeFeature('fs:trash', [`${root}/b`], l)
  expect(l.write).toHaveBeenCalledWith({ type: 'files.create', path: 'dir', kind: 'directory' })
  expect(l.write).toHaveBeenCalledWith({ type: 'files.rename', from: 'a', to: 'b' })
  expect(l.write).toHaveBeenCalledWith({ type: 'files.delete', path: 'b' })
  expect(
    await writeFeature('fs:transfer', [root, `${root}/a`, root, 'copy'], lane({ path: 'a copy' })),
  ).toBe(`${root}/a copy`)
  await expect(
    writeFeature('fs:transfer', [root, '/local/file', root, 'copy'], l),
  ).rejects.toThrow()
  await expect(
    writeFeature('fs:transfer', [root, `${root}/a`, root, 'copy'], lane({ path: '/host/path' })),
  ).rejects.toThrow()
  await expect(
    writeFeature('fs:writeFile', [`${root}/a`, '', null], lane({ revision: 'bad', mtimeMs: 1 })),
  ).rejects.toThrow()
})
it('never routes local mutations and refuses unresolved remote lanes', () => {
  expect(routeRemoteWrite('fs:trash', ['/tmp/a'], () => lane())).toBeNull()
  expect(routeRemoteWrite('fs:readFile', [`${root}/a`], () => lane())).toBeNull()
  expect(() => routeRemoteWrite('fs:trash', [`${root}/a`], () => null)).toThrow()
  expect(routeRemoteWrite('fs:trash', [`${root}/a`], () => lane())).not.toBeNull()
})
