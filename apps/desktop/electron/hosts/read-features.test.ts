import { expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { FILE_LIMITS } from '@shared/host-protocol-files'
import { MACHINE_LIMITS } from '@shared/host-protocol-machine'
import { readFeature, READ_CHANNELS, type ReadLane } from './read-features'

const root = `host:${randomUUID()}/0123456789abcdef`
function lane(data: unknown): ReadLane {
  return { laneId: randomUUID(), workspacePath: root, call: vi.fn(async () => data) }
}
it('maps each read to the fixed method, capability and Desktop shape without Host paths', async () => {
  const files = lane({ files: ['a.ts'] })
  expect(await readFeature('fs:listFiles', [root], files)).toEqual(['a.ts'])
  expect(files.call).toHaveBeenCalledWith('workspaces.read', 'files.list', { laneId: files.laneId })
  const text = lane({ binary: false, size: 2, content: 'hi', secretPath: '/host/private' })
  expect(await readFeature('fs:readFile', [`${root}/a.ts`], text)).toEqual({
    path: `${root}/a.ts`,
    content: 'hi',
    size: 2,
    binary: false,
    mtimeMs: 0,
  })
  expect(text.call).toHaveBeenCalledWith('workspaces.read', 'files.read', {
    laneId: text.laneId,
    path: 'a.ts',
  })
  expect(await readFeature('git:showFileAt', [root, 'HEAD', 'a.ts'], text)).toBe('hi')
  expect(
    await readFeature(
      'git:statusMap',
      [root],
      lane({ status: { 'a.ts': ' M' }, branch: 'main', ahead: 0, behind: 0 }),
    ),
  ).toEqual({ 'a.ts': ' M' })
  const skills = lane([
    { name: 'test-skill', description: 'test', scope: 'project', dir: '/private' },
  ])
  const result = await readFeature('skills:list', [root], skills)
  expect(result).toMatchObject({ skills: [{ dir: `${root}/skill:test-skill`, writable: false }] })
  expect(JSON.stringify(result)).not.toContain('/private')
  expect(skills.call).toHaveBeenCalledWith('skills.read', 'skills.list', { laneId: skills.laneId })
  expect(
    await readFeature('skills:readFile', [`${root}/skill:test-skill`, 'SKILL.md'], text),
  ).toEqual({ content: 'hi', binary: false, size: 2 })
  const models = lane([
    { id: 'm', name: 'Model', provider: 'p', reasoning: false, privatePath: '/private' },
  ])
  expect(await readFeature('pi:catalogueModels', [], models)).toEqual({
    models: [{ id: 'm', name: 'Model', provider: 'p', reasoning: false }],
    source: 'pi',
  })
  expect(models.call).toHaveBeenCalledWith('skills.read', 'machine.models', {})
})
it('maps binary and too-large file responses to existing placeholders; hides error text', async () => {
  expect(
    await readFeature('fs:readFile', [`${root}/a`], lane({ binary: true, size: 20 })),
  ).toMatchObject({ binary: true, content: '' })
  expect(
    await readFeature('git:showFileAt', [root, 'HEAD', 'a'], lane({ binary: true, size: 20 })),
  ).toBeNull()
  const large = lane(null)
  large.call = vi.fn(async () => {
    throw new Error('too-large')
  })
  expect(await readFeature('fs:readFile', [`${root}/a`], large)).toMatchObject({
    tooLarge: true,
    content: '',
  })
  large.call = vi.fn(async () => {
    throw new Error('/private host output')
  })
  await expect(readFeature('fs:readFile', [`${root}/a`], large)).rejects.toThrow(
    'Not available on remote lanes yet.',
  )
})
it.each(['/absolute', '../escape', 'a/../escape', '.git/config', 'a\\b', 'a\0b'])(
  'rejects unsafe relative path %s before the call',
  async (path) => {
    const port = lane(null)
    await expect(readFeature('fs:readFile', [`${root}/${path}`], port)).rejects.toThrow()
    expect(port.call).not.toHaveBeenCalled()
  },
)
it('rejects cross-workspace keys, unsafe refs, names and all writes', async () => {
  const port = lane(null)
  for (const args of [
    [`${root}x/a`],
    [`${root.replace('0123456789abcdef', 'fedcba9876543210')}/a`],
    ['/host/a'],
  ])
    await expect(readFeature('fs:readFile', args, port)).rejects.toThrow()
  await expect(readFeature('git:showFileAt', [root, 'main;command', 'a'], port)).rejects.toThrow()
  await expect(
    readFeature('skills:readFile', [`${root}/skill:../escape`, 'SKILL.md'], port),
  ).rejects.toThrow()
  await expect(
    readFeature('skills:readFile', [`${root}/skill:ok`, '../escape'], port),
  ).rejects.toThrow()
  await expect(readFeature('fs:writeFile', [`${root}/a`, 'data'], port)).rejects.toThrow()
  expect(READ_CHANNELS.has('fs:writeFile')).toBe(false)
  expect(port.call).not.toHaveBeenCalled()
})
it('parses untrusted results and enforces exact list and text bounds', async () => {
  const paths = Array.from({ length: FILE_LIMITS.entries }, () => 'a')
  expect(await readFeature('fs:listFiles', [root], lane({ files: paths }))).toHaveLength(
    FILE_LIMITS.entries,
  )
  for (const data of [
    { files: [...paths, 'a'] },
    { files: ['/host/private'] },
    { files: ['../escape'] },
  ])
    await expect(readFeature('fs:listFiles', [root], lane(data))).rejects.toThrow()
  const content = 'a'.repeat(FILE_LIMITS.textBytes)
  expect(
    await readFeature(
      'fs:readFile',
      [`${root}/a`],
      lane({ content, binary: false, size: content.length }),
    ),
  ).toMatchObject({ size: content.length })
  await expect(
    readFeature(
      'fs:readFile',
      [`${root}/a`],
      lane({ content: content + 'a', binary: false, size: content.length + 1 }),
    ),
  ).rejects.toThrow()
  const model = { id: 'm', name: 'M', provider: 'p', reasoning: false }
  expect(
    await readFeature('pi:catalogueModels', [], lane(Array(MACHINE_LIMITS.models).fill(model))),
  ).toMatchObject({ source: 'pi' })
  await expect(
    readFeature('pi:catalogueModels', [], lane(Array(MACHINE_LIMITS.models + 1).fill(model))),
  ).rejects.toThrow()
  for (const [channel, args, data] of [
    [
      'git:statusMap',
      [root],
      { status: { '/host/private': ' M' }, branch: null, ahead: 0, behind: 0 },
    ],
    ['git:showFileAt', [root, 'HEAD', 'a'], { binary: false, size: 1, content: 1 }],
    ['skills:list', [root], [{ name: '../escape', description: '', scope: 'user' }]],
    ['skills:readFile', [`${root}/skill:ok`, 'SKILL.md'], { content: 1, size: 1, binary: false }],
  ] as const)
    await expect(readFeature(channel, [...args], lane(data))).rejects.toThrow()
})

it('bounds skill lists and UTF-8 text even when the Host underreports size', async () => {
  const skill = { name: 'ok', description: 'OK', scope: 'user' }
  expect(
    await readFeature('skills:list', [root], lane(Array(MACHINE_LIMITS.skills).fill(skill))),
  ).toMatchObject({ probe: 'rpc' })
  await expect(
    readFeature('skills:list', [root], lane(Array(MACHINE_LIMITS.skills + 1).fill(skill))),
  ).rejects.toThrow()
  const content = 'é'.repeat(MACHINE_LIMITS.textBytes / 2)
  expect(
    await readFeature(
      'skills:readFile',
      [`${root}/skill:ok`, 'SKILL.md'],
      lane({ binary: false, size: 0, content }),
    ),
  ).toMatchObject({ content })
  await expect(
    readFeature(
      'skills:readFile',
      [`${root}/skill:ok`, 'SKILL.md'],
      lane({ binary: false, size: 0, content: content + 'a' }),
    ),
  ).rejects.toThrow()
})
