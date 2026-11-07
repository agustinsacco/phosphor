import { expect, type Locator } from '@playwright/test'

/**
 * Wait until a pinned transcript has caught up with its tail and stays there.
 *
 * The last text of a turn can be visible while the follow effect still owes a
 * write: rows measure a frame late and `scrollHeight` grows after them, so the
 * next `scrollTop = scrollHeight` lands one or more frames later. On CI's slow
 * xvfb renderer that frame can arrive after a test has read the view's
 * position and sent its first wheel notch. That is the app following
 * correctly, but a test reading back from there saw the view move down
 * (the "never fought" smoke flake, about one first attempt in six).
 *
 * The view counts as settled when it sits at the bottom with the same geometry
 * for three animation frames, and its scroll range exceeds `minRange`.
 */
export async function restAtTail(scroller: Locator, minRange = 0): Promise<void> {
  await expect
    .poll(
      () =>
        scroller.evaluate(
          (el, min) =>
            new Promise<boolean>((resolve) => {
              const sample = (): string => `${el.scrollTop}/${el.scrollHeight}/${el.clientHeight}`
              const first = sample()
              let frames = 0
              const step = (): void => {
                if (sample() !== first) return resolve(false)
                if (++frames < 3) return void requestAnimationFrame(step)
                const range = el.scrollHeight - el.clientHeight
                resolve(range > min && range - el.scrollTop <= 1)
              }
              requestAnimationFrame(step)
            }),
          minRange,
        ),
      { timeout: 30_000 },
    )
    .toBe(true)
}
