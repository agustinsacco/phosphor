/**
 * Pause looping animations while the window is in the background.
 *
 * Working beacons, running-tool pulses and the like keep the renderer and GPU
 * producing frames for as long as a lane works, even when nobody is looking.
 * Chromium stops them only when the window is hidden, not when it sits behind
 * another app. `data-window-inactive` on the root sets `--px-loop-state` to
 * `paused`, which every infinite animation reads (styles/index.css, and the
 * guard in styles/loopingAnimations.test.ts). One-shot entry animations do not
 * read it, so a toast that arrives in the background still lands.
 *
 * Only blur/focus EVENTS change it, never a read at mount: an unmapped E2E
 * window never focuses. Focus moving into an iframe (an artifact) blurs the
 * window but not the app, so blur re-checks `document.hasFocus()`, which
 * counts a focused child frame, once focus has settled.
 */
export function watchWindowMotion(root: HTMLElement = document.documentElement): () => void {
  let pending: ReturnType<typeof setTimeout> | undefined
  const set = (inactive: boolean): void => {
    if (inactive) root.dataset.windowInactive = ''
    else delete root.dataset.windowInactive
  }
  const onBlur = (): void => {
    clearTimeout(pending)
    pending = setTimeout(() => set(!document.hasFocus()), 0)
  }
  const onFocus = (): void => {
    clearTimeout(pending)
    set(false)
  }
  window.addEventListener('blur', onBlur)
  window.addEventListener('focus', onFocus)
  return () => {
    clearTimeout(pending)
    window.removeEventListener('blur', onBlur)
    window.removeEventListener('focus', onFocus)
    set(false)
  }
}
