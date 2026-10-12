import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { HeartbeatRequest, Readiness } from '@phosphor/shared/control-api'
import { ControlFailure } from './client'
import { createHeartbeat, createSequenceStore, type HeartbeatPorts } from './heartbeat'

const ready: Readiness = { pi: 'ok', claude: 'signed-out', tailscale: 'no-https' }
const hostId = '0b6f7c1e-2f4a-4c8e-9d1b-5a7e3c2f1d00'
afterEach(() => vi.useRealTimers())
function loopFixture() {
  let now = 1000
  let seq = 0
  const requests: HeartbeatRequest[] = []
  const waits: number[] = []
  const logs: string[] = []
  const signal = new AbortController()
  const ports: HeartbeatPorts = {
    now: () => now,
    random: () => 0,
    hostVersion: '0.0.0-dev.source',
    signal: signal.signal,
    seq: {
      read: async () => seq,
      write: async (value) => {
        seq = value
      },
    },
    readiness: vi.fn(async () => ready),
    client: async (body) => {
      expect(seq).toBe(body.seq)
      requests.push(body)
      return { accepted: true, nextInSec: 30 }
    },
    wait: async (ms, abort) => {
      if (ms === 5000 && abort !== signal.signal && signal.signal.aborted)
        return new Promise<void>((resolve) =>
          abort.addEventListener('abort', () => resolve(), { once: true }),
        )
      waits.push(ms)
      now += ms
      if (requests.length >= 2) signal.abort()
    },
    log: (line) => logs.push(line),
  }
  return {
    ports,
    requests,
    waits,
    logs,
    signal,
    setClock: (value: number) => {
      now = value
    },
  }
}

describe('heartbeat loop', () => {
  it.each([0, 0.5, 1])(
    'schedules the server interval plus bounded jitter %s and publishes before sending',
    async (random) => {
      const f = loopFixture()
      f.ports.random = () => random
      expect(await createHeartbeat(f.ports).run()).toBe(0)
      expect(f.waits.slice(0, 2)).toEqual([30000 + random * 3000, 30000 + random * 3000])
      expect(f.requests.map((body) => body.state)).toEqual(['running', 'running', 'stopping'])
      expect(f.requests.map((body) => body.seq)).toEqual([
        1000,
        31000 + random * 3000,
        61000 + random * 6000,
      ])
      expect(f.requests[0]).toEqual({
        seq: 1000,
        state: 'running',
        hostVersion: '0.0.0-dev.source',
        uptimeSec: 0,
        readiness: ready,
        lanes: { running: 0, waiting: 0 },
        endpoint: null,
      })
      expect(f.logs).toEqual(['connected', 'stopped'])
      expect(f.ports.readiness).toHaveBeenCalledTimes(1)
    },
  )
  it('keeps the persisted value when the clock steps back', async () => {
    const f = loopFixture()
    f.ports.seq.read = async () => 9000
    f.ports.wait = async () => {
      f.setClock(1)
      if (f.requests.length === 2) f.signal.abort()
    }
    await createHeartbeat(f.ports).run()
    expect(f.requests.map((body) => body.seq)).toEqual([9001, 9002, 9003])
  })
  it('stops on 410 without touching identity and logs no transport content', async () => {
    const f = loopFixture()
    f.ports.client = async () => {
      throw new ControlFailure('gone')
    }
    expect(await createHeartbeat(f.ports).run()).toBe(77)
    expect(f.logs).toEqual([
      'This machine was removed from your Phosphor account. Run phosphor login to add it again.',
    ])
    expect(f.waits).toEqual([])
  })
  it.each(['too-many-requests', 'conflict'] as const)('retries %s with fresh seq', async (code) => {
    const f = loopFixture()
    let count = 0
    f.ports.client = async (body) => {
      f.requests.push(body)
      if (body.state === 'running') {
        if (++count === 3) f.signal.abort()
        throw new ControlFailure(code)
      }
      return { accepted: true, nextInSec: 30 }
    }
    f.ports.wait = async (ms) => {
      f.waits.push(ms)
    }
    await createHeartbeat(f.ports).run()
    expect(f.waits.slice(0, 2)).toEqual([10000, 10000])
    expect(f.requests.slice(0, 3).map((body) => body.seq)).toEqual([1000, 1001, 1002])
    expect(f.logs.filter((line) => line.includes('stale'))).toHaveLength(
      code === 'conflict' ? 1 : 0,
    )
  })
  it.each(['offline', 'unavailable', 'internal'] as const)(
    'backs off %s to 5 minutes and resets on success',
    async (code) => {
      const f = loopFixture()
      let count = 0
      f.ports.client = async (body) => {
        f.requests.push(body)
        if (body.state === 'stopping') return { accepted: true, nextInSec: 30 }
        count++
        if (count === 11) f.signal.abort()
        if (count === 9) return { accepted: true, nextInSec: 30 }
        throw new ControlFailure(code)
      }
      f.ports.wait = async (ms) => {
        f.waits.push(ms)
      }
      await createHeartbeat(f.ports).run()
      expect(f.waits.slice(0, 10)).toEqual([
        5000, 10000, 20000, 40000, 80000, 160000, 300000, 300000, 30000, 5000,
      ])
    },
  )
  it('refreshes readiness exactly after five minutes, not on every beat', async () => {
    const f = loopFixture()
    f.ports.wait = async (ms) => {
      f.setClock(1000 + f.requests.length * ms)
      if (f.requests.length === 11) f.signal.abort()
    }
    await createHeartbeat(f.ports).run()
    expect(f.ports.readiness).toHaveBeenCalledTimes(2)
  })
  it('rejects invalid request metadata and response intervals', async () => {
    const f = loopFixture()
    f.ports.hostVersion = 'bad version'
    await expect(createHeartbeat(f.ports).run()).rejects.toThrow('Invalid heartbeat metadata.')
    expect(f.requests).toEqual([])
    const other = loopFixture()
    other.ports.client = async () => ({ accepted: true, nextInSec: 0 })
    other.ports.wait = async (ms) => {
      other.waits.push(ms)
      other.signal.abort()
    }
    await createHeartbeat(other.ports).run()
    expect(other.waits[0]).toBe(5000)
  })
  it('enforces the stopping deadline even with a hung transport', async () => {
    vi.useFakeTimers()
    const f = loopFixture()
    f.ports.wait = (ms, signal) =>
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, ms)
        signal.addEventListener(
          'abort',
          () => {
            clearTimeout(timer)
            resolve()
          },
          { once: true },
        )
      })
    f.ports.client = async (body) => {
      f.requests.push(body)
      return new Promise(() => {})
    }
    const loop = createHeartbeat(f.ports)
    const run = loop.run()
    await vi.advanceTimersByTimeAsync(0)
    const stop = loop.drain()
    await vi.advanceTimersByTimeAsync(4999)
    expect(f.logs).not.toContain('stopped')
    await vi.advanceTimersByTimeAsync(1)
    expect(await stop).toEqual({ state: 'stopped' })
    expect(await run).toBe(0)
    expect(f.requests.map((body) => body.state)).toEqual(['running', 'stopping'])
  })
  it('a second signal ends the drain at once without another stopping beat', async () => {
    const f = loopFixture()
    f.ports.client = async (body) => {
      f.requests.push(body)
      return new Promise(() => {})
    }
    f.ports.wait = async () => new Promise(() => {})
    const loop = createHeartbeat(f.ports)
    const run = loop.run()
    await vi.waitFor(() => expect(f.requests).toHaveLength(1))
    const first = loop.drain()
    await vi.waitFor(() => expect(f.requests).toHaveLength(2))
    await loop.drain()
    await first
    expect(await run).toBe(0)
    expect(f.requests).toHaveLength(2)
  })
})

