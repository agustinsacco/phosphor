import { expect, it } from 'vitest'
import type { IpcInvokeChannel } from '@phosphor/shared/ipc'
import { FILE_LIMITS } from '@phosphor/shared/host-protocol-files'
import { MACHINE_LIMITS } from '@phosphor/shared/host-protocol-machine'
import { readFeatureRequest, projectReadFeature } from './read-feature-shapes'

const root = 'host:11111111-1111-4111-8111-111111111111/0123456789abcdef'
const laneId = '22222222-2222-4222-8222-222222222222'
const unavailable = new Error('Not available on remote lanes yet.')
const requests: [IpcInvokeChannel, unknown[], string, unknown][] = [
  ['fs:listFiles', [root], 'files.list', { laneId }],
  ['fs:readFile', [`${root}/src/a`], 'files.read', { laneId, path: 'src/a' }],
  ['git:statusMap', [root], 'git.status', { laneId }],
  ['git:showFileAt', [root, 'aBcD', 'src/a'], 'git.show', { laneId, path: 'src/a', ref: 'aBcD' }],
  ['skills:list', [root], 'skills.list', { laneId }],
  [
    'skills:readFile',
    [`${root}/skill:my-skill`, 'docs/a'],
    'skills.read',
    { laneId, name: 'my-skill', file: 'docs/a' },
  ],
]
it.each(requests)(
  'readFeatureRequest selects %s method, capability and parsed params',
  (channel, args, method, params) => {
    expect(readFeatureRequest(channel, args, root, laneId)).toEqual({
      capability: method.startsWith('skills.') ? 'skills.read' : 'workspaces.read',
      method,
      params,
    })
  },
)
it('readFeatureRequest permits machine skills without lane or explicit file', () => {
  expect(readFeatureRequest('skills:list', [], root)).toEqual({
    capability: 'skills.read',
    method: 'skills.list',
    params: {},
  })
  expect(readFeatureRequest('skills:readFile', [`${root}/skill:ok`], root)).toEqual({
    capability: 'skills.read',
    method: 'skills.read',
    params: { name: 'ok' },
  })
  expect(() => readFeatureRequest('fs:listFiles', [root], root)).toThrow(unavailable)
})
it.each([
  ['fs:readFile', [`${root}x/a`]],
  ['fs:readFile', [root]],
  ['fs:readFile', ['/private/a']],
  ['fs:readFile', [null]],
  ['fs:readFile', [`${root}/../escape`]],
  ['fs:readFile', [`${root}/.git/config`]],
  ['git:showFileAt', [root, 'main;command', 'a']],
  ['git:showFileAt', [root, 'HEAD', '/private/a']],
  ['skills:readFile', [`${root}/other:ok`]],
  ['skills:readFile', [`${root}/skill:Not-Canonical`]],
  ['skills:readFile', [`${root}/skill:ok`, '../escape']],
  ['fs:writeFile', [`${root}/a`, 'data']],
] satisfies [IpcInvokeChannel, unknown[]][])(
  'readFeatureRequest rejects invalid %s args %j with the fixed error',
  (channel, args) => {
    expect(() => readFeatureRequest(channel, args, root, laneId)).toThrow(unavailable)
  },
)
it.each(['fs:listFiles', 'skills:list'] satisfies IpcInvokeChannel[])(
  'readFeatureRequest rejects invalid lane IDs for %s',
  (channel) => {
    expect(() => readFeatureRequest(channel, [root], root, 'invalid')).toThrow(unavailable)
  },
)

