/* global window, document */
// The films' shared motion vocabulary, loaded as a classic script before the scenes and exposed
// as `window.PX`. Scenes describe what to look at in plate pixels (the capture's own 1600x1000
// CSS space); the kit turns that into transforms for the fixed window viewport in film.css.
// Every tween is fromTo with explicit states, so a scene reads the same at any seek.
// Names carry a `px` prefix because a classic script's declarations are page globals.

const PX_VIEW = { w: 820, h: 668, pad: 26 }
const PX_WINDOW = { w: 1600, h: 1000 }
const PX_HIDDEN = { opacity: 0, filter: 'blur(7px)' }
const PX_SHOWN = { opacity: 1, filter: 'blur(0px)' }
const PX_SMEARED = { opacity: 0, filter: 'blur(14px)' }
const PX_SETTLED = { x: 0, opacity: 1, filter: 'blur(0px)' }

/** Centre a plate rectangle in the viewport without showing past the plate's edges. */
function pxFit([x, y, w, h], plate, maxScale) {
  const scale = Math.min(
    (PX_VIEW.w - 2 * PX_VIEW.pad) / w,
    (PX_VIEW.h - 2 * PX_VIEW.pad) / h,
    maxScale,
  )
  const place = (start, size, plateSize, view) => {
    const room = view - plateSize * scale
    if (room >= 0) return room / 2
    return Math.min(0, Math.max(room, (view - size * scale) / 2 - start * scale))
  }
  return { scale, x: place(x, w, plate.w, PX_VIEW.w), y: place(y, h, plate.h, PX_VIEW.h) }
}

/** A camera over one plate stack: cut() places it, move() travels from the last framing. */
function pxCamera(tl, selector, plate = PX_WINDOW) {
  let state
  return {
    cut(rect, at = 0, maxScale = 1.5) {
      state = pxFit(rect, plate, maxScale)
      tl.set(selector, state, at)
      return this
    },
    move(rect, at, duration = 0.9, maxScale = 1.5, ease = 'power2.inOut') {
      const next = pxFit(rect, plate, maxScale)
      tl.fromTo(selector, state, { ...next, duration, ease, immediateRender: false }, at)
      state = next
      return this
    },
  }
}

/** The demo cursor, in plate pixels. Its press lands on the frame the interface changes. */
function pxCursor(tl, selector) {
  let state
  return {
    cut([x, y], at = 0) {
      state = { x, y }
      tl.set(selector, { ...state, scale: 1, opacity: 1 }, at)
      return this
    },
    move([x, y], at, duration = 0.7) {
      const next = { x, y }
      const arrive = { ...next, duration, ease: 'power3.inOut', immediateRender: false }
      tl.fromTo(selector, state, arrive, at)
      state = next
      return this
    },
    press(at) {
      const down = { scale: 0.8, duration: 0.07, ease: 'power2.in', immediateRender: false }
      const up = { scale: 1, duration: 0.18, ease: 'power3.out', immediateRender: false }
      tl.fromTo(selector, { scale: 1 }, down, at - 0.07)
      tl.fromTo(selector, { scale: 0.8 }, up, at)
      return this
    },
  }
}

function pxWrapWords(node) {
  for (const child of [...node.childNodes]) {
    if (child.nodeType !== 3) {
      pxWrapWords(child)
      continue
    }
    const parts = child.textContent.split(/(\s+)/).filter(Boolean)
    child.replaceWith(
      ...parts.map((part) => {
        if (!part.trim()) return document.createTextNode(' ')
        const word = document.createElement('span')
        word.className = 'w'
        word.textContent = part
        return word
      }),
    )
  }
}

function pxLeave(tl, selector, until) {
  if (until === undefined) return
  const gone = { ...PX_HIDDEN, duration: 0.2, ease: 'power2.in', immediateRender: false }
  tl.fromTo(selector, PX_SHOWN, gone, until - 0.2)
}

/** A title: words sharpen in place one after another, then the line leaves as one. */
function pxTitle(tl, selector, at, until) {
  const element = document.querySelector(selector)
  if (!element.querySelector('.w')) pxWrapWords(element)
  const landed = { ...PX_SHOWN, duration: 0.24, stagger: 0.07, ease: 'power2.out' }
  tl.fromTo(element.querySelectorAll('.w'), PX_HIDDEN, landed, at)
  pxLeave(tl, selector, until)
}

/** A quieter line: it sharpens in whole. `at` undefined means already on screen at frame 0. */
function pxLine(tl, selector, at, until) {
  if (at !== undefined)
    tl.fromTo(selector, PX_HIDDEN, { ...PX_SHOWN, duration: 0.3, ease: 'power2.out' }, at)
  pxLeave(tl, selector, until)
}

/** Show the next real capture in place, as the interface itself would change. */
function pxSwap(tl, selector, at) {
  const shown = { opacity: 1, duration: 0.1, ease: 'none', immediateRender: false }
  tl.fromTo(selector, { opacity: 0 }, shown, at)
}

/** An outline around a real control. */
function pxRing(tl, selector, at, until) {
  const landed = { opacity: 1, scale: 1, duration: 0.34, ease: 'power3.out' }
  tl.fromTo(selector, { opacity: 0, scale: 1.12 }, landed, at)
  if (until === undefined) return
  const gone = { opacity: 0, duration: 0.18, ease: 'power2.in', immediateRender: false }
  tl.fromTo(selector, { opacity: 1 }, gone, until - 0.18)
}

/** The rail's current step filling as its scene plays, or any bar drawn from its left edge. */
function pxDraw(tl, selector, at, duration = 0.5, from = 0, to = 1) {
  const ease = duration > 2 ? 'none' : 'power2.inOut'
  tl.fromTo(selector, { scaleX: from }, { scaleX: to, duration, ease }, at)
}

/** A whip between two moments: the window's contents smear in from the right. */
function pxWhipIn(tl, selector, at = 0) {
  const landed = { ...PX_SETTLED, duration: 0.42, ease: 'expo.out', immediateRender: at === 0 }
  tl.fromTo(selector, { x: 110, ...PX_SMEARED }, landed, at)
}

/** The other half of a whip: the contents leave to the left, done by `until`. */
function pxWhipOut(tl, selector, until) {
  const gone = { x: -110, ...PX_SMEARED, duration: 0.22, ease: 'power3.in', immediateRender: false }
  tl.fromTo(selector, PX_SETTLED, gone, until - 0.22)
}

/** Something carried into frame from below, landing on a long tail. */
function pxRise(tl, selector, at, distance = 640) {
  tl.fromTo(selector, { y: distance }, { y: 0, duration: 0.8, ease: 'expo.out' }, at)
}

window.PX = {
  camera: pxCamera,
  cursor: pxCursor,
  title: pxTitle,
  line: pxLine,
  swap: pxSwap,
  ring: pxRing,
  draw: pxDraw,
  whipIn: pxWhipIn,
  whipOut: pxWhipOut,
  rise: pxRise,
}
