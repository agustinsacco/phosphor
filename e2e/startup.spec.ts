import { test, expect, _electron as electron, type ElectronApplication } from '@playwright/test'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

async function launch(theme: 'light' | 'dark' | 'system') {
  const scratch = await mkdtemp(join(tmpdir(), 'phosphor-startup-'))
  const workspace = join(scratch, 'workspace')
  const userData = join(scratch, 'prefs')
  await mkdir(workspace)
  await mkdir(userData)
  await writeFile(
    join(userData, 'config.json'),
    JSON.stringify({ theme, lastWorkspacePath: workspace }),
  )
  const env = { ...process.env }
  delete env.ELECTRON_RENDERER_URL
  delete env.NODE_ENV_ELECTRON_VITE
  delete env.ELECTRON_CLI_ARGS
  const app = await electron.launch({
    args: [resolve('.')],
    env: {
      ...env,
      NODE_ENV: 'production',
      PHOSPHOR_PI_STUB: resolve('e2e/fixtures/pi-stub.cjs'),
      PHOSPHOR_TEST_USER_DATA: userData,
      PI_CODING_AGENT_DIR: join(scratch, 'agent'),
    },
  })
  const page = await app.firstWindow()
  await expect(page.getByTestId('app-shell')).toBeVisible()
  return {
    app,
    page,
    workspace,
    close: async () => {
      await app.close()
      await rm(scratch, { recursive: true, force: true })
    },
  }
}

// Hold real IPC boundaries, not a UI timer: the screen must follow actual
// readiness, and no production-only delay/test hook is needed.
async function holdStartup(app: ElectronApplication, workspace: string) {
  await app.evaluate(({ ipcMain }, path) => {
    const gates = globalThis as unknown as {
      resume: () => void
      scan: () => void
    }
    const resume = new Promise<void>((resolve) => {
      gates.resume = resolve
    })
    const scan = new Promise<void>((resolve) => {
      gates.scan = resolve
    })
    ipcMain.removeHandler('app:resumeTarget')
    ipcMain.handle('app:resumeTarget', async () => {
      await resume
      return { kind: 'workspace', workspacePath: path }
    })
    ipcMain.removeHandler('sessions:list')
    ipcMain.handle('sessions:list', async () => {
      await scan
      return []
    })
  }, workspace)
}

for (const theme of ['light', 'dark'] as const) {
  test(`startup covers restoration and sidebar scanning in saved ${theme} appearance`, async () => {
    const h = await launch(theme)
    try {
      await holdStartup(h.app, h.workspace)
      await h.page.reload()
      const screen = h.page.getByTestId('startup-screen')
      await expect(screen).toBeVisible()
      await expect(screen).toHaveCSS(
        'background-color',
        theme === 'dark' ? 'rgb(30, 28, 24)' : 'rgb(247, 247, 248)',
      )
      expect(
        await h.app.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows()[0]!.getBackgroundColor().toLowerCase(),
        ),
      ).toBe(theme === 'dark' ? '#1e1c18' : '#f7f7f8')
      await expect(screen.getByRole('status')).toHaveText('Restoring your workspace…')
      await h.app.evaluate(() => (globalThis as unknown as { resume: () => void }).resume())
      await expect(screen.getByRole('status')).toHaveText('Loading your sessions…')
      await expect(h.page.getByTestId('app-shell')).toBeHidden()
      await expect(h.page.getByTestId('app-shell')).toHaveAttribute('inert', '')
      await h.page.keyboard.press('Control+b')
      await expect(screen).toBeVisible()
      await h.page.emulateMedia({ reducedMotion: 'reduce' })
      expect(
        await screen
          .locator('.startup-progress')
          .evaluate((el) => getComputedStyle(el, '::after').animationName),
      ).toBe('none')
      await h.page.screenshot({ path: test.info().outputPath(`startup-${theme}.png`) })
      await h.app.evaluate(() => (globalThis as unknown as { scan: () => void }).scan())
      await expect(screen).toHaveCount(0)
      await expect(h.page.getByTestId('app-shell')).toBeVisible()
      await expect(h.page.getByTestId('app-shell')).not.toHaveAttribute('inert')
      await expect(h.page.getByRole('button', { name: /^New$/ })).toBeVisible()
      // Subsequent workspace activity must not re-arm the launch screen.
      await h.page.getByRole('button', { name: /^New$/ }).click()
      await expect(screen).toHaveCount(0)
    } finally {
      await h.close()
    }
  })
}

