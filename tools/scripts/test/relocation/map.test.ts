import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  assertContained,
  findCollisions,
  relocationTarget,
  SHIPPING_FIXTURE,
  SHIPPING_DESTINATION,
} from '../../relocation/map.mjs'

const directories: string[] = []
const temporary = () => {
  const root = mkdtempSync(join(tmpdir(), 'relocation-map-'))
  directories.push(root)
  return root
}
afterEach(() =>
  directories.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })),
)

describe('relocation mapping table', () => {
  it.each([
    ['apps/desktop/electron/pi/a.test.ts', 'apps/desktop/test/main/pi/a.test.ts'],
    ['apps/desktop/src/chat/a.test.tsx', 'apps/desktop/test/renderer/chat/a.test.tsx'],
    ['apps/desktop/scripts/__tests__/a.test.ts', 'apps/desktop/test/scripts/a.test.ts'],
    ['apps/desktop/a.test.ts', 'apps/desktop/test/a.test.ts'],
    ['apps/host/src/api/a.test.ts', 'apps/host/test/api/a.test.ts'],
    ['apps/host/scripts/__tests__/a.test.ts', 'apps/host/test/scripts/a.test.ts'],
    ['apps/control/src/api/a.test.ts', 'apps/control/test/api/a.test.ts'],
    ['apps/control/scripts/a.test.ts', 'apps/control/test/scripts/a.test.ts'],
    ['libs/shared/src/rpc.test.ts', 'libs/shared/test/rpc.test.ts'],
    ['libs/session-runtime/src/pi/a.test.ts', 'libs/session-runtime/test/pi/a.test.ts'],
    ['libs/pi-extensions/pi-ext/a.test.ts', 'libs/pi-extensions/test/a.test.ts'],
    ['tools/scripts/__tests__/a.test.ts', 'tools/scripts/test/a.test.ts'],
    ['tools/host-release/a.test.ts', 'tools/host-release/test/a.test.ts'],
    ['apps/host/src/has spaces/a.test.ts', 'apps/host/test/has spaces/a.test.ts'],
    ['libs/client-ui/src/chat/a.test.tsx', 'libs/client-ui/test/chat/a.test.tsx'],
    ['libs/host-client/src/client.test.ts', 'libs/host-client/test/client.test.ts'],
    ['apps/web/src/platform/a.test.ts', 'apps/web/test/platform/a.test.ts'],
    ['apps/web/build-policy.test.ts', 'apps/web/test/build-policy.test.ts'],
    [SHIPPING_FIXTURE, SHIPPING_DESTINATION],
  ])('maps %s to %s', (from, to) => expect(relocationTarget(from)).toBe(to))

  it.each([
    'apps/desktop/e2e/smoke.spec.ts',
    'apps/site/src/a.test.ts',
    'supabase/tests/a.test.ts',
    'libs/client-ui/test/chat/a.test.tsx',
    'libs/host-client/test/client.test.ts',
    'apps/web/test/platform/a.test.ts',
    'apps/desktop/test/main/a.test.ts',
    'apps/host/test/a.test.ts',
    'apps/control/test/a.test.ts',
    'libs/shared/test/a.test.ts',
    'libs/session-runtime/test/a.test.ts',
    'libs/pi-extensions/test/a.test.ts',
    'tools/scripts/test/a.test.ts',
    'tools/host-release/test/a.test.ts',
  ])('leaves %s unchanged', (file) => expect(relocationTarget(file)).toBe(file))

  it('detects flattening collisions and occupied destinations without case sensitivity', () => {
    const files = ['tools/scripts/a.test.ts', 'tools/scripts/__tests__/A.test.ts']
    const moves = files.map((from) => ({ from, to: relocationTarget(from) }))
    expect(findCollisions(files, moves)).toEqual([
      { ...moves[1], existing: 'tools/scripts/test/a.test.ts' },
    ])
    expect(
      findCollisions(
        ['apps/host/test/A.test.ts'],
        [{ from: 'apps/host/src/a.test.ts', to: 'apps/host/test/a.test.ts' }],
      ),
    ).toHaveLength(1)
    expect(
      findCollisions(files, [{ from: files[0]!, to: 'tools/scripts/test/a.test.ts' }]),
    ).toEqual([])
  })

  it.each(['../bad.ts', '/tmp/a.ts', 'a/../b.ts', 'C:/a.ts', 'a\\b.ts'])('rejects %s', (file) => {
    expect(() => relocationTarget(file)).toThrow('Invalid repository path')
  })

  it('checks source and nonexistent destination ancestors for symlink escapes', () => {
    const root = temporary()
    const outside = temporary()
    writeFileSync(join(outside, 'a.ts'), '')
    symlinkSync(outside, join(root, 'escape'))
    expect(() => assertContained(root, 'escape/a.ts')).toThrow('Symlink escape')
    expect(() => assertContained(root, 'escape/new/a.ts')).toThrow('Symlink escape')
    mkdirSync(join(root, 'inside'))
    symlinkSync(join(root, 'inside'), join(root, 'link'))
    expect(() => assertContained(root, 'link/new.ts')).not.toThrow()
  })
})
