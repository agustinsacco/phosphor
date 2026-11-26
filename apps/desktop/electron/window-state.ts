import { writeFileSync, renameSync, rmSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { readBounded } from '@phosphor/session-runtime/host-install/files'
import { join } from 'node:path'

/**
 * The main window's size, position and maximized state, kept across launches
 * in `<userData>/window-state.json`. Pure helpers decide what to restore, so a
 * monitor that is gone or a hand-edited file never opens a window off screen.
 */

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export interface WindowState extends Rect {
  maximized: boolean
}

export interface WindowSize {
  width: number
  height: number
  minWidth: number
  minHeight: number
}

/** What BrowserWindow gets: always a size, a position only when it is on a display. */
export type RestoredBounds = { width: number; height: number; x?: number; y?: number }

export const WINDOW_STATE_FILE = 'window-state.json'
const MAX_BYTES = 4096
const SAVE_DELAY_MS = 500
/** How much of the top strip must land on a display for a position to count as visible. */
const VISIBLE_WIDTH = 100
const VISIBLE_HEIGHT = 44

const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v)

export function parseWindowState(text: string): WindowState | null {
  let v: unknown
  try {
    v = JSON.parse(text)
  } catch {
    return null
  }
  if (typeof v !== 'object' || v === null) return null
  const r = v as Record<string, unknown>
  if (!isInt(r.x) || !isInt(r.y) || !isInt(r.width) || !isInt(r.height)) return null
  if (r.width <= 0 || r.height <= 0) return null
  return { x: r.x, y: r.y, width: r.width, height: r.height, maximized: r.maximized === true }
}

function overlap(a: Rect, b: Rect): { width: number; height: number } {
  return {
    width: Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x),
    height: Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y),
  }
}

export function windowPositionSupported(
  platform: NodeJS.Platform,
  ozone: string,
  env: NodeJS.ProcessEnv,
): boolean {
  if (platform !== 'linux' || ozone === 'x11') return true
  if (ozone === 'wayland' || env.XDG_SESSION_TYPE === 'wayland') return false
  return env.XDG_SESSION_TYPE === 'x11' || !env.WAYLAND_DISPLAY
}

/** A window can fit in the union of connected work areas without fitting on any one display. */
function fullyVisible(bounds: Rect, areas: readonly Rect[]): boolean {
  const right = bounds.x + bounds.width
  const bottom = bounds.y + bounds.height
  const byTop = [...areas].sort((a, b) => a.y - b.y)
  const edges = byTop.flatMap((a) => [a.x, a.x + a.width]).filter((x) => x > bounds.x && x < right)
  const starts = [bounds.x, ...edges.sort((a, b) => a - b)]
  return starts.every((left, i) => {
    const end = starts[i + 1] ?? right
    if (end === left) return true
    let covered = bounds.y
    for (const a of byTop) {
      if (a.x > left || a.x + a.width < end || a.y > covered) continue
      covered = Math.max(covered, a.y + a.height)
      if (covered >= bottom) return true
    }
    return false
  })
}

/**
 * The bounds to open with. The size is clamped between the minimum and the
 * work area it lands on; the position is kept only when the window's top
 * strip (where it is dragged from) is on some display's work area.
 */
