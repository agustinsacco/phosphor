import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'
import { createVitest } from 'vitest/node'

const configFile = resolve(import.meta.dirname, '../../../vitest.config.ts')
const legacyPaths = [
  'apps/desktop/build.test.ts',
  'apps/desktop/scripts/nested/build.test.ts',
  'apps/desktop/electron/nested/session.test.ts',
  'apps/host/src/nested/session.test.ts',
  'apps/control/src/nested/auth.test.ts',
  'apps/control/scripts/nested/build.test.ts',
  'apps/host/scripts/nested/build.test.ts',
  'libs/session-runtime/src/nested/session.test.ts',
  'libs/shared/src/nested/protocol.test.ts',
  'libs/pi-extensions/pi-ext/nested/guard.test.ts',
  'apps/desktop/src/nested/store.test.ts',
  'apps/desktop/src/nested/view.test.tsx',
  'libs/client-ui/src/nested/store.test.ts',
  'libs/client-ui/src/nested/view.test.tsx',
  'libs/host-client/src/nested/client.test.ts',
  'apps/web/build.test.ts',
  'apps/web/src/nested/platform.test.ts',
  'apps/web/src/nested/view.test.tsx',
  'tools/scripts/nested/release.test.ts',
  'tools/host-release/nested/release.test.ts',
]
const ignoredPaths = [
  'apps/web/e2e/session.test.ts',
  'apps/desktop/e2e/session.test.ts',
  'apps/desktop/e2e/fixtures/session.test.ts',
  'apps/site/src/page.test.ts',
  'apps/site/test/page.test.ts',
  'supabase/test/policy.test.ts',
  'apps/desktop/src/__fixtures__/session.ts',
  'libs/shared/src/__fixtures__/protocol.json',
  'tools/scripts/test/__fixtures__/release.ts',
  'apps/desktop/test/__fixtures__/session.ts',
  'apps/host/test/__fixtures__/session.ts',
  'apps/control/test/__fixtures__/auth.ts',
  'libs/shared/test/__fixtures__/protocol.ts',
  'libs/session-runtime/test/__fixtures__/session.ts',
  'libs/pi-extensions/test/__fixtures__/guard.ts',
  'tools/host-release/test/__fixtures__/release.ts',
]

async function collectLayout(paths: string[]) {
  const root = mkdtempSync(join(tmpdir(), 'phosphor-test-layout-'))
  let runner: Awaited<ReturnType<typeof createVitest>> | undefined
  try {
    for (const path of paths) {
      const file = join(root, path)
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, '')
    }
    runner = await createVitest('test', { root, config: configFile, watch: false })
    const specifications = await runner.globTestSpecifications()
    return {
      files: specifications.map(({ moduleId }) => relative(root, moduleId).replaceAll('\\', '/')),
      environment: runner.config.environment,
      unstubGlobals: runner.config.unstubGlobals,
    }
  } finally {
    await runner?.close()
    rmSync(root, { recursive: true, force: true })
  }
}

describe('vitest.config.ts legacy unit-test layout', () => {
  let layout: Awaited<ReturnType<typeof collectLayout>>
  beforeAll(async () => {
    layout = await collectLayout([...legacyPaths, ...ignoredPaths])
  })

  it('collects every existing include exactly once through the actual config', () => {
    expect(layout.files.sort()).toEqual([...legacyPaths].sort())
    expect(new Set(layout.files).size).toBe(layout.files.length)
  })

  it('does not collect e2e, site, supabase or non-test fixtures', () => {
    for (const path of ignoredPaths) expect(layout.files).not.toContain(path)
  })

  it('keeps node as the default and preserves module-level global stubs', () => {
    expect(layout.environment).toBe('node')
    expect(layout.unstubGlobals).toBe(false)
  })
})

describe('vitest.config.ts relocated unit-test layout', () => {
  it('collects both layouts exactly once, including overlapping tooling globs', async () => {
    const newPaths = [
      'libs/client-ui/test/view.test.tsx',
      'libs/host-client/test/client.test.ts',
      'apps/web/test/platform.test.ts',
      'apps/desktop/test/session.test.ts',
      'apps/desktop/test/nested/session.test.ts',
      'apps/desktop/test/view.test.tsx',
      'apps/desktop/test/nested/view.test.tsx',
      'apps/host/test/session.test.ts',
      'apps/host/test/nested/session.test.ts',
      'apps/control/test/auth.test.ts',
      'apps/control/test/nested/auth.test.ts',
      'libs/shared/test/protocol.test.ts',
      'libs/shared/test/nested/protocol.test.ts',
      'libs/session-runtime/test/session.test.ts',
      'libs/session-runtime/test/nested/session.test.ts',
      'libs/pi-extensions/test/guard.test.ts',
      'libs/pi-extensions/test/nested/guard.test.ts',
      'tools/scripts/test/release.test.ts',
      'tools/scripts/test/nested/release.test.ts',
      'tools/host-release/test/release.test.ts',
      'tools/host-release/test/nested/release.test.ts',
    ]
    const expected = [...legacyPaths, ...newPaths]
    const layout = await collectLayout([...expected, ...ignoredPaths])
    expect(layout.files.sort()).toEqual(expected.sort())
    expect(new Set(layout.files).size).toBe(expected.length)
  })
})
