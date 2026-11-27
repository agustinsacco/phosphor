import { readFileSync } from 'node:fs'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { BrainAgentBindingUnreadable, createBrainAgentBinding } from './binding'

let root: string
let path: string
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'brain-agent-binding-'))
  path = join(root, 'brain', 'agent-lane.json')
})
afterEach(() => rm(root, { recursive: true, force: true }))

it('mints one ref on first read and keeps it across restarts and rebinding', async () => {
  const first = await createBrainAgentBinding(path).read()
  expect(first).toMatchObject({ sessionFile: null, fence: 1 })
  expect((await stat(path)).mode & 0o777).toBe(0o600)
  const again = createBrainAgentBinding(path)
  expect((await again.read()).ref).toBe(first.ref)
  await again.bind('/sessions/brain/harbor.jsonl')
  const restarted = await createBrainAgentBinding(path).read()
  expect(restarted).toEqual({
    ref: first.ref,
    sessionFile: '/sessions/brain/harbor.jsonl',
    fence: 1,
  })
})

it('advances the fence durably and never reuses one', async () => {
  const binding = createBrainAgentBinding(path)
  const fences: number[] = []
  const advance = () =>
    binding.advance(
      () => true,
      (fence) => fences.push(fence),
    )
  expect(await Promise.all([advance(), advance(), advance()])).toEqual([true, true, true])
  expect(fences).toEqual([2, 3, 4])
  expect((await createBrainAgentBinding(path).read()).fence).toBe(4)
})

it('persists and publishes the fence without yielding after the commit check', async () => {
  const binding = createBrainAgentBinding(path)
  const { fence: before } = await binding.read()
  let published: number | undefined
  let observed: number | undefined
  const advanced = await binding.advance(
    () => {
      queueMicrotask(() => {
        observed = published
      })
      return true
    },
    (fence) => {
      expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({ fence })
      published = fence
    },
  )
  expect(advanced).toBe(true)
  expect(observed).toBe(before + 1)
})

it.each([
  ['not JSON', '{'],
  [
    'another version',
    JSON.stringify({ version: 2, ref: crypto.randomUUID(), sessionFile: null, fence: 1 }),
  ],
  [
    'a ref that is not a UUID',
    JSON.stringify({ version: 1, ref: 'Harbor', sessionFile: null, fence: 1 }),
  ],
  [
    'a relative transcript',
    JSON.stringify({ version: 1, ref: crypto.randomUUID(), sessionFile: 'x.jsonl', fence: 1 }),
  ],
  ['no fence', JSON.stringify({ version: 1, ref: crypto.randomUUID(), sessionFile: null })],
])('fails closed on %s instead of minting a second identity', async (_, text) => {
  const binding = createBrainAgentBinding(path)
  await binding.read()
  await writeFile(path, text)
  const fresh = createBrainAgentBinding(path)
  await expect(fresh.read()).rejects.toBeInstanceOf(BrainAgentBindingUnreadable)
  await expect(fresh.bind('/sessions/brain/x.jsonl')).rejects.toBeInstanceOf(
    BrainAgentBindingUnreadable,
  )
  expect(await readFile(path, 'utf8')).toBe(text)
})
