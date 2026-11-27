import { expect, test } from '@playwright/test'
import { readFile, stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { browserFixture } from './fixture'

for (const [agentOps, stub] of [
  [false, 'apps/host/src/__fixtures__/fake-pi.cjs'],
  [true, 'apps/desktop/e2e/fixtures/host-ops-pi.cjs'],
] as const) {
  test(`the CLI fixture seeds both repositories with the ${agentOps ? 'agent ops' : 'default'} pi`, async () => {
    const stack = await browserFixture(false, false, agentOps)
    try {
      const root = dirname(stack.repository)
      const other = join(root, 'other')
      expect(stack.laneId).toMatch(/^[0-9a-f-]{36}$/)
      expect(stack.secondLaneId).toMatch(/^[0-9a-f-]{36}$/)
      expect(stack.laneId).not.toBe(stack.secondLaneId)
      expect(await readFile(join(stack.repository, 'remote.txt'), 'utf8')).toBe(
        'HOST_A_ONLY synthetic file\n',
      )
      expect(await readFile(join(other, 'remote.txt'), 'utf8')).toBe('HOST_B_ONLY synthetic file\n')
      expect((await stat(join(other, '.git'))).isDirectory()).toBe(true)
      const config = join(root, 'config', 'config.json')
      expect(JSON.parse(await readFile(config, 'utf8'))).toMatchObject({
        repositories: [stack.repository, other],
        pi: { executable: resolve(import.meta.dirname, '../../..', stub), node: process.execPath },
        api: { webOrigin: stack.origin },
      })
      for (const path of [
        config,
        join(root, 'agent', 'auth.json'),
        join(root, 'config', 'identity', `host-key.${stack.hostId}.pem`),
      ])
        expect((await stat(path)).mode & 0o777).toBe(0o600)
    } finally {
      await stack.close()
    }
  })
}
