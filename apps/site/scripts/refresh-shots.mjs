// Run against `npm run dev:web -- --host 127.0.0.1 --port 5199`.
import { launchCapture, shot, finishInventory } from './capture-harness.mjs'
import { captureRecall } from './capture-recall.mjs'
import { captureBrain } from './capture-brain.mjs'
import { execFileSync } from 'node:child_process'
import { fileURLToPath, URL } from 'node:url'
import { captureMobile } from './mobile-shots.mjs'
import { captureLane } from './capture-lane.mjs'
import { capturePanes, captureComposer } from './capture-panes.mjs'
import { captureSettings } from './capture-settings.mjs'
const { browser, page } = await launchCapture()
try {
  await shot(page, 'home')
  await captureBrain(page)
  await page.getByRole('button', { name: /^Machines/ }).click()
  await page.getByText('buildbox', { exact: true }).first().waitFor()
  await shot(page, 'machines')
  await captureLane(page)
  await capturePanes(page)
  await captureComposer(page)
  await captureSettings(page)
  await captureRecall(page)
  await captureMobile()
  const replay = fileURLToPath(new URL('./remote-hosts-shot.mjs', import.meta.url))
  execFileSync(process.execPath, [replay, '--demo'], { stdio: 'inherit' })
  execFileSync(process.execPath, [replay], { stdio: 'inherit' })
  await finishInventory()
} finally {
  await browser.close()
}
