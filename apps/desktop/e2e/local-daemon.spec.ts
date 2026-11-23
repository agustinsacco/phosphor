import { expect, test } from '@playwright/test'
import { readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assertScratchRoots, resolveRoot, scratchViolations } from './fixtures/assert-scratch'
import { launch, shutdown, type Harness } from './fixtures/local-app'
import {
  FIXTURE_SOCKET_MAX_BYTES,
  localDaemonFixture,
  socketHello,
  type LocalDaemon,
} from './fixtures/local-daemon'
import { migrationFixtureWorld, transcriptWitness } from './fixtures/migration-fixture'
import { scratchDir } from './fixtures/scratch'

/**
 * The local-daemon fixture (E1): a foreground `phosphor run` in local mode
 * whose every root is scratch, and an unpackaged Desktop that reaches it over
 * the owner socket as This Mac. Migration and parity specs build on both.
 */

test('assert-scratch refuses any root outside scratch or under the real home', () => {
  const scratch = resolveRoot(tmpdir())
  expect(scratchViolations({ ok: join(scratch, 'a', 'not-yet') }, [scratch])).toEqual([])
  expect(scratchViolations({ relative: 'state' }, [scratch])).toEqual([
    'relative: state is not absolute',
  ])
  expect(scratchViolations({ outside: '/usr/lib' }, [scratch])[0]).toContain('outside scratch')
  // The scratch folder itself is not a root inside it.
  expect(scratchViolations({ self: scratch }, [scratch])).toHaveLength(1)
  expect(scratchViolations({ home: '/x/home/.pi' }, ['/x'], '/x/home')[0]).toContain('real home')
  expect(() => assertScratchRoots({ up: join(scratch, '..', '..') }, [scratch])).toThrow(
    'Refusing to run outside scratch',
  )
})

test.describe('local daemon', () => {
  let daemon: LocalDaemon | undefined
  let harness: Harness | undefined

  test.afterEach(async () => {
    try {
      if (harness) await shutdown(harness)
    } finally {
      harness = undefined
      await daemon?.close()
      daemon = undefined
    }
  })

  test('serves its owner socket in scratch, with no TCP listener', async () => {
    daemon = await localDaemonFixture()
    assertScratchRoots(daemon.roots, [daemon.root])
    expect(Buffer.byteLength(daemon.socket)).toBeLessThanOrEqual(FIXTURE_SOCKET_MAX_BYTES)
    const hello = await socketHello(daemon.socket)
    expect(hello.status).toBe(200)
    expect(hello.body).toMatchObject({ hello: { hostId: daemon.machineId } })
    expect(await daemon.apiRefused()).toBe(true)
  })

  test('in standby still serves its owner socket and no TCP listener', async () => {
    daemon = await localDaemonFixture({ standby: true })
    expect((await socketHello(daemon.socket)).status).toBe(200)
    expect(await daemon.apiRefused()).toBe(true)
  })

  test('Desktop reaches ready on This Mac over the owner socket', async () => {
    daemon = await localDaemonFixture()
    const { desktopEnv, machineId } = daemon
    harness = await launch({
      userDataDir: desktopEnv.PHOSPHOR_TEST_USER_DATA,
      agentDir: desktopEnv.PI_CODING_AGENT_DIR,
      env: desktopEnv,
    })
    const userData = await harness.app.evaluate(({ app }) => app.getPath('userData'))
    assertScratchRoots({ ...daemon.roots, desktopUserData: userData }, [daemon.root])
    const local = harness.page
    await expect
      .poll(async () => {
        const view = (await local.evaluate(() => window.phosphor.invoke('hosts:snapshot')))[
          machineId
        ]
        return view && { local: view.local, ownerLocal: view.ownerLocal, state: view.state }
      })
      .toEqual({ local: true, ownerLocal: true, state: 'ready' })
    // Reaching ready never opened the daemon's TCP API.
    expect(await daemon.apiRefused()).toBe(true)
  })

  test('without the scratch owner key Desktop stays in-app and says why', async () => {
    daemon = await localDaemonFixture()
    const { PHOSPHOR_E2E_OWNER_KEY: _withheld, ...env } = daemon.desktopEnv
    harness = await launch({
      userDataDir: env.PHOSPHOR_TEST_USER_DATA,
      agentDir: env.PI_CODING_AGENT_DIR,
      env,
    })
    await expect(harness.page.getByTestId('app-shell')).toBeVisible()
    const log = join(env.PHOSPHOR_TEST_USER_DATA, 'logs', 'phosphor.log')
    await expect
      .poll(() => readFile(log, 'utf8').catch(() => ''))
      .toMatch(/e2e daemon hook inert.*PHOSPHOR_E2E_OWNER_KEY/)
    const snapshot = await harness.page.evaluate(() => window.phosphor.invoke('hosts:snapshot'))
    expect(snapshot[daemon.machineId]).toBeUndefined()
  })
})

test('the migration fixture world shows every lane in-app and its transcripts stay put', async () => {
  const root = await scratchDir('phosphor-e2e-world-')
  const roots = { root, userData: join(root, 'user-data'), agentDir: join(root, 'agent') }
  let harness: Harness | undefined
  try {
    const world = await migrationFixtureWorld(roots)
    const before = await transcriptWitness(world)
    expect(Object.values(before)).not.toContain('missing')
    harness = await launch({
      workspace: world.repository,
      userDataDir: roots.userData,
      agentDir: roots.agentDir,
    })
    const rows = harness.page.getByTestId('session-row')
    for (const lane of Object.values(world.lanes))
      await expect(rows.filter({ hasText: lane.name })).toBeVisible()
    await shutdown(harness)
    harness = undefined
    expect(await transcriptWitness(world)).toEqual(before)
  } finally {
    if (harness) await shutdown(harness)
    await rm(root, { recursive: true, force: true })
  }
})
