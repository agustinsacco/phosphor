import { lstatSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { healthWriter, readRunHealth } from './health'
import { checkedFolder, readBounded } from './files'
import { fixture } from './__fixtures__/release'
const fixtures: ReturnType<typeof fixture>[] = []
function setup() {
  const f = fixture()
  fixtures.push(f)
  return f
}
afterEach(() => {
  for (const f of fixtures.splice(0)) f.cleanup()
})
it('writes the first accepted heartbeat atomically at 0600, then no more than once per minute', () => {
  const f = setup(),
    state = join(f.home, 'state')
  let now = 10000
  const write = healthWriter(state, f.context.uid, '1.2.3', () => now)
  expect(readRunHealth(state)).toBeNull()
  write()
  expect(lstatSync(join(state, 'run.json')).mode & 0o777).toBe(0o600)
  expect(readRunHealth(state)).toEqual({
    version: '1.2.3',
    pid: process.pid,
    startedAt: 10000,
    acceptedAt: 10000,
  })
  now += 59999
  write()
  expect(readRunHealth(state)?.acceptedAt).toBe(10000)
  now++
  write()
  expect(readRunHealth(state)?.acceptedAt).toBe(70000)
  expect(Object.keys(JSON.parse(readFileSync(join(state, 'run.json'), 'utf8')))).toEqual([
    'version',
    'pid',
    'startedAt',
    'acceptedAt',
  ])
})
it.each([
  {},
  { version: 'x', pid: 0, startedAt: 1, acceptedAt: 1 },
  { version: 'x', pid: 1.5, startedAt: 1, acceptedAt: 1 },
  { version: 'x', pid: 1, startedAt: -1, acceptedAt: 1 },
  { version: 'x', pid: 1, startedAt: 2, acceptedAt: 1 },
  { version: 'x'.repeat(81), pid: 1, startedAt: 1, acceptedAt: 1 },
])('rejects malformed health %j', (value) => {
  const f = setup(),
    state = join(f.home, 'state')
  mkdirSync(state)
  writeFileSync(join(state, 'run.json'), JSON.stringify(value))
  expect(readRunHealth(state)).toBeNull()
})
it('bounds record reads exactly and refuses linked or non-regular records', () => {
  const f = setup(),
    file = join(f.home, 'record')
  writeFileSync(file, 'x'.repeat(1024))
  expect(readBounded(file, 1024)).toHaveLength(1024)
  writeFileSync(file, 'x'.repeat(1025))
  expect(() => readBounded(file, 1024)).toThrow()
  writeFileSync(file, 'x')
  symlinkSync(file, join(f.home, 'link'))
  expect(() => readBounded(join(f.home, 'link'), 1024)).toThrow()
  expect(() => readBounded(f.home, 1024)).toThrow()
})
it('refuses unsafe deletions, symlinked ancestors, wrong ownership, home and root', () => {
  const f = setup(),
    path = join(f.home, 'data')
  mkdirSync(path)
  expect(checkedFolder(path, path, f.home, f.context.uid)).toBe(true)
  expect(
    checkedFolder(join(f.home, 'missing'), join(f.home, 'missing'), f.home, f.context.uid),
  ).toBe(false)
  for (const [p, expected, uid] of [
    [path, f.old, f.context.uid],
    [path, path, undefined],
    [path, path, (f.context.uid ?? 0) + 1],
    [f.home, f.home, f.context.uid],
    ['/', '/', f.context.uid],
  ] as const)
    expect(() => checkedFolder(p, expected, f.home, uid)).toThrow('Unsafe')
  symlinkSync(path, join(f.home, 'linked'))
  expect(() =>
    checkedFolder(join(f.home, 'linked'), join(f.home, 'linked'), f.home, f.context.uid),
  ).toThrow()
  mkdirSync(join(path, 'child'))
  expect(() =>
    checkedFolder(
      join(f.home, 'linked/child'),
      join(f.home, 'linked/child'),
      f.home,
      f.context.uid,
    ),
  ).toThrow()
})
