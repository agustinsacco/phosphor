/** A touch or pen held this long opens the menu, a little under Android's own long-press. */
const LONG_PRESS_MS = 480
/** Moving further than this turns the hold into a scroll or a drag. */
const LONG_PRESS_SLOP_PX = 10
/** How long after release a long-press's trailing click may still arrive. */
const TRAILING_CLICK_MS = 600

/** One short tick where the device has a Vibration API; iOS has none and stays silent. */
function vibrate(): void {
  try {
    if (typeof navigator.vibrate === 'function') navigator.vibrate(10)
  } catch {
    // A refused vibration still leaves the menu open.
  }
}

const isMenuKey = (event: React.KeyboardEvent): boolean =>
  event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)

const isTextEntry = (target: HTMLElement): boolean =>
  target.isContentEditable || target.matches('input, textarea, select')

interface Hold {
  x: number
  y: number
  trigger: HTMLElement
  timer: ReturnType<typeof setTimeout>
}

/**
 * One element's menu gesture: right-click, the menu key, and a touch or pen
 * long-press. `opened` marks that this gesture already opened the menu (by
 * long-press, Android's own long-press `contextmenu`, or the keyboard), so
 * whichever arrives second is swallowed: one menu, one vibration. The next
 * pointerdown starts a fresh gesture.
 */
export class MenuGesture {
  private hold: Hold | null = null
  private opened = false
  /** Set from a long-press until its trailing click is swallowed or can no longer come. */
  private swallowFor: HTMLElement | null = null
  private swallowTimer: ReturnType<typeof setTimeout> | undefined

  constructor(
    private readonly disabled: () => boolean,
    private readonly open: (x: number, y: number, trigger: HTMLElement | null) => void,
  ) {}

  private show(x: number, y: number, trigger: HTMLElement | null): void {
    this.opened = true
    this.open(x, y, trigger)
  }

  private cancelHold = (): void => {
    if (this.hold) clearTimeout(this.hold.timer)
    this.hold = null
    window.removeEventListener('scroll', this.cancelHold, true)
  }

  private disarm = (): void => {
    clearTimeout(this.swallowTimer)
    this.swallowFor = null
    window.removeEventListener('click', this.swallowElsewhere, true)
    window.removeEventListener('pointerdown', this.disarm, true)
  }

  /*
   * The menu can open under the finger (the phone sheet's backdrop), so the
   * trailing click is stopped wherever it lands; the trigger stops its own in
   * onClickCapture. A fresh pointerdown is a deliberate tap and disarms it.
   */
  private swallowElsewhere = (event: MouseEvent): void => {
    if (this.swallowFor?.contains(event.target as Node)) return
    event.preventDefault()
    event.stopPropagation()
    this.disarm()
  }

  private openByLongPress(x: number, y: number, trigger: HTMLElement): void {
    this.cancelHold()
    this.disarm()
    this.swallowFor = trigger
    window.addEventListener('click', this.swallowElsewhere, true)
    window.addEventListener('pointerdown', this.disarm, true)
    this.show(x, y, trigger)
    vibrate()
  }

  onContextMenu = (event: React.MouseEvent<HTMLElement>): void => {
    if (this.disabled()) return
    event.preventDefault()
    event.stopPropagation()
    if (this.opened) return
    if (this.hold) this.openByLongPress(event.clientX, event.clientY, this.hold.trigger)
    else this.show(event.clientX, event.clientY, event.currentTarget)
  }

  onKeyDown = (event: React.KeyboardEvent<HTMLElement>): void => {
    if (this.disabled() || !isMenuKey(event) || isTextEntry(event.target as HTMLElement)) return
    event.preventDefault()
    event.stopPropagation()
    const rect = event.currentTarget.getBoundingClientRect()
    this.show(rect.left, rect.bottom + 4, event.currentTarget)
  }

  onPointerDown = (event: React.PointerEvent<HTMLElement>): void => {
    this.opened = false
    this.disarm()
    this.cancelHold()
    if (this.disabled()) return
    if (event.pointerType !== 'touch' && event.pointerType !== 'pen') return
    const { clientX: x, clientY: y, currentTarget: trigger } = event
    const timer = setTimeout(() => this.openByLongPress(x, y, trigger), LONG_PRESS_MS)
    this.hold = { x, y, trigger, timer }
    window.addEventListener('scroll', this.cancelHold, true)
  }

  onPointerMove = (event: React.PointerEvent<HTMLElement>): void => {
    const hold = this.hold
    if (hold && Math.hypot(event.clientX - hold.x, event.clientY - hold.y) > LONG_PRESS_SLOP_PX)
      this.cancelHold()
  }

  /** pointerup and pointercancel: a hold that has not opened yet never will. */
  onRelease = (): void => {
    this.cancelHold()
    clearTimeout(this.swallowTimer)
    if (this.swallowFor) this.swallowTimer = setTimeout(this.disarm, TRAILING_CLICK_MS)
  }

  onClickCapture = (event: React.MouseEvent<HTMLElement>): void => {
    if (!this.swallowFor) return
    event.preventDefault()
    event.stopPropagation()
    this.disarm()
  }

  dispose = (): void => {
    this.cancelHold()
    this.disarm()
  }
}
