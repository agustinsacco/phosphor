import { rm } from 'node:fs/promises'
import type { Page } from '@playwright/test'
import { agentDir, launch, shutdown } from './fixtures/local-app'

/**
 * Pay Electron's first-launch cost on Linux before any test does.
 *
 * On a fresh CI runner the first Electron launch loads its window, runs its
 * JS and answers CDP, yet never produces an animation frame: a probe saw no
 * frame for 180 s in 9 of 10 fresh runners. That launch writes Electron's own
 * fontconfig and Mesa shader caches under ~/.cache, and every later launch
 * paints in under 100 ms, even on a fresh display. Playwright's click waits
 * for two frames to call an element stable, so the first test of every shard
 * timed out a click and passed on retry (the recurring account footer, Open
 * Folder and Machine filter "flakes").
 *
 * The warm-up verifies itself: it relaunches until an app paints, and fails
 * the run if none does, instead of letting every test find out.
 */
const ATTEMPTS = 3
const FRAME_WAIT_MS = 10_000

function paints(page: Page): Promise<boolean> {
  return page.evaluate(
    (ms) =>
      new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), ms)
        requestAnimationFrame(() => {
          clearTimeout(timer)
          resolve(true)
        })
      }),
    FRAME_WAIT_MS,
  )
}

export default async function warmUp(): Promise<void> {
  if (process.platform !== 'linux') return
  try {
    for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
      const started = Date.now()
      const harness = await launch()
      let painted = false
      try {
        painted = await paints(harness.page)
      } finally {
        await shutdown(harness)
      }
      console.log(
        `Electron warm-up: launch ${attempt} ${painted ? 'painted' : 'produced no frame'} (${Date.now() - started} ms)`,
      )
      if (painted) return
    }
    throw new Error(`Electron warm-up: no launch painted a frame in ${ATTEMPTS} attempts`)
  } finally {
    // This process's run-wide agent dir; each worker makes its own.
    await rm(agentDir, { recursive: true, force: true })
  }
}
