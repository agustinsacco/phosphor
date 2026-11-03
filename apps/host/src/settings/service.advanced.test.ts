import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  removeSettingsFixtures,
  settingsServiceFixture as fixture,
} from './__fixtures__/settings-service.fixture'
vi.mock('@phosphor/session-runtime/pi/print-mode', () => ({ runPrintMode: vi.fn() }))
afterEach(removeSettingsFixtures)

describe('Host Advanced diagnostics', () => {
  it('reports the pi the Host runs: its version, where it is and its agent folder', async () => {
    const f = await fixture()
    expect((await f.read('advanced')).advanced?.pi).toEqual({
      version: '1.2.0',
      path: '/opt/pi/cli.js',
      agentDir: f.agentDir,
    })
  })
})