test('startup waits for the restored transcript even after the sidebar is ready', async () => {
  const h = await launch('dark')
  try {
    await h.app.evaluate(({ ipcMain }, workspace) => {
      const history = new Promise<void>((resolve) => {
        ;(globalThis as unknown as { historyReady: () => void }).historyReady = resolve
      })
      ipcMain.removeHandler('app:resumeTarget')
      ipcMain.handle('app:resumeTarget', () => ({
        kind: 'session',
        workspacePath: workspace,
        sessionPath: `${workspace}/saved.jsonl`,
      }))
      ipcMain.removeHandler('pi:createSession')
      ipcMain.handle('pi:createSession', () => ({ sessionId: 'restoring-test' }))
      ipcMain.removeHandler('pi:command')
      ipcMain.handle('pi:command', async (_event, _id, command) => {
        if (command.type !== 'get_messages') return { success: false, error: 'not supported' }
        await history
        return {
          success: true,
          data: { messages: [{ role: 'user', content: 'Restored conversation', timestamp: 1 }] },
        }
      })
    }, h.workspace)
    await h.page.reload()
    const screen = h.page.getByTestId('startup-screen')
    await expect(screen.getByRole('status')).toHaveText('Restoring your workspace…')
    // Group headers replace skeletons only once Sidebar's initial scan settles.
    await expect(h.page.getByTestId('workspace-group')).toHaveCount(1)
    await expect(h.page.getByTestId('app-shell')).toBeHidden()
    await h.app.evaluate(() =>
      (globalThis as unknown as { historyReady: () => void }).historyReady(),
    )
    await expect(screen).toHaveCount(0)
    await expect(h.page.getByTestId('user-message')).toHaveText('Restored conversation')
    await expect(h.page.getByTestId('user-message')).toBeVisible()
    await expect(h.page.getByPlaceholder(/Describe a task…/)).toBeVisible()
  } finally {
    await h.close()
  }
})

test('system appearance follows the OS before async preferences arrive', async () => {
  const h = await launch('system')
  try {
    await holdStartup(h.app, h.workspace)
    // Hold preference hydration too, so these assertions exercise PRELOAD,
    // not a corrected theme after React/settings have already caught up.
    await h.app.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('app:getPrefs')
      ipcMain.handle('app:getPrefs', () => new Promise(() => {}))
    })
    for (const theme of ['light', 'dark'] as const) {
      await h.app.evaluate(({ nativeTheme }, value) => {
        nativeTheme.themeSource = value
      }, theme)
      await h.page.emulateMedia({ colorScheme: theme })
      await h.page.reload()
      await expect(h.page.getByTestId('startup-screen')).toBeVisible()
      await expect(h.page.getByTestId('startup-screen')).toHaveCSS(
        'background-color',
        theme === 'dark' ? 'rgb(30, 28, 24)' : 'rgb(247, 247, 248)',
      )
    }
  } finally {
    await h.close()
  }
})

test('startup errors offer recovery instead of an endless loading screen', async () => {
  const h = await launch('light')
  try {
    await h.app.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('app:resumeTarget')
      ipcMain.handle('app:resumeTarget', () => {
        throw new Error('unavailable')
      })
    })
    await h.page.reload()
    await expect(h.page.getByRole('alert')).toHaveText('Couldn’t restore your last session.')
    await h.page.getByRole('button', { name: 'Continue without restoring' }).click()
    await expect(h.page.getByRole('button', { name: /Open Folder/ })).toBeVisible()
    await expect(h.page.getByTestId('startup-screen')).toHaveCount(0)

    await h.app.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('pi:health')
      ipcMain.handle('pi:health', () => {
        throw new Error('unavailable')
      })
    })
    await h.page.reload()
    await expect(h.page.getByRole('alert')).toHaveText('Couldn’t check your pi installation.')
    await expect(h.page.getByRole('button', { name: 'Try again' })).toBeVisible()
    await h.app.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('pi:health')
      ipcMain.handle('pi:health', () => ({ ok: false, reason: 'not-found' }))
    })
    await h.page.getByRole('button', { name: 'Try again' }).click()
    await expect(h.page.getByTestId('startup-screen')).toHaveCount(0)
    await expect(h.page.getByRole('heading', { name: /pi/i }).first()).toBeVisible()
  } finally {
    await h.close()
  }
})
