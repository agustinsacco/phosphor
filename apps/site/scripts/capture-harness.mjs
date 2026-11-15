// Actual Desktop renderer; only in-memory, fictional API results. No Electron or live data.
/* global window, document, localStorage */
import { chromium, expect } from '@playwright/test'
import sharp from 'sharp'
import { mkdir, writeFile, readdir, stat } from 'node:fs/promises'
import { fileURLToPath, URL } from 'node:url'

export const root = fileURLToPath(new URL('../../../', import.meta.url))
export const source = `/@fs${root}libs/client-ui/src/`
export const base = process.env.GUIDE_HARNESS_URL || 'http://127.0.0.1:5199'
if (!['127.0.0.1', 'localhost'].includes(new URL(base).hostname))
  throw new Error('Only a local isolated renderer is allowed')
export const inventory = []
export async function launchCapture() {
  const browser = await chromium.launch({ args: ['--enable-unsafe-swiftshader'] })
  const page = await browser.newPage({
    viewport: { width: 1600, height: 1000 },
    deviceScaleFactor: 1,
    locale: 'en-US',
    timezoneId: 'UTC',
    reducedMotion: 'reduce',
  })
  await page.route('**/*', (route) =>
    new URL(route.request().url()).origin === new URL(base).origin
      ? route.continue()
      : route.abort(),
  )
  await page.addInitScript(() => {
    localStorage.setItem('mock:accountState', 'signed-in')
    localStorage.setItem('mock:machinesState', 'mixed')
    localStorage.setItem('mock:remoteLanes', '1')
    localStorage.setItem('mock:remoteMixed', '1')
  })
  await page.goto(base)
  await page.waitForFunction(() => window.__chatStore && window.phosphor)
  await page.evaluate(() => {
    const invoke = window.phosphor.invoke.bind(window.phosphor)
    // Harness fixtures contain public project identifiers; substitute fictional ones in data,
    // never by editing rendered DOM or covering pixels.
    const safe = (value) =>
      JSON.parse(
        JSON.stringify(value)
          .replaceAll('agustinsacco', 'harbor-demo')
          .replaceAll('agustin/', 'demo/')
          .replaceAll('dev@work.example', 'account-b@example.com')
          .replaceAll('dev@example.com', 'account-a@example.com'),
      )
    window.phosphor.invoke = async (channel, ...args) => {
      if (channel === 'packages:claudeCliLatest') return '2.1.263'
      if (channel === 'packages:checkUpdates') return {}
      const result = await invoke(channel, ...args)
      if (channel === 'sessions:stats') return { ...result, savedTokens: 0 }
      if (channel === 'packages:list')
        return safe(
          result.map((entry) =>
            entry.spec.includes('pi-claude-cli') ? { ...entry, version: '0.10.0' } : entry,
          ),
        )
      if (channel === 'packages:claudeStatus')
        return safe({ ...result, binary: { ...result.binary, version: '2.1.263' } })
      return result === undefined ? result : safe(result)
    }
  })
  await page.getByRole('button', { name: /phosphor.*\/Users\/dev\/projects\/phosphor/s }).click()
  await page.waitForTimeout(5000)
  return { browser, page }
}
export async function shot(page, name, subject = page) {
  await page.evaluate(() => document.fonts.ready)
  await page.mouse.move(1590, 990)
  await page.waitForTimeout(900)
  await expect(page.locator('body')).not.toContainText(/agustinsacco|saccoagustin|sk-ant-|ghp_/i)
  const image = await subject.screenshot({ animations: 'disabled' })
  const site = `${root}apps/site/src/assets/shots/${name}.webp`
  const docs = `${root}docs/img/${name}.png`
  if (name === 'ide-flex') await sharp(image).png().toFile(site.replace('.webp', '.png'))
  else await sharp(image).webp({ quality: 90, effort: 6 }).toFile(site)
  await sharp(image).png().toFile(docs)
  const output = name === 'ide-flex' ? site.replace('.webp', '.png') : site
  const metadata = await sharp(output).metadata()
  const { size } = await stat(output)
  inventory.push({
    name,
    width: metadata.width,
    height: metadata.height,
    bytes: size,
    provenance:
      'Current renderer; isolated browser; fictional in-memory fixtures; no external requests',
  })
  console.log(`Captured ${name}: ${metadata.width}×${metadata.height}, ${size} bytes`)
}
export async function settings(page, tab) {
  await page.evaluate(
    async ({ source, tab }) => {
      const { useSettingsUiStore } = await import(`${source}features/settings/settingsUiStore.ts`)
      useSettingsUiStore.setState({ open: true, tab, machine: 'local', query: '', listing: false })
    },
    { source, tab },
  )
  await page.waitForTimeout(1200)
}
export async function closeSettings(page) {
  await page.evaluate(async (source) => {
    const { useSettingsUiStore } = await import(`${source}features/settings/settingsUiStore.ts`)
    useSettingsUiStore.getState().setOpen(false)
  }, source)
}
export async function finishInventory() {
  const files = []
  for (const directory of ['apps/site/src/assets/shots', 'docs/img']) {
    for (const name of (await readdir(`${root}${directory}`)).sort()) {
      if (!/\.(png|webp)$/.test(name)) continue
      const path = `${directory}/${name}`
      const metadata = await sharp(`${root}${path}`).metadata()
      const { size } = await stat(`${root}${path}`)
      if (metadata.exif || metadata.xmp || metadata.icc)
        throw new Error(`Unexpected metadata: ${path}`)
      files.push({
        path,
        width: metadata.width,
        height: metadata.height,
        bytes: size,
        provenance: 'Product demo · fictional data; current renderer',
      })
    }
  }
  await mkdir(`${root}apps/site/scripts/fixtures`, { recursive: true })
  await writeFile(
    `${root}apps/site/scripts/fixtures/capture-inventory.json`,
    JSON.stringify(files, null, 2) + '\n',
  )
}
