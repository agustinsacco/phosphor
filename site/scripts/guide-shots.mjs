// Capture the actual renderer with fictional data only. Never attach to Electron
// or an existing user profile. Run the browser harness separately on port 5199.
/* global window, document */
import { chromium, expect } from '@playwright/test'
import { mkdir } from 'node:fs/promises'
import { fileURLToPath, URL } from 'node:url'
import sharp from 'sharp'

const baseURL = process.env.GUIDE_HARNESS_URL || 'http://127.0.0.1:5199'
if (!['127.0.0.1', 'localhost'].includes(new URL(baseURL).hostname)) {
  throw new Error('Guide captures require the local mock renderer')
}
const output = fileURLToPath(new URL('../src/assets/shots/', import.meta.url))
await mkdir(output, { recursive: true })
const browser = await chromium.launch()
try {
  const page = await browser.newPage({
    viewport: { width: 1280, height: 1000 },
    deviceScaleFactor: 2,
  })
  // No external services, credentials, or profiles are used by this capture.
  await page.route('**/*', (route) => {
    const url = new URL(route.request().url())
    return url.origin === new URL(baseURL).origin ? route.continue() : route.abort()
  })
  await page.goto(baseURL)
  await page.waitForFunction(() => window.phosphor)
  await page.evaluate(() => {
    const invoke = window.phosphor.invoke.bind(window.phosphor)
    window.phosphor.invoke = async (channel, ...args) => {
      const result = await invoke(channel, ...args)
      if (channel === 'packages:list') {
        return result.map((entry) =>
          entry.spec.includes('pi-claude-cli')
            ? { ...entry, version: '0.8.0' }
            : entry.spec.includes('pi-mcp-adapter')
              ? { ...entry, installed: true }
              : entry,
        )
      }
      if (channel === 'mcp:readConfigs') {
        return {
          ...result,
          servers: [
            {
              name: 'linear',
              config: { url: 'https://mcp.linear.app/mcp' },
              scope: 'pi-global',
              shadows: [],
            },
          ],
          files: result.files.map((file) => ({
            ...file,
            serverNames: file.scope === 'pi-global' ? ['linear'] : [],
            exists: file.scope === 'pi-global',
          })),
        }
      }
      if (channel === 'claude:accountSessions') return {}
      if (channel === 'packages:claudeStatus') {
        return {
          binary: { found: true, path: '/usr/local/bin/claude', version: '2.1.263' },
          auth: { ok: true, loggedIn: true, email: 'hidden@example.com', plan: 'max' },
        }
      }
      if (channel === 'packages:claudeCliLatest') return '2.1.263'
      if (channel === 'packages:checkUpdates') return {}
      if (channel === 'claude:accounts' || channel === 'claude:refreshAccountUsage') {
        const accounts = result.prefs.accounts.map((account, i) => ({
          ...account,
          label: `Account ${i === 0 ? 'A' : 'B'}`,
          email: '••••@example.com',
          plan: 'max',
          credentialDir: null,
        }))
        return {
          ...result,
          prefs: { ...result.prefs, accounts },
          views: result.views.map((view, i) => ({
            ...view,
            account: accounts[i],
            auth: { ...view.auth, email: '••••@example.com', plan: 'max', organization: undefined },
          })),
        }
      }
      return result
    }
  })
  await page.getByRole('button', { name: /phosphor.*\/Users\/dev\/projects\/phosphor/s }).click()
  await page.keyboard.press('ControlOrMeta+,')
  const modal = page
    .locator('div.rounded-2xl')
    .filter({ has: page.getByRole('button', { name: 'Extensions', exact: true }) })
  await expect(modal).toBeVisible()
  const capture = async (name) => {
    await page.evaluate(() => document.fonts.ready)
    // Fail before writing pixels if fixture identities leak into a settings view.
    await expect(modal).not.toContainText(/dev@|hidden@example\.com|\/Users\/dev\//)
    const bytes = await modal.screenshot({ animations: 'disabled' })
    // Re-encode with no metadata. The full-size linked original is safe too.
    await sharp(bytes).webp({ quality: 88 }).toFile(`${output}/guide-${name}.webp`)
  }
  await modal.getByRole('button', { name: 'Extensions', exact: true }).click()
  await expect(modal.getByText('Recommended', { exact: true })).toBeVisible()
  await capture('extensions')
  await modal.getByRole('button', { name: 'Claude Code', exact: true }).click()
  await expect(modal.getByRole('button', { name: /Account A/ }).first()).toBeVisible()
  await expect(modal.getByText(/v0.8.0/)).toBeVisible()
  await capture('claude')
  await modal.getByText('Route new sessions', { exact: true }).evaluate((heading) => {
    const pane = heading.closest('.overflow-y-auto')
    pane.scrollTop += heading.getBoundingClientRect().top - pane.getBoundingClientRect().top - 290
  })
  await capture('routing')
  await modal.getByRole('button', { name: 'MCP Connectors', exact: true }).click()
  await expect(modal.getByText('Add a connector', { exact: true })).toBeVisible()
  await modal.locator('.overflow-y-auto').evaluate((pane) => {
    pane.scrollTop = 0
  })
  await capture('connectors')
  console.log(
    'Captured four settings views using fictional, masked accounts. No live credentials loaded.',
  )
} finally {
  await browser.close()
}
