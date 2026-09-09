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
          .locator('.phosphor-loader-orbit')
          .evaluate((el) => getComputedStyle(el).animationName),
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

for (const theme of ['light', 'dark'] as const) {
  test(`lane beacon stays visible through starting, working and persistence in ${theme}`, async () => {
    const h = await launch(theme)
    try {
      // Drive the real renderer/store through controlled IPC events, so no
      // screenshot/assertion depends on catching a millisecond of the stub.
      await h.app.evaluate(({ ipcMain }, workspace) => {
        ipcMain.removeHandler('pi:createSession')
        ipcMain.handle('pi:createSession', () => ({
          sessionId: 'beacon-test',
          workspacePath: workspace,
        }))
        ipcMain.removeHandler('pi:generateTitle')
        ipcMain.handle('pi:generateTitle', () => null)
        ipcMain.removeHandler('pi:command')
        ipcMain.handle('pi:command', (_event, _id, command) =>
          command.type === 'get_state'
            ? {
                success: true,
                data: { sessionFile: `${workspace}/beacon.jsonl`, isStreaming: false },
              }
            : { success: command.type === 'prompt' },
        )
      }, h.workspace)
      await h.page
        .getByPlaceholder('Describe a task or ask a question')
        .fill('Reimagine Phosphor loading')
      await h.page.getByRole('button', { name: /Start session/i }).click()
      const row = h.page.getByTestId('session-row')
      await expect(row).toHaveAttribute('data-pending', 'true')
      await expect(row).toHaveAttribute('data-activity', 'starting')
      await expect(row.locator('.lane-activity-label')).toHaveText('Starting')
      await expect(row.locator('.phosphor-loader')).toHaveCSS('width', '20px')
      await expect(row.locator('.phosphor-loader-orbit')).toHaveCSS(
        'animation-name',
        'px-beacon-orbit',
      )
      const orbit = row.locator('.phosphor-loader-orbit')
      const initialTransform = await orbit.evaluate((el) => getComputedStyle(el).transform)
      await expect
        .poll(() => orbit.evaluate((el) => getComputedStyle(el).transform))
        .not.toBe(initialTransform)
      await expect(
        h.page.getByTestId('booting-indicator').locator('.phosphor-loader'),
      ).toBeVisible()
      await h.app.evaluate(({ BrowserWindow }) => {
        BrowserWindow.getAllWindows()[0]!.webContents.send('pi:event:beacon-test', {
          kind: 'event',
          event: { type: 'agent_start' },
        })
      })
      await expect(row).toHaveAttribute('data-activity', 'working')
      await expect(row.locator('.lane-activity-label')).toHaveText('Working')
      await expect(h.page.getByTestId('working-indicator')).toContainText('Working')
      await expect(h.page.getByTestId('booting-indicator')).toHaveCount(0)

      // Simulate the first session file becoming discoverable. The same
      // working treatment must survive PendingSessionRow → SessionRow.
      await h.app.evaluate(({ ipcMain, BrowserWindow }, workspace) => {
        ipcMain.removeHandler('git:infoBatch')
        ipcMain.handle('git:infoBatch', () => ({
          [workspace]: {
            isRepo: true,
            isWorktree: true,
            mainRepoPath: workspace,
            branch: 'feature/appearance-aware-long-branch',
            dirtyCount: 7,
          },
        }))
        ipcMain.removeHandler('sessions:list')
        ipcMain.handle('sessions:list', () => [
          {
            path: `${workspace}/beacon.jsonl`,
            sessionId: 'beacon-test',
            cwd: workspace,
            createdAt: new Date().toISOString(),
            mtimeMs: Date.now(),
            firstUserText: 'Reimagine Phosphor loading',
            userMessages: 1,
            assistantMessages: 0,
            toolCalls: 0,
            totalTokens: 0,
            inputTokens: 0,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            cost: 0,
            headroomSavedTokens: 0,
            entryCount: 1,
            branchCount: 0,
          },
        ])
        BrowserWindow.getAllWindows()[0]!.webContents.send('sessions:changed', {
          workspacePath: workspace,
        })
      }, h.workspace)
      await expect(row).not.toHaveAttribute('data-pending')
      await expect(row.locator('[data-segment="branch"]')).toBeVisible()
      await expect(row).toHaveAttribute('data-activity', 'working')
      await h.page.getByRole('button', { name: /^New$/ }).click()
      await expect(row).toHaveAttribute('data-activity', 'working')
      expect(await row.evaluate((el) => getComputedStyle(el, '::before').backgroundColor)).toBe(
        theme === 'dark' ? 'rgb(236, 160, 61)' : 'rgb(179, 92, 15)',
      )
      // Both the icon gutter and checkbox reserve 20px: hovering doesn't
      // nudge the title, or hide every working cue when the icon is replaced.
      const title = row.getByTestId('session-title')
      const before = await title.boundingBox()
      await row.hover()
      expect((await title.boundingBox())?.x).toBe(before?.x)
      await expect(row.locator('.lane-activity-label')).toBeVisible()
      await h.page.mouse.move(600, 400)
      await h.page.emulateMedia({ reducedMotion: 'reduce' })
      await expect(row.locator('.phosphor-loader-orbit')).toHaveCSS('animation-name', 'none')
      await expect(row.locator('.phosphor-loader-core')).toHaveCSS('animation-name', 'none')
      await h.page
        .locator('aside')
        .screenshot({ path: test.info().outputPath(`lane-beacon-${theme}.png`) })
      // The aside's resize handle intentionally extends outside its box;
      // the actual lane content, not that handle, must fit without overflow.
      expect(await row.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true)
      const sidebar = await h.page.locator('aside').boundingBox()
      await h.page.mouse.move(sidebar!.x + sidebar!.width - 1, sidebar!.y + 100)
      await h.page.mouse.down()
      await h.page.mouse.move(sidebar!.x + 200, sidebar!.y + 100)
      await h.page.mouse.up()
      await expect(h.page.locator('aside')).toHaveCSS('width', '208px')
      expect(await row.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true)
      await expect(row.locator('.lane-activity-label')).toBeVisible()
      await expect(row.locator('[data-segment="branch"]')).toBeVisible()

      await h.app.evaluate(({ BrowserWindow }) => {
        BrowserWindow.getAllWindows()[0]!.webContents.send('pi:event:beacon-test', {
          kind: 'event',
          event: { type: 'agent_end', messages: [] },
        })
      })
      await expect(row).not.toHaveAttribute('data-activity')
      await expect(row.locator('.phosphor-loader')).toHaveCount(0)
      await expect(row.locator('.lane-activity-label')).toHaveCount(0)
      await expect(h.page.getByTestId('startup-screen')).toHaveCount(0)
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
    await expect(h.page.locator('.phosphor-loader-orbit')).toHaveCSS('animation-name', 'none')
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
