import { beforeEach, describe, expect, it, vi } from 'vitest'
import { shutdownApproval } from '../shutdown-approval'

/**
 * Covers the two contracts the terminal pane leans on:
 *
 *  - a spawn failure surfaces as a descriptive Error (node-pty throws a bare
 *    "posix_spawnp failed." that tells a user nothing), and
 *  - `attach` returns a scrollback snapshot that is a SUPERSET of everything
 *    already broadcast, which is what lets a reattaching xterm discard its own
 *    in-flight buffer instead of de-duplicating a byte stream.
 */

const sent: Array<{ channel: string; payload: unknown }> = []
const ptySpawn = vi.fn()
const onBroadcast = vi.hoisted(() => vi.fn())

vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: () => [
      {
        isDestroyed: () => false,
        webContents: {
          send: (channel: string, payload: unknown) => {
            sent.push({ channel, payload })
            onBroadcast(channel, payload)
          },
        },
      },
    ],
  },
}))

vi.mock('node-pty', () => ({ spawn: (...args: unknown[]) => ptySpawn(...args) }))
vi.mock('./spawn-helper', () => ({ ensureSpawnHelperExecutable: () => {} }))

const { ptyManager } = await import('./pty-manager')

/** Minimal IPty double: exposes the data callback so tests can drive output. */
function fakePty(): { emit: (data: string) => void } {
  let onData: (data: string) => void = () => {}
  ptySpawn.mockReturnValueOnce({
    pid: 1234,
    process: 'zsh',
    onData: (cb: (data: string) => void) => {
      onData = cb
    },
    onExit: () => {},
    write: () => {},
    resize: () => {},
    kill: () => {},
  })
  return { emit: (data) => onData(data) }
}

beforeEach(() => {
  ptyManager.killAll()
  sent.length = 0
  ptySpawn.mockReset()
  onBroadcast.mockReset()
})

describe('PtyManager.create — spawn failures', () => {
  it('does not spawn a terminal after shutdown approval', () => {
    const closing = vi.spyOn(shutdownApproval, 'closing', 'get').mockReturnValue(true)
    try {
      expect(() => ptyManager.create('/repo', 80, 24)).toThrow('shutting down')
      expect(ptySpawn).not.toHaveBeenCalled()
      expect(ptyManager.size).toBe(0)
    } finally {
      closing.mockRestore()
    }
  })

  it('wraps posix_spawnp failures with the likely cause', () => {
    // node-pty's message is just "posix_spawnp failed." — the actionable part
    // (a spawn-helper without its exec bit / built for the wrong arch) has to
    // come from us, because it is invisible from the message alone.
    ptySpawn.mockImplementationOnce(() => {
      throw new Error('posix_spawnp failed.')
    })

    expect(() => ptyManager.create('/repo', 80, 24)).toThrow(/spawn-helper/)
    expect(() => {
      ptySpawn.mockImplementationOnce(() => {
        throw new Error('posix_spawnp failed.')
      })
      ptyManager.create('/repo', 80, 24)
    }).toThrow(/Could not start a shell/)
  })

  it('includes the cwd for other spawn failures', () => {
    ptySpawn.mockImplementationOnce(() => {
      throw new Error('ENOENT')
    })
    expect(() => ptyManager.create('/missing/dir', 80, 24)).toThrow(/\/missing\/dir/)
  })
})

describe('PtyManager.attach — scrollback replay', () => {
  it('returns everything the PTY has emitted', () => {
    const pty = fakePty()
    const { ptyId } = ptyManager.create('/repo', 80, 24)

    pty.emit('$ ')
    pty.emit('echo hi\r\nhi\r\n')

    expect(ptyManager.attach(ptyId).scrollback).toBe('$ echo hi\r\nhi\r\n')
  })

  it('is a superset of what was broadcast, so a reattaching view can drop its buffer', () => {
    const pty = fakePty()
    const { ptyId } = ptyManager.create('/repo', 80, 24)

    pty.emit('one')
    pty.emit('two')

    const broadcast = sent
      .filter((m) => m.channel === `pty:data:${ptyId}`)
      .map((m) => m.payload)
      .join('')
    expect(ptyManager.attach(ptyId).scrollback).toContain(broadcast)
  })

  it('updates the snapshot before broadcasting each unchanged live chunk', () => {
    const pty = fakePty()
    const { ptyId } = ptyManager.create('/repo', 80, 24)
    const snapshots: unknown[] = []
    onBroadcast.mockImplementation((channel, payload) => {
      if (channel === `pty:data:${ptyId}`) {
        snapshots.push([payload, ptyManager.attach(ptyId).scrollback])
      }
    })
    pty.emit('one')
    pty.emit('\x1b[31mtwo')
    expect(snapshots).toEqual([
      ['one', 'one'],
      ['\x1b[31mtwo', 'one\x1b[31mtwo'],
    ])
  })

  it('keeps terminal tails independent', () => {
    const first = fakePty()
    const a = ptyManager.create('/repo', 80, 24)
    const second = fakePty()
    const b = ptyManager.create('/repo', 80, 24)
    first.emit('first')
    second.emit('second')
    ptyManager.kill(a.ptyId)
    expect(ptyManager.attach(b.ptyId).scrollback).toBe('second')
  })

  it('caps scrollback so a chatty build cannot grow it without bound', () => {
    const pty = fakePty()
    const { ptyId } = ptyManager.create('/repo', 80, 24)

    for (let i = 0; i < 40; i++) pty.emit('x'.repeat(10_000))

    const { scrollback } = ptyManager.attach(ptyId)
    expect(scrollback.length).toBe(256 * 1024)
    // Keeping the TAIL is the point: it is the recent screen, not the oldest.
    expect(scrollback.endsWith('x'.repeat(100))).toBe(true)
  })

  it('yields empty scrollback for an unknown pty instead of throwing', () => {
    // A renderer can outlive its PTY (killed shell, reloaded window).
    expect(ptyManager.attach('no-such-pty')).toEqual({ scrollback: '' })
  })

  it('does not keep scrollback for a killed pty', () => {
    const pty = fakePty()
    const { ptyId } = ptyManager.create('/repo', 80, 24)
    pty.emit('output')
    ptyManager.kill(ptyId)
    expect(ptyManager.attach(ptyId).scrollback).toBe('')
  })
})