describe('heartbeat sequence storage', () => {
  it('survives restarts, loss and clock rollback, reads other hosts as zero, and uses 0600', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'host-seq-'))
    try {
      await chmod(directory, 0o700)
      const store = createSequenceStore(directory, process.getuid?.(), hostId)
      expect(await store.read()).toBe(0)
      await store.write(12345)
      expect((await stat(join(directory, 'heartbeat.json'))).mode & 0o777).toBe(0o600)
      expect(JSON.parse(await readFile(join(directory, 'heartbeat.json'), 'utf8'))).toEqual({
        version: 1,
        hostId,
        seq: 12345,
      })
      const restarted = createSequenceStore(directory, process.getuid?.(), hostId)
      expect(await restarted.read()).toBe(12345)
      expect(
        await createSequenceStore(
          directory,
          process.getuid?.(),
          '0b6f7c1e-2f4a-4c8e-9d1b-5a7e3c2f1d01',
        ).read(),
      ).toBe(0)
      await unlink(join(directory, 'heartbeat.json'))
      expect(await restarted.read()).toBe(0)
      await restarted.write(12346)
      expect(await restarted.read()).toBe(12346)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
  it.each(['symlink', 'mode', 'oversize', 'malformed', 'directory'])(
    'refuses unsafe sequence storage: %s',
    async (kind) => {
      const root = await mkdtemp(join(tmpdir(), 'host-seq-'))
      const path = join(root, 'heartbeat.json')
      try {
        await chmod(root, 0o700)
        if (kind === 'directory') await mkdir(path)
        else if (kind === 'symlink') await symlink('/dev/null', path)
        else
          await writeFile(path, kind === 'oversize' ? ' '.repeat(4097) : '{}', {
            mode: kind === 'mode' ? 0o644 : 0o600,
          })
        await expect(createSequenceStore(root, process.getuid?.(), hostId).read()).rejects.toThrow()
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    },
  )
})
