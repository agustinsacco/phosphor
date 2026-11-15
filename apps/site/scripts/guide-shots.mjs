// Settings-only entrypoint for `npm run shots:guides --prefix apps/site`.
// Uses the same current renderer and privacy boundary as the full refresh.
import { launchCapture } from './capture-harness.mjs'
import { captureSettings } from './capture-settings.mjs'

const { browser, page } = await launchCapture()
try {
  await captureSettings(page)
} finally {
  await browser.close()
}
