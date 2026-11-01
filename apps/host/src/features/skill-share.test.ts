vi.mock('@phosphor/session-runtime/pi/packages', () => ({ listPackages: async () => [] }))
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HostInspection } from '../commands/doctor'
import type { FeatureContext } from './feature'
import type { MachinePorts } from './machine'
import { createSkillsFeature } from './skills'
import { createSkillInstallFeature } from './skill-install'

let root: string
let skillsRoot: string
let commands: unknown[]
let ports: MachinePorts
let context: FeatureContext
const logs: string[] = []
const skill = (path: string, name = 'demo') => ({
  name: `skill:${name}`,
  description: 'Example',
  source: 'skill',
  sourceInfo: { path, scope: 'user' },
})
const b64 = (text: string) => Buffer.from(text).toString('base64')
const bundle = (text = 'shared') => ({
  name: 'demo',
  files: [
    { path: 'SKILL.md', data: b64(text) },
    { path: 'lib/tool.py', data: b64('print(1)') },
  ],
})

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'host-skill-share-'))
  skillsRoot = join(root, 'agent', 'skills')
  commands = []
  logs.length = 0
  const script = join(root, 'pi.cjs')
  await writeFile(
    script,
    `let t='';process.stdin.on('data',c=>{t+=c;if(!t.includes('\\n'))return;const q=JSON.parse(t);console.log(JSON.stringify({type:'response',id:q.id,success:true,data:{commands:JSON.parse(process.env.COMMANDS)}}))})`,
  )
  context = {
    home: root,
    env: {},
    log: (event, fields) => logs.push(`${event} ${JSON.stringify(fields)}`),
    store: { getLane: () => null, listRepositories: () => [] },
  }
  ports = {
    inspect: async () =>
      ({
        report: { lanes: { native: { available: true } }, providers: [] },
        pi: {
          launch: { binaryPath: process.execPath, prefixArgs: [script], version: '1' },
          environment: { env: { COMMANDS: JSON.stringify(commands) }, secrets: [], names: [] },
        },
      }) as unknown as HostInspection,
  }
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('skills.export', () => {
  it('exports a SKILL.md folder as one bounded bundle', async () => {
    const folder = join(skillsRoot, 'demo')
    await mkdir(join(folder, 'lib'), { recursive: true })
    await writeFile(join(folder, 'SKILL.md'), 'shared')
    await writeFile(join(folder, 'lib', 'tool.py'), 'print(1)')
    commands.push(skill(join(folder, 'SKILL.md')))
    const feature = createSkillsFeature(context, ports)
    expect(await feature.call('skills.export', { name: 'demo' })).toEqual({
      ok: true,
      data: bundle(),
    })
  })

  it('refuses loose Markdown skills, unknown names and extra params', async () => {
    await mkdir(skillsRoot, { recursive: true })
    await writeFile(join(skillsRoot, 'loose.md'), 'x')
    commands.push(skill(join(skillsRoot, 'loose.md'), 'loose'))
    const feature = createSkillsFeature(context, ports)
    for (const params of [{ name: 'loose' }, { name: 'missing' }, { name: 'loose', file: 'x' }])
      expect(await feature.call('skills.export', params)).toMatchObject({
        ok: false,
        error: { code: 'bad-request' },
      })
  })
})

describe('skills.install', () => {
  const feature = () => createSkillInstallFeature(context, { ...ports, skillsRoot })
  const allowed = () => true

  it('needs configuration authority before and after resolving existing skills', async () => {
    expect(await feature().call('skills.install', { bundle: bundle() })).toMatchObject({
      error: { code: 'forbidden' },
    })
    let calls = 0
    const revoked = () => calls++ === 0
    expect(await feature().call('skills.install', { bundle: bundle() }, revoked)).toMatchObject({
      error: { code: 'forbidden' },
    })
    await expect(readdir(skillsRoot)).rejects.toThrow()
  })

  it('installs into the global skills folder, then reports a replaceable conflict', async () => {
    expect(await feature().call('skills.install', { bundle: bundle() }, allowed)).toEqual({
      ok: true,
      data: { status: 'installed', replaced: false },
    })
    expect(await readFile(join(skillsRoot, 'demo', 'lib', 'tool.py'), 'utf8')).toBe('print(1)')
    commands.push(skill(join(skillsRoot, 'demo', 'SKILL.md')))
    const again = { bundle: bundle('second') }
    expect(await feature().call('skills.install', again, allowed)).toEqual({
      ok: true,
      data: { status: 'conflict', replaceable: true },
    })
    expect(await readFile(join(skillsRoot, 'demo', 'SKILL.md'), 'utf8')).toBe('shared')
    expect(await feature().call('skills.install', { ...again, overwrite: true }, allowed)).toEqual({
      ok: true,
      data: { status: 'installed', replaced: true },
    })
    expect(await readFile(join(skillsRoot, 'demo', 'SKILL.md'), 'utf8')).toBe('second')
    expect(logs).toContain('skills.install {"name":"demo","status":"installed"}')
  })

  it('never overwrites a same-named skill that resolves from outside the folder', async () => {
    const elsewhere = join(root, 'package', 'demo')
    await mkdir(elsewhere, { recursive: true })
    await writeFile(join(elsewhere, 'SKILL.md'), 'package')
    commands.push(skill(join(elsewhere, 'SKILL.md')))
    expect(
      await feature().call('skills.install', { bundle: bundle(), overwrite: true }, allowed),
    ).toEqual({ ok: true, data: { status: 'conflict', replaceable: false } })
    expect(await readdir(skillsRoot)).toEqual([])
  })

  it('rejects invalid bundles and caller-chosen roots', async () => {
    for (const params of [
      {},
      { bundle: { name: 'demo', files: [] } },
      { bundle: bundle(), root: '/tmp' },
      { bundle: { ...bundle(), name: '../x' } },
    ])
      expect(await feature().call('skills.install', params, allowed)).toMatchObject({
        error: { code: 'bad-request' },
      })
  })
})
