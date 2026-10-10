import { describe, expect, it, vi } from 'vitest'

// An in-memory electron-store: the real one needs a running Electron app.
vi.mock('electron-store', () => ({
  default: class {
    private data: Record<string, unknown>
    constructor(options: { defaults: Record<string, unknown> }) {
      this.data = structuredClone(options.defaults)
    }
    get(key: string): unknown {
      return this.data[key]
    }
    set(key: string, value: unknown): void {
      this.data[key] = value
    }
    delete(key: string): void {
      delete this.data[key]
    }
  },
}))

const { getPrefs, repointStoredPaths, setPinnedSessions, setRewoundSessions } =
  await import('./store')

describe('rewoundSessions', () => {
  it('survives a folder rename the way pinnedSessions does', () => {
    const oldDir = '/agent/sessions/--box-sandbox-1--'
    const newDir = '/agent/sessions/--box-games--'
    const from = '2026-10-05T21-43-15-764Z_01a10e05.jsonl'
    const to = '2026-10-10T14-43-40-659Z_01a12645.jsonl'
    setPinnedSessions([`${oldDir}/${to}`])
    setRewoundSessions({ [from]: to })

    repointStoredPaths([
      { from: '/box/sandbox-1', to: '/box/games' },
      { from: oldDir, to: newDir },
    ])

    const prefs = getPrefs()
    expect(prefs.pinnedSessions).toEqual([`${newDir}/${to}`])
    // Keyed by file name, so it still names the moved transcripts as is.
    expect(prefs.rewoundSessions).toEqual({ [from]: to })
  })
})
