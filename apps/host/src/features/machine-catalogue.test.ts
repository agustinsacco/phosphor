import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { createSkillsFeature } from './skills'

let home: string
beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'machine-catalogue-'))
})
afterEach(async () => rm(home, { recursive: true, force: true }))
const model = { id: 'm', name: 'M', provider: 'p', reasoning: true }
function catalogue(slow: string, models = [model]) {
  const script = `process.stdin.once('data', input => {
    const { id, type } = JSON.parse(input)
    setTimeout(() => console.log(JSON.stringify({id,type:'response',success:true,
      data:{models:${JSON.stringify(models)},commands:[]}})), type === ${JSON.stringify(slow)} ? 3000 : 0)
  })`
  return scriptFeature(script)
}
function scriptFeature(script: string) {
  const pi = {
    launch: { binaryPath: process.execPath, prefixArgs: ['-e', script, '--'], version: '1' },
    environment: { env: {}, secrets: [], names: [], ambient: [], unset: [] },
  }
  return createSkillsFeature(
    { home, env: {}, log: () => {}, store: { getLane: () => null, listRepositories: () => [] } },
    { pi },
  )
}
it('serves config while a cold pi exceeds the foreground deadline, then serves pi', async () => {
  const feature = catalogue('get_available_models')
  const dir = join(home, '.pi', 'agent')
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'models.json'), '{"providers":{"p":{"models":[{"id":"custom"}]}}}')
  expect(await feature.call('machine.models', { partial: true })).toMatchObject({
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

it('does not return a partial catalogue to an older client during a slow cold boot', async () => {
  const feature = catalogue('get_available_models')
  expect(await feature.call('machine.models', {})).toEqual({
    ok: true,
    data: { models: [model], source: 'pi' },
  })
})
it('treats a successful empty pi catalogue as authoritative, not degraded', async () => {
  const feature = catalogue('', [])
  expect(await feature.call('machine.models', {})).toEqual({
    ok: true,
    data: { models: [], source: 'pi' },
  })
})
it('delivers the answer before shutdown but holds the resource slot until child exit', async () => {
  const marker = join(home, 'live')
  const release = join(home, 'release')
  const feature = scriptFeature(`
    const fs = require('node:fs'); const marker = ${JSON.stringify(marker)};
    const overlap = fs.existsSync(marker); fs.writeFileSync(marker, 'live');
    process.on('exit', () => fs.rmSync(marker, {force:true}));
    process.stdin.once('data', input => {
      console.log(JSON.stringify({id:JSON.parse(input).id,type:'response',success:true,
        data:{commands:[{name:overlap?'overlap':'alone',source:'extension'}]}}));
      setInterval(() => { if(fs.existsSync(${JSON.stringify(release)})) process.exit() }, 10);
    })`)
  await feature.call('skills.list', {})
  expect(await readFile(marker, 'utf8')).toBe('live')
  const next = feature.call('machine.commands', {})
  try {
    // The second probe must not boot during the first child's graceful exit window.
    await new Promise((resolve) => setTimeout(resolve, 500))
  } finally {
    await writeFile(release, 'ok')
  }
  expect(await next).toMatchObject({ data: { commands: [{ name: 'alone' }] } })
})

it('reads a positive configured window in a cold catalogue without starting pi', async () => {
  const dir = join(home, '.pi', 'agent')
  await mkdir(dir, { recursive: true })
  const invalid = [-1, 0, 1.5, Number.MAX_SAFE_INTEGER + 1, '200000']
  await writeFile(
    join(dir, 'models.json'),
    JSON.stringify({
      providers: {
        p: {
          models: [
            ...invalid.map((contextWindow, i) => ({ id: `invalid-${i}`, contextWindow })),
            { id: 'custom', contextWindow: 200_000 },
          ],
        },
      },
    }),
  )
  let windowFor: (model: { provider: string; id: string }) => number | undefined = () => undefined
  createSkillsFeature(
    { home, env: {}, log: () => {}, store: { getLane: () => null, listRepositories: () => [] } },
    {},
    (read) => {
      windowFor = read
    },
  )
  expect(windowFor({ provider: 'p', id: 'custom' })).toBe(200_000)
  for (const i of invalid.keys())
    expect(windowFor({ provider: 'p', id: `invalid-${i}` })).toBeUndefined()
  expect(windowFor({ provider: 'other', id: 'custom' })).toBeUndefined()
})
