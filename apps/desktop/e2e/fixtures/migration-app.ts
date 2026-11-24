import { expect, test as base, type Page } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { MigrationJournal } from '../../electron/local-machine/migration/journal'
import { type LocalDaemon, localDaemonFixture } from './local-daemon'
import { type Harness, launch } from './local-app'
import { migrationWorld } from './migration-world'

export const status = (page: Page) =>
  page.evaluate(() => window.phosphor.invoke('app:localMachine'))

async function scenario(daemon: LocalDaemon) {
  const { home, userData, agentDir, configHome, stateHome, runtimeDir } = daemon.roots
  const world = await migrationWorld({ root: daemon.root, userData, agentDir })
  let app: Harness | undefined
  const close = async () => {
    if (app) {
      await app.app.close()
      app = undefined
    }
  }
  const start = async (extra: Record<string, string> = {}, args: string[] = []) => {
    await close()
    app = await launch({
      workspace: world.repository,
      args,
      // A restore refusal quits Desktop. Never block CI on its native error box.
      beforeWindow: args.includes('--restore-in-app-runtime')
        ? (app) =>
            app.evaluate(({ dialog }) => {
              dialog.showErrorBox = () => {}
            })
        : undefined,
      env: {
        ...daemon.desktopEnv,
        HOME: home,
        CFFIXED_USER_HOME: home,
        XDG_CONFIG_HOME: configHome,
        XDG_STATE_HOME: stateHome,
        XDG_RUNTIME_DIR: runtimeDir,
        TMPDIR: daemon.root,
        CODEX_HOME: join(home, '.codex'),
        CLAUDE_CONFIG_DIR: join(home, '.claude'),
        PHOSPHOR_ACCOUNT_NO_KEYCHAIN: '1',
        PHOSPHOR_DAEMON_ROOT: '',
        PHOSPHOR_MIGRATE: '1',
        PHOSPHOR_E2E_SERVICE_FEATURES: 'local-mode,owner-socket,app-services',
        PHOSPHOR_MIGRATION_CRASH_AT: '',
        ...extra,
      },
    })
    return app.page
  }
  const journal = async (): Promise<MigrationJournal> =>
    JSON.parse(await readFile(join(userData, 'daemon-migration', 'journal.json'), 'utf8'))
  return { start, close, journal, daemon, world }
}

export type MigrationApp = Awaited<ReturnType<typeof scenario>>

export const test = base.extend<{ migration: MigrationApp }>({
  migration: async ({ browserName: _browserName }, use, info) => {
    const daemon = await localDaemonFixture({ standby: true })
    try {
      const app = await scenario(daemon)
      try {
        await use(app)
      } finally {
        await app.close()
        for (const file of ['daemon-migration/journal.json', 'logs/phosphor.log']) {
          const body = await readFile(join(daemon.roots.userData, file), 'utf8').catch(() => '')
          if (body)
            await info.attach(file.split('/').at(-1)!, {
              body: body.slice(-65536),
              contentType: 'text/plain',
            })
        }
      }
    } finally {
      await daemon.close()
    }
  },
})

export async function committed(page: Page) {
  await expect
    .poll(() => status(page).catch((error: unknown) => String(error)))
    .toMatchObject({ mode: 'daemon', migration: 'committed', service: 'ready' })
}
