import { expect, it, vi } from 'vitest'
import type { IpcInvokeChannel } from '@phosphor/shared/ipc'
import { readFeature, routeRemoteRead, type ReadLane } from './read-features'

const root = 'host:11111111-1111-4111-8111-111111111111/0123456789abcdef'
const laneId = '22222222-2222-4222-8222-222222222222'
const revision = 'a'.repeat(64)
const unavailable = 'Not available on remote lanes yet.'
function lane(data: unknown): ReadLane {
  return { laneId, workspacePath: root, call: vi.fn(async () => data) }
}
const cases: {
  channel: IpcInvokeChannel
  args: unknown[]
  method: string
  params: unknown
  data: unknown
  result: unknown
}[] = [
  {
    channel: 'fs:listFiles',
    args: [root],
    method: 'files.list',
    params: { laneId },
    data: { files: ['src/a.ts'], path: '/private' },
    result: ['src/a.ts'],
  },
  {
    channel: 'fs:readFile',
    args: [`${root}/src/a.ts`],
    method: 'files.read',
    params: { laneId, path: 'src/a.ts' },
    data: { binary: false, content: 'hi', size: 2, revision, path: '/private' },
    result: {
      path: `${root}/src/a.ts`,
      content: 'hi',
      binary: false,
      revision,
      size: 2,
      mtimeMs: 0,
    },
  },
  {
    channel: 'git:statusMap',
    args: [root],
    method: 'git.status',
    params: { laneId },
    data: { status: { 'src/a.ts': ' M' }, branch: 'main', ahead: 2, behind: 1 },
    result: { 'src/a.ts': ' M' },
  },
  {
    channel: 'git:showFileAt',
    args: [root, 'HEAD', 'src/a.ts'],
    method: 'git.show',
    params: { laneId, path: 'src/a.ts', ref: 'HEAD' },
    data: { binary: false, content: 'old', size: 3 },
    result: 'old',
  },
  {
    channel: 'skills:list',
    args: [root],
    method: 'skills.list',
    params: { laneId },
    data: {
      skills: [{ name: 'test-skill', description: 'test', scope: 'project', dir: '/private' }],
    },
    result: {
      skills: [
        {
          name: 'test-skill',
          description: 'test',
          scope: 'project',
          dir: `${root}/skill:test-skill`,
          source: 'host',
          origin: 'top-level',
          writable: false,
          borrowed: false,
          draft: false,
          files: [{ path: 'SKILL.md', size: 0 }],
          totalSize: 0,
          warnings: [],
        },
      ],
      probe: 'rpc',
      userRoot: root,
    },
  },
  {
    channel: 'skills:readFile',
    args: [`${root}/skill:test-skill`, 'docs/help.md'],
    method: 'skills.read',
    params: { laneId, name: 'test-skill', file: 'docs/help.md' },
    data: { binary: false, content: 'help', size: 4, path: '/private' },
    result: { content: 'help', binary: false, size: 4 },
  },
]
it.each(cases)(
  'characterizes $channel request and result without Host paths',
  async ({ channel, args, method, params, data, result }) => {
    const port = lane(data)
    expect(await readFeature(channel, args, port)).toEqual(result)
    expect(port.call).toHaveBeenCalledExactlyOnceWith(
      method.startsWith('skills.') ? 'skills.read' : 'workspaces.read',
      method,
      params,
    )
  },
)
it('characterizes binary and too-large placeholders exactly', async () => {
  const binary = lane({ binary: true, size: 42 })
  expect(await readFeature('fs:readFile', [`${root}/a`], binary)).toEqual({
    path: `${root}/a`,
    content: '',
    binary: true,
    size: 42,
    mtimeMs: 0,
  })
  expect(await readFeature('git:showFileAt', [root, 'HEAD', 'a'], binary)).toBeNull()
  expect(await readFeature('skills:readFile', [`${root}/skill:ok`], binary)).toEqual({
    content: null,
    binary: true,
    size: 42,
  })
  const large = lane(null)
  large.call = vi.fn(async () => {
    throw new Error('too-large')
  })
  expect(await readFeature('fs:readFile', [`${root}/a`], large)).toEqual({
    path: `${root}/a`,
    content: '',
    size: 0,
    mtimeMs: 0,
    tooLarge: true,
  })
  await expect(readFeature('git:showFileAt', [root, 'HEAD', 'a'], large)).rejects.toThrow(
    new Error(unavailable),
  )
})
it.each(cases)(
  'characterizes fixed errors for malformed $channel results and peer failures',
  async ({ channel, args }) => {
    await expect(
      readFeature(channel, args, lane({ path: '/private', error: 'secret' })),
    ).rejects.toThrow(new Error(unavailable))
    const failed = lane(null)
    failed.call = vi.fn(async () => {
      throw new Error('/private peer details')
    })
    await expect(readFeature(channel, args, failed)).rejects.toThrow(new Error(unavailable))
  },
)
it.each([`${root}x/a`, `${root}`, '/private/a', `${root}/../escape`])(
  'characterizes opaque path rejection for %s before calling Host',
  async (path) => {
    const port = lane(null)
    await expect(readFeature('fs:readFile', [path], port)).rejects.toThrow(new Error(unavailable))
    expect(port.call).not.toHaveBeenCalled()
  },
)
it('characterizes local-null routing and unavailable remote lanes', async () => {
  const lookup = vi.fn(() => lane({ files: [] }))
  expect(routeRemoteRead('skills:list', [], lookup)).toBeNull()
  expect(routeRemoteRead('fs:listFiles', ['/local'], lookup)).toBeNull()
  expect(routeRemoteRead('fs:writeFile', [`${root}/a`], lookup)).toBeNull()
  expect(lookup).not.toHaveBeenCalled()
  expect(() => routeRemoteRead('fs:listFiles', [root], () => null)).toThrow(new Error(unavailable))
  const routed = routeRemoteRead('fs:listFiles', [root], lookup)
  expect(lookup).toHaveBeenCalledWith(root)
  expect(await routed?.result).toEqual([])
})