export function restoreBounds(
  saved: WindowState | null,
  workAreas: readonly Rect[],
  size: WindowSize,
  positionSupported = true,
): RestoredBounds {
  const first = workAreas[0]
  if (!saved || !first) return { width: size.width, height: size.height }
  const { x: savedX, y: savedY, width: savedWidth, height: savedHeight } = saved
  if (!positionSupported)
    return {
      width: Math.max(
        size.minWidth,
        Math.min(savedWidth, Math.max(...workAreas.map((a) => a.width))),
      ),
      height: Math.max(
        size.minHeight,
        Math.min(savedHeight, Math.max(...workAreas.map((a) => a.height))),
      ),
    }
  if (
    savedWidth >= size.minWidth &&
    savedHeight >= size.minHeight &&
    fullyVisible(saved, workAreas)
  )
    return { x: savedX, y: savedY, width: savedWidth, height: savedHeight }
  const strip = { x: saved.x, y: saved.y, width: saved.width, height: VISIBLE_HEIGHT }
  const home = workAreas.find((area) => {
    const o = overlap(strip, area)
    return o.width >= Math.min(VISIBLE_WIDTH, saved.width) && o.height >= VISIBLE_HEIGHT
  })
  const area = home ?? first
  const width = Math.max(size.minWidth, Math.min(saved.width, area.width))
  const height = Math.max(size.minHeight, Math.min(saved.height, area.height))
  if (!home) return { width, height }
  // Pull it fully inside when the clamped size still fits, so nothing hangs off an edge.
  const x = Math.max(area.x, Math.min(saved.x, area.x + area.width - width))
  const y = Math.max(area.y, Math.min(saved.y, area.y + area.height - height))
  return { width, height, x, y }
}

export function readWindowState(userData: string): WindowState | null {
  try {
    return parseWindowState(readBounded(join(userData, WINDOW_STATE_FILE), MAX_BYTES))
  } catch {
    return null
  }
}

function writeWindowState(userData: string, state: WindowState): void {
  const path = join(userData, WINDOW_STATE_FILE)
  const temp = `${path}.${randomUUID()}.tmp`
  try {
    writeFileSync(temp, JSON.stringify(state) + '\n', { mode: 0o600, flag: 'wx' })
    renameSync(temp, path)
  } catch {
    try {
      rmSync(temp, { force: true })
    } catch {
      // Losing the window's place is not worth failing a close over.
    }
  }
}

/** The slice of BrowserWindow this needs, so tests run without Electron. */
export interface TrackedWindow {
  on(event: 'resize' | 'move' | 'maximize' | 'unmaximize' | 'close', listener: () => void): void
  getNormalBounds(): Rect
  isMaximized(): boolean
  isFullScreen(): boolean
  isMinimized(): boolean
}

/**
 * Saves the window's restored-size bounds shortly after it moves or resizes,
 * and once more when it closes. A maximized window keeps the size it returns
 * to; full screen and minimized states are not saved.
 */
export function trackWindowState(
  window: TrackedWindow,
  userData: string,
  timers: Pick<typeof globalThis, 'setTimeout' | 'clearTimeout'> = globalThis,
): void {
  let timer: ReturnType<typeof setTimeout> | undefined
  const save = () => {
    if (timer) timers.clearTimeout(timer)
    timer = undefined
    if (window.isFullScreen() || window.isMinimized()) return
    const b = window.getNormalBounds()
    writeWindowState(userData, {
      x: Math.round(b.x),
      y: Math.round(b.y),
      width: Math.round(b.width),
      height: Math.round(b.height),
      maximized: window.isMaximized(),
    })
  }
  const later = () => {
    if (timer) timers.clearTimeout(timer)
    timer = timers.setTimeout(save, SAVE_DELAY_MS)
  }
  for (const event of ['resize', 'move', 'maximize', 'unmaximize'] as const) window.on(event, later)
  window.on('close', save)
}

export const DEFAULT_WINDOW_SIZE: WindowSize = {
  width: 1440,
  height: 920,
  minWidth: 900,
  minHeight: 600,
}

/** Options for the main BrowserWindow and whether to maximize it once shown. */
export function windowPlacement(
  userData: string,
  workAreas: readonly Rect[],
  positionSupported = true,
): { bounds: RestoredBounds & { minWidth: number; minHeight: number }; maximized: boolean } {
  const saved = readWindowState(userData)
  const size = DEFAULT_WINDOW_SIZE
  return {
    bounds: {
      ...restoreBounds(saved, workAreas, size, positionSupported),
      minWidth: size.minWidth,
      minHeight: size.minHeight,
    },
    maximized: saved?.maximized === true,
  }
}

/** Shows the window, maximized again when it was left maximized. */
export function showRestored(window: { maximize(): void; show(): void }, maximized: boolean): void {
  if (maximized) window.maximize()
  window.show()
}
