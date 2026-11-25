import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import type { HostInspection } from '../commands/doctor'
import { createSkillsFeature } from './skills'

let home: string
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'machine-catalogue-'))
})
afterEach(async () => rm(home, { recursive: true, force: true }))
const model = { id: 'm', name: 'M', provider: 'p', reasoning: true }
function catalogue(slow: string) {
  const script = `process.stdin.once('data', input => {
    const { id, type } = JSON.parse(input)
    setTimeout(() => console.log(JSON.stringify({id,type:'response',success:true,
      data:{models:[${JSON.stringify(model)}],commands:[]}})), type === ${JSON.stringify(slow)} ? 3000 : 0)
  })`
  const pi = {
    launch: { binaryPath: process.execPath, prefixArgs: ['-e', script, '--'], version: '1' },
    environment: { env: {}, secrets: [], names: [], ambient: [], unset: [] },
  }
  return createSkillsFeature(
    { home, env: {}, log: () => {}, store: { getLane: () => null, listRepositories: () => [] } },
    { inspect: async () => ({ pi }) as HostInspection },
  )
}
it('serves config while a cold pi exceeds the foreground deadline, then serves pi', async () => {
  const feature = catalogue('get_available_models')
  const dir = join(home, '.pi', 'agent')
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'models.json'), '{"providers":{"p":{"models":[{"id":"custom"}]}}}')
  expect(await feature.call('machine.models', {})).toMatchObject({
    ok: true,
    data: { source: 'config', models: [{ id: 'custom' }] },
  })
  await new Promise((resolve) => setTimeout(resolve, 3100))
  expect(await feature.call('machine.models', {})).toMatchObject({
    data: { source: 'pi', models: [model] },
  })
}, 10_000)
it('answers models before an earlier slow skills probe completes', async () => {
  const feature = catalogue('get_commands')
  const order: string[] = []
  await Promise.all(
    ['skills.list', 'machine.models'].map(async (method) => {
      expect((await feature.call(method, {})).ok).toBe(true)
      order.push(method)
    }),
  )
  expect(order).toEqual(['machine.models', 'skills.list'])
})
