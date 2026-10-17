import { expect, it, vi } from 'vitest'
import { REMOTE_UNAVAILABLE } from './lane-ops'
import { WRITE_CHANNELS, writeFeature, routeRemoteWrite, type WriteLane } from './write-features'
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
it('characterize: a routed host write carries host:-looking content verbatim', async () => {
  const l = lane({ revision: 'b'.repeat(64), mtimeMs: 2 })
  for (const content of ['host:machine/repository', 'remote-0123456789abcdef']) {
    const routed = routeRemoteWrite('fs:writeFile', [`${root}/a`, content, null], () => l)
    expect(await routed?.result).toEqual({ revision: 'b'.repeat(64), mtimeMs: 2 })
    expect(l.write).toHaveBeenLastCalledWith({
      type: 'files.write',
      path: 'a',
      content,
      expected: null,
    })
  }
})
it('characterize: a remote source never lands outside its own lane', async () => {
  const other = 'host:12345678-1234-4234-8234-123456789012/fedcba9876543210'
  const l = lane({ path: 'a' })
  for (const to of ['/Users/local/b', `${other}/b`, 'remote-0123456789abcdef', other])
    await expect(writeFeature('fs:rename', [`${root}/a`, to], l)).rejects.toThrow(
      REMOTE_UNAVAILABLE,
    )
  for (const directory of ['/Users/local', other, `${other}/dir`, 'remote-0123456789abcdef'])
    await expect(
      writeFeature('fs:transfer', [root, `${root}/a`, directory, 'move'], l),
    ).rejects.toThrow(REMOTE_UNAVAILABLE)
  for (const source of [`${other}/a`, '/Users/local/a'])
    await expect(writeFeature('fs:transfer', [root, source, root, 'copy'], l)).rejects.toThrow(
      REMOTE_UNAVAILABLE,
    )
  expect(l.write).not.toHaveBeenCalled()
})
it('characterize: a refused remote write throws instead of declining to local handlers', () => {
  const args = [`${root}/a`, `${root}/b`, root, 'copy']
  for (const channel of WRITE_CHANNELS)
    expect(() => routeRemoteWrite(channel, [...args], () => null)).toThrow(REMOTE_UNAVAILABLE)
  expect(() =>
    routeRemoteWrite('fs:transfer', [root, '/local/a', root, 'copy'], () => null),
  ).toThrow(REMOTE_UNAVAILABLE)
})
