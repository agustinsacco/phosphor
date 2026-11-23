import { expect, it } from 'vitest'
import {
  settingsServiceFixture,
  removeSettingsFixtures,
} from './__fixtures__/settings-service.fixture'
import { createHeadlessTasks } from './headless-tasks'

it('captures a scoped, fixed-purpose program without a PTY and refuses login programs', async () => {
  const f = await settingsServiceFixture()
  try {
    const task = createHeadlessTasks(
      {
        settings: f.settings,
        home: f.home,
        env: { HOME: f.home, PATH: '' },
        pi: {
          binaryPath: process.execPath,
          prefixArgs: ['-e', 'console.log(process.argv.slice(1).join(" "))', '--'],
        },
      },
      (s) => s,
    )
    const signal = new AbortController().signal
    expect(await task('package.install', 'npm:sample', f.repository.id, signal)).toContain(
      'install npm:sample -l',
    )
    await expect(task('mcp.login' as never, 'sample', undefined, signal)).rejects.toThrow()
  } finally {
    await removeSettingsFixtures()
  }
})
