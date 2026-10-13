import { rmSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { commandLayout, installedLayout, serviceProgram } from './layout'
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
it('recognizes release installs and builds service paths through current, never pinned to a version', () => {
  const f = setup(),
    node = join(f.old, 'node/bin/node'),
    bundle = join(f.old, 'lib/phosphor.mjs')
  expect(installedLayout(node, bundle, f.home)).toEqual({
    lib: f.lib,
    current: join(f.lib, 'current'),
    version: '1.0.0',
  })
  expect(commandLayout(f.home, node, bundle)?.version).toBe('1.0.0')
  expect(serviceProgram(node, bundle, f.home)).toEqual({
    node: join(f.lib, 'current/node/bin/node'),
    bundle: join(f.lib, 'current/lib/phosphor.mjs'),
  })
  expect(serviceProgram(process.execPath, bundle, f.home)).toEqual({
    node: process.execPath,
    bundle,
  })
})
it('refuses source programs, different current, invalid versions and linked ancestors', () => {
  const f = setup(),
    node = join(f.old, 'node/bin/node'),
    bundle = join(f.old, 'lib/phosphor.mjs')
  expect(installedLayout(process.execPath, bundle, f.home)).toBeNull()
  const other = f.install('1.0.1')
  expect(
    installedLayout(join(other, 'node/bin/node'), join(other, 'lib/phosphor.mjs'), f.home),
  ).toBeNull()
  rmSync(join(f.lib, 'current'))
  symlinkSync('versions/1.0.1', join(f.lib, 'current'))
  expect(installedLayout(node, bundle, f.home)).toBeNull()
  const invalid = f.install('01.0.0')
  rmSync(join(f.lib, 'current'))
  symlinkSync('versions/01.0.0', join(f.lib, 'current'))
  expect(
    installedLayout(join(invalid, 'node/bin/node'), join(invalid, 'lib/phosphor.mjs'), f.home),
  ).toBeNull()
})
