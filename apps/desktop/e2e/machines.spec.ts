import { test, expect } from '@playwright/test'
import { readFile, mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { accountControlFixture } from './fixtures/account-control'
import { MACHINE } from '../src/features/machines/__fixtures__/control'

test('Machines is always available, shows only this computer while signed out, and Settings owns feedback', async () => {
  const h = await accountControlFixture()
  const { page } = h
  try {
    await page.getByRole('button', { name: 'Machines', exact: true }).click()
    await expect(page.getByTestId('machines-page')).toBeVisible()
    await expect(page.getByTestId('local-machine-row')).toBeVisible()
    await expect(page.getByTestId('enrolled-machine-row')).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Add a machine', exact: true })).toBeDisabled()
    await expect(
      page.getByText('Sign in with GitHub to add other machines', { exact: true }),
    ).toBeVisible()
    await expect(page.getByTestId('machine-filter')).toHaveCount(0)
    await expect(page.getByTestId('lane-machine')).toHaveCount(0)
    await expect(page.getByTestId('run-on')).toHaveCount(0)
    await page.getByTestId('local-machine-row').click()
    await expect(page.getByTestId('machine-detail')).toContainText('Readiness')
    await expect(page.getByRole('tab')).toHaveCount(0)
    await page
      .getByTestId('account-footer')
      .getByRole('button', { name: 'Settings', exact: true })
      .click()
    const settings = page.getByRole('dialog', { name: 'Settings', exact: true })
    await expect(
      settings.getByTestId('settings-footer').getByTestId('feedback-button'),
    ).toBeVisible()
    await settings.getByRole('button', { name: 'Advanced', exact: true }).click()
    await expect(settings).not.toContainText('Phosphor account (preview)')
    await expect(settings).not.toContainText('Machines (preview)')
    const prefs = JSON.parse(await readFile(join(h.userData, 'config.json'), 'utf8'))
    expect(prefs).not.toHaveProperty('accountPreview')
    expect(prefs).not.toHaveProperty('machinesPreview')
    expect(h.calls).toHaveLength(0)
    await settings.getByTestId('feedback-button').click()
    await expect(page.getByRole('dialog', { name: /feedback/i })).toBeVisible()
  } finally {
    await h.close()
  }
})

test('signed-in directory walks guided enrollment, stable detail, rename and confirmed removal', async () => {
  const h = await accountControlFixture()
  const { page } = h
  try {
    await h.signIn()
    await page.getByTestId('account-footer').getByRole('button', { name: 'Your account' }).click()
    await page
      .locator('[data-popup-menu]')
      .getByRole('button', { name: /Machines/ })
      .click()
    await expect(page.getByText('Bring another machine online', { exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Add a machine', exact: true }).first().click()
    const dialog = page.getByRole('dialog', { name: 'Add a machine', exact: true })
    await expect(dialog).toContainText('Before you start')
    await dialog.getByRole('button', { name: 'Continue to Install' }).click()
    await expect(dialog).toContainText('Install the Host')
    await expect(dialog).toContainText('phosphor login')
    await dialog.getByRole('button', { name: 'I have a code' }).click()
    await dialog.getByRole('textbox', { name: 'Code', exact: true }).fill('BCDFGHJX')
    await dialog.getByRole('button', { name: 'Look up code' }).click()
    await expect(dialog.getByRole('alert')).toContainText('wrong or expired')
    await dialog.getByRole('textbox', { name: 'Code', exact: true }).fill('bcdfghjk')
    await expect(dialog.getByRole('textbox', { name: 'Code', exact: true })).toHaveValue(
      'BCDF-GHJK',
    )
    await dialog.getByRole('textbox', { name: 'Code', exact: true }).press('Enter')
    await expect(dialog).toContainText('Is this your machine?')
    await expect(dialog).toContainText(MACHINE.keyFingerprint)
    await expect(dialog.getByRole('textbox', { name: 'Machine label', exact: true })).toHaveValue(
      'bee1',
    )
    await dialog.getByRole('button', { name: 'Approve machine' }).click()
    await expect(dialog).toContainText('bee1 added')
    await dialog.getByText('Stuck?', { exact: true }).click()
    await expect(dialog).toContainText('phosphor service install')
    await dialog.getByRole('button', { name: 'View machine' }).click()
    await expect(page.getByTestId('machine-detail')).toContainText('Finish setting up bee1')
    await page.getByRole('button', { name: 'Rename', exact: true }).click()
    await page.getByRole('textbox', { name: 'Machine label', exact: true }).fill('buildbox')
    await page.getByRole('textbox', { name: 'Machine label', exact: true }).press('Enter')
    await expect(page.getByRole('heading', { name: 'buildbox', exact: true })).toBeVisible()
    await page.getByRole('button', { name: '← Machines' }).click()
    await expect(page.getByTestId('enrolled-machine-row')).toHaveCount(1)
    await expect(page.getByTestId('enrolled-machine-row')).toContainText(
      'Waiting for first connection',
    )
    await page.getByTestId('enrolled-machine-row').click()
    await page.getByRole('button', { name: 'Remove machine', exact: true }).click()
    const remove = page.getByRole('dialog', { name: 'Remove machine', exact: true })
    await expect(remove).toContainText('next heartbeat')
    await remove.getByRole('button', { name: 'Cancel' }).click()
    expect(h.state.machines).toHaveLength(1)
    await page.getByRole('button', { name: 'Remove machine', exact: true }).click()
    await remove.getByRole('button', { name: 'Remove machine', exact: true }).click()
    await expect(page.getByText('Machine removed.', { exact: true })).toBeVisible()
    await expect(page.getByTestId('enrolled-machine-row')).toHaveCount(0)
  } finally {
    await h.close()
  }
})

test('onboarding steps and opt-in suggestions in dark and light', async () => {
  const testInfo = test.info()
  const bin = await mkdtemp(join(tmpdir(), 'phosphor-tailscale-'))
  const config = join(bin, 'status.json')
  const setDiscovery = (peers: boolean, delay = 0) =>
    writeFile(config, JSON.stringify({ peers, delay }))
  await setDiscovery(true)
  await writeFile(
    join(bin, 'tailscale'),
    `#!/usr/bin/env node
const config = JSON.parse(require('node:fs').readFileSync(${JSON.stringify(config)}, 'utf8'));
setTimeout(() => console.log(JSON.stringify({BackendState:'Running',CurrentTailnet:{MagicDNSEnabled:true},CertDomains:['desktop.tail123.ts.net'],Peer:config.peers ? {fixture:{DNSName:'buildbox.tail123.ts.net.',OS:'linux',Online:true,TailscaleIPs:['100.1.2.3']}} : {}})), config.delay)
`,
    { mode: 0o755 },
  )
  const shots = process.env.PHOSPHOR_ONBOARDING_SHOTS ?? testInfo.outputPath('onboarding')
  await mkdir(shots, { recursive: true })
  const h = await accountControlFixture([], { env: { PATH: `${bin}:${process.env.PATH}` } })
  const { page } = h
  try {
    await h.signIn()
    await page.getByRole('button', { name: 'Machines', exact: true }).click()
    for (const theme of ['dark', 'light'] as const) {
      await page.evaluate(async (theme) => {
        await window.phosphor.invoke('app:setTheme', theme)
        document.documentElement.classList.toggle('dark', theme === 'dark')
      }, theme)
      await page.getByRole('button', { name: 'Add a machine', exact: true }).first().click()
      const dialog = page.getByRole('dialog', { name: 'Add a machine', exact: true })
      await expect(dialog).toContainText('MagicDNS and HTTPS certificates are available')
      const toggle = dialog.getByRole('switch')
      if ((await toggle.getAttribute('aria-checked')) === 'true') await toggle.click()
      await expect(toggle).toHaveAttribute('aria-checked', 'false')
      await dialog.screenshot({ path: join(shots, `${theme}-before.png`) })
      await toggle.click()
      const suggestion = dialog.getByRole('button', { name: 'Use buildbox.tail123.ts.net' })
      await expect(suggestion).toBeVisible()
      await dialog.screenshot({ path: join(shots, `${theme}-discovery.png`) })
      await setDiscovery(false, 1500)
      await dialog.getByRole('button', { name: 'Check again' }).click()
      await expect(dialog).toContainText('Loading suggestions…')
      await dialog.screenshot({ path: join(shots, `${theme}-discovery-loading.png`) })
      await expect(dialog).toContainText('No other online machines found on your tailnet.')
      await dialog.screenshot({ path: join(shots, `${theme}-discovery-empty.png`) })
      await setDiscovery(true)
      await dialog.getByRole('button', { name: 'Check again' }).click()
      await expect(suggestion).toBeVisible()
      await suggestion.click()
      await expect(dialog.getByRole('textbox', { name: 'SSH target', exact: true })).toHaveValue(
        'buildbox.tail123.ts.net',
      )
      await dialog.screenshot({ path: join(shots, `${theme}-install.png`) })
      await dialog.getByRole('button', { name: 'I have a code' }).click()
      await dialog.getByRole('textbox', { name: 'Code', exact: true }).fill('BCDFGHJK')
      await dialog.screenshot({ path: join(shots, `${theme}-code.png`) })
      await dialog.getByRole('button', { name: 'Look up code' }).click()
      await dialog.screenshot({ path: join(shots, `${theme}-confirm.png`) })
      await dialog.getByRole('button', { name: 'Approve machine' }).click()
      // Picking a suggestion did not start SSH. Manual enrollment completes directly.
      await expect(dialog).toContainText('Waiting for bee1 to connect…')
      await dialog.screenshot({ path: join(shots, `${theme}-online.png`) })
      await expect(dialog.locator('details').filter({ hasText: 'Stuck?' })).not.toHaveAttribute(
        'open',
        '',
      )
      await dialog.getByRole('button', { name: 'Close', exact: true }).click()
      h.state.approvedMachine = {
        ...MACHINE,
        lastSeenAt: new Date().toISOString(),
        state: 'running',
      }
      await page.getByRole('button', { name: 'Add a machine', exact: true }).first().click()
      await dialog.getByRole('button', { name: 'Continue to Install' }).click()
      await dialog.getByRole('button', { name: 'I have a code' }).click()
      await dialog.getByRole('textbox', { name: 'Code', exact: true }).fill('BCDFGHJK')
      await dialog.getByRole('button', { name: 'Look up code' }).click()
      await dialog.getByRole('button', { name: 'Approve machine' }).click()
      await expect(dialog).toContainText('bee1 is online')
      await expect(dialog.getByRole('button', { name: 'Continue to Providers' })).toBeVisible()
      await dialog.screenshot({ path: join(shots, `${theme}-online-ready.png`) })
      await expect(dialog).toContainText('Host not reachable')
      await dialog.screenshot({ path: join(shots, `${theme}-providers.png`) })
      await dialog.getByRole('button', { name: 'Close', exact: true }).click()
      h.state.approvedMachine = MACHINE
    }
  } finally {
    await h.close()
    await rm(bin, { recursive: true, force: true })
  }
})