function project(channel: IpcInvokeChannel, method: string, data: unknown) {
  return projectReadFeature(channel, method, [`${root}/a`], root, data)
}
it.each(['a'.repeat(64), null])(
  'projectReadFeature preserves current file revision %s',
  (revision) => {
    expect(
      project('fs:readFile', 'files.read', {
        binary: false,
        content: 'hi',
        size: 2,
        revision,
        path: '/private',
      }),
    ).toEqual({ path: `${root}/a`, binary: false, content: 'hi', size: 2, revision, mtimeMs: 0 })
  },
)
it.each([undefined, 'bad', 'A'.repeat(64), 0])(
  'projectReadFeature rejects invalid current revision %s',
  (revision) => {
    expect(() =>
      project('fs:readFile', 'files.read', { binary: false, content: 'hi', size: 2, revision }),
    ).toThrow(unavailable)
  },
)
it.each([
  ['fs:listFiles', 'files.list', { files: ['src/a'], root: '/private' }, ['src/a']],
  [
    'git:statusMap',
    'git.status',
    { status: { 'src/a': ' M' }, branch: 'main', ahead: 0, behind: 0 },
    { 'src/a': ' M' },
  ],
  ['git:showFileAt', 'git.show', { binary: false, content: 'old', size: 3 }, 'old'],
  ['git:showFileAt', 'git.show', { binary: true, size: 3 }, null],
  [
    'fs:readFile',
    'files.read',
    { binary: true, size: 3 },
    { path: `${root}/a`, content: '', binary: true, size: 3, mtimeMs: 0 },
  ],
  [
    'skills:readFile',
    'skills.read',
    { binary: false, content: 'hi', size: 2, path: '/private' },
    { binary: false, content: 'hi', size: 2 },
  ],
  [
    'skills:readFile',
    'skills.read',
    { binary: true, content: 'ignored', size: 3 },
    { binary: true, content: null, size: 3 },
  ],
] satisfies [IpcInvokeChannel, string, unknown, unknown][])(
  'projectReadFeature projects %s from %j',
  (channel, method, data, expected) => {
    expect(project(channel, method, data)).toEqual(expected)
  },
)
it('projectReadFeature projects canonical skill metadata only', () => {
  expect(
    project('skills:list', 'skills.list', {
      skills: [
        { name: 'my-skill', description: 'help', scope: 'user', dir: '/private', writable: true },
      ],
    }),
  ).toEqual({
    skills: [
      {
        name: 'my-skill',
        description: 'help',
        scope: 'user',
        dir: `${root}/skill:my-skill`,
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
  })
})
it.each(['../escape', 'Bad', 'two--hyphens', 'a/b'])(
  'projectReadFeature rejects noncanonical skill name %s',
  (name) => {
    expect(() =>
      project('skills:list', 'skills.list', {
        skills: [{ name, description: '', scope: 'project' }],
      }),
    ).toThrow(unavailable)
  },
)
it('projectReadFeature enforces exact skill list bounds and envelope', () => {
  const skill = { name: 'ok', description: '', scope: 'user' }
  expect(
    project('skills:list', 'skills.list', { skills: Array(MACHINE_LIMITS.skills).fill(skill) }),
  ).toMatchObject({ skills: expect.arrayContaining([expect.objectContaining({ name: 'ok' })]) })
  for (const data of [[skill], null, { skills: Array(MACHINE_LIMITS.skills + 1).fill(skill) }])
    expect(() => project('skills:list', 'skills.list', data)).toThrow(unavailable)
})
it.each([
  ['fs:readFile', 'files.read', FILE_LIMITS.textBytes],
  ['git:showFileAt', 'git.show', FILE_LIMITS.textBytes],
  ['skills:readFile', 'skills.read', MACHINE_LIMITS.textBytes],
] satisfies [IpcInvokeChannel, string, number][])(
  'projectReadFeature enforces UTF-8 byte cap for %s even with size zero',
  (channel, method, cap) => {
    const content = 'é'.repeat(cap / 2)
    const data = { binary: false, content, size: 0, revision: null }
    expect(project(channel, method, data)).toEqual(
      channel === 'git:showFileAt' ? content : expect.objectContaining({ content }),
    )
    expect(() => project(channel, method, { ...data, content: content + 'a' })).toThrow(unavailable)
    expect(() => project(channel, method, { ...data, content: '', size: cap + 1 })).toThrow(
      unavailable,
    )
  },
)
it.each(requests)(
  'projectReadFeature rejects malformed %s results with the fixed error',
  (channel, _args, method) => {
    for (const data of [undefined, null, {}, { path: '/private', error: 'secret' }])
      expect(() => project(channel, method, data)).toThrow(unavailable)
  },
)
