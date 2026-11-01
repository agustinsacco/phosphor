import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SKILL_SHARE_LIMITS, type SkillBundle } from '@phosphor/shared/host-protocol-skill-share'
import { installSkillBundle, readSkillBundle, SkillShareError } from './share-bundle'

let dir: string
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'skill-share-'))
})
afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

const b64 = (text: string) => Buffer.from(text).toString('base64')
const bundle = (text = 'new'): SkillBundle => ({
  name: 'demo',
  files: [
    { path: 'SKILL.md', data: b64(text) },
    { path: 'scripts/run.sh', data: b64('echo') },
  ],
})

describe('readSkillBundle', () => {
  it('reads files sorted, nested, as base64, leaving links, dot folders and sidecars behind', async () => {
    const skill = join(dir, 'demo')
    await mkdir(join(skill, 'scripts'), { recursive: true })
    await mkdir(join(skill, '.git'))
    await mkdir(join(skill, 'node_modules'))
    await writeFile(join(skill, 'SKILL.md'), 'body')
    await writeFile(join(skill, 'scripts', 'a.bin'), Buffer.from([0, 1, 2]))
    await writeFile(join(skill, '.git', 'config'), 'x')
    await writeFile(join(skill, 'node_modules', 'x.js'), 'x')
    await writeFile(join(skill, '.phosphor-skill.json'), '{}')
    await writeFile(join(dir, 'secret'), 'secret')
    await symlink(join(dir, 'secret'), join(skill, 'link'))
    expect(await readSkillBundle(skill, 'demo')).toEqual({
      name: 'demo',
      files: [
        { path: 'SKILL.md', data: b64('body') },
        { path: 'scripts/a.bin', data: Buffer.from([0, 1, 2]).toString('base64') },
      ],
    })
  })

  it('refuses folders without SKILL.md and bundles over the limits', async () => {
    const skill = join(dir, 'demo')
    await mkdir(skill)
    await writeFile(join(skill, 'README.md'), 'x')
    await expect(readSkillBundle(skill, 'demo')).rejects.toMatchObject({ code: 'invalid' })
    await writeFile(join(skill, 'SKILL.md'), 'x')
    await writeFile(join(skill, 'big'), Buffer.alloc(SKILL_SHARE_LIMITS.fileBytes + 1))
    await expect(readSkillBundle(skill, 'demo')).rejects.toBeInstanceOf(SkillShareError)
    await expect(readSkillBundle(skill, 'Demo')).rejects.toMatchObject({ code: 'invalid' })
  })
})

describe('installSkillBundle', () => {
  const root = () => join(dir, 'skills')
  const install = (options: Partial<Parameters<typeof installSkillBundle>[0]> = {}) =>
    installSkillBundle({
      root: root(),
      bundle: bundle(),
      overwrite: false,
      elsewhere: false,
      ...options,
    })

  it('creates the root and installs the bundle without leaving staging behind', async () => {
    expect(await install()).toEqual({ status: 'installed', replaced: false })
    expect(await readFile(join(root(), 'demo', 'SKILL.md'), 'utf8')).toBe('new')
    expect(await readFile(join(root(), 'demo', 'scripts', 'run.sh'), 'utf8')).toBe('echo')
    expect(await readdir(root())).toEqual(['demo'])
  })

  it('reports a replaceable conflict, then replaces the whole folder only with overwrite', async () => {
    await mkdir(join(root(), 'demo'), { recursive: true })
    await writeFile(join(root(), 'demo', 'SKILL.md'), 'old')
    await writeFile(join(root(), 'demo', 'stale.txt'), 'old')
    expect(await install()).toEqual({ status: 'conflict', replaceable: true })
    expect(await readFile(join(root(), 'demo', 'SKILL.md'), 'utf8')).toBe('old')
    expect(await install({ overwrite: true })).toEqual({ status: 'installed', replaced: true })
    expect((await readdir(join(root(), 'demo'))).sort()).toEqual(['SKILL.md', 'scripts'])
    expect(await readdir(root())).toEqual(['demo'])
  })

  it('never writes over a link, a file or a skill that resolves from elsewhere', async () => {
    await mkdir(root(), { recursive: true })
    await mkdir(join(dir, 'real'))
    await symlink(join(dir, 'real'), join(root(), 'demo'))
    expect(await install({ overwrite: true })).toEqual({ status: 'conflict', replaceable: false })
    await rm(join(root(), 'demo'))
    await writeFile(join(root(), 'demo'), 'file')
    expect(await install({ overwrite: true })).toEqual({ status: 'conflict', replaceable: false })
    await rm(join(root(), 'demo'))
    expect(await install({ overwrite: true, elsewhere: true })).toEqual({
      status: 'conflict',
      replaceable: false,
    })
    expect(await readdir(root())).toEqual([])
    expect(await readdir(join(dir, 'real'))).toEqual([])
  })

  it('cleans staging when a file cannot be written', async () => {
    const bad = { name: 'demo', files: [{ path: '../escape', data: '' }] }
    await expect(install({ bundle: bad })).rejects.toBeInstanceOf(SkillShareError)
    expect(await readdir(root())).toEqual([])
  })
})
