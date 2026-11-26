import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  WINDOW_STATE_FILE,
  parseWindowState,
  readWindowState,
  restoreBounds,
  trackWindowState,
  type Rect,
  type TrackedWindow,
} from './window-state'

const size = { width: 1440, height: 920, minWidth: 900, minHeight: 600 }
const laptop: Rect = { x: 0, y: 25, width: 1512, height: 920 }
const external: Rect = { x: 1512, y: 0, width: 2560, height: 1415 }

describe('parseWindowState', () => {
  it('reads a saved state and ignores anything malformed', () => {
    expect(parseWindowState('{"x":10,"y":20,"width":1000,"height":700,"maximized":true}')).toEqual({
      x: 10,
      y: 20,
      width: 1000,
      height: 700,
      maximized: true,
    })
    expect(parseWindowState('{"x":10,"y":20,"width":1000,"height":700}')?.maximized).toBe(false)
    for (const bad of [
      'nope',
      'null',
      '{"x":1,"y":2,"width":0,"height":700}',
      '{"x":"1","y":2,"width":10,"height":700}',
    ])
      expect(parseWindowState(bad)).toBeNull()
  })
})

describe('restoreBounds', () => {
  it('opens at the default size when nothing was saved', () => {
    expect(restoreBounds(null, [laptop], size)).toEqual({ width: 1440, height: 920 })
  })

  it('restores size and position on the display it was left on', () => {
    const saved = { x: 1700, y: 100, width: 1800, height: 1100, maximized: false }
    expect(restoreBounds(saved, [laptop, external], size)).toEqual({
      x: 1700,
      y: 100,
      width: 1800,
      height: 1100,
    })
  })

  it('drops the position when that display is gone, and fits the size to what is left', () => {
    const saved = { x: 1700, y: 100, width: 1800, height: 1100, maximized: false }
    expect(restoreBounds(saved, [laptop], size)).toEqual({ width: 1512, height: 920 })
  })

  it('pulls a window that hangs off an edge back inside its display', () => {
    const saved = { x: 1200, y: 600, width: 1000, height: 700, maximized: false }
    expect(restoreBounds(saved, [laptop], size)).toEqual({
      x: 512,
      y: 245,
      width: 1000,
      height: 700,
    })
  })

  it('never goes below the minimum size', () => {
    const saved = { x: 0, y: 25, width: 300, height: 200, maximized: false }
    expect(restoreBounds(saved, [laptop], size)).toMatchObject({ width: 900, height: 600 })
  })
})

describe('readWindowState and trackWindowState', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })
  const scratch = () => {
    const dir = mkdtempSync(join(tmpdir(), 'window-state-'))
    dirs.push(dir)
    return dir
  }

  function fakeWindow(bounds: Rect, flags = { maximized: false, fullScreen: false }) {
    const listeners = new Map<string, Array<() => void>>()
    const window: TrackedWindow & { emit(event: string): void } = {
      on: (event, listener) => listeners.set(event, [...(listeners.get(event) ?? []), listener]),
      getNormalBounds: () => bounds,
      isMaximized: () => flags.maximized,
      isFullScreen: () => flags.fullScreen,
      isMinimized: () => false,
      emit: (event) => listeners.get(event)?.forEach((listener) => listener()),
    }
    return window
  }

  it('returns null when the file is missing or corrupt', () => {
    const dir = scratch()
    expect(readWindowState(dir)).toBeNull()
    writeFileSync(join(dir, WINDOW_STATE_FILE), '{not json')
    expect(readWindowState(dir)).toBeNull()
  })

  it('saves the restored size on close, with the maximized flag', () => {
    const dir = scratch()
    const window = fakeWindow(
      { x: 40, y: 60, width: 1200, height: 800 },
      {
        maximized: true,
        fullScreen: false,
      },
    )
    trackWindowState(window, dir)
    window.emit('close')
    expect(readWindowState(dir)).toEqual({
      x: 40,
      y: 60,
      width: 1200,
      height: 800,
      maximized: true,
    })
  })

  it('saves shortly after a move, without waiting for close', () => {
    const dir = scratch()
    let pending: (() => void) | null = null
    const timers = {
      setTimeout: ((fn: () => void) => ((pending = fn), 1)) as unknown as typeof setTimeout,
      clearTimeout: (() => (pending = null)) as typeof clearTimeout,
    }
    const window = fakeWindow({ x: 1, y: 2, width: 1000, height: 700 })
    trackWindowState(window, dir, timers)
    window.emit('move')
    expect(readWindowState(dir)).toBeNull()
    ;(pending as (() => void) | null)?.()
    expect(JSON.parse(readFileSync(join(dir, WINDOW_STATE_FILE), 'utf8'))).toMatchObject({ x: 1 })
  })

  it('does not save a full-screen window', () => {
    const dir = scratch()
    const window = fakeWindow(
      { x: 0, y: 0, width: 2560, height: 1440 },
      {
        maximized: false,
        fullScreen: true,
      },
    )
    trackWindowState(window, dir)
    window.emit('close')
    expect(readWindowState(dir)).toBeNull()
  })
})
