import { chmod, mkdtemp, rm } from 'node:fs/promises'
import type * as fsPromises from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type { HeartbeatRequest, Readiness } from '@phosphor/shared/control-api'
import { ControlFailure } from './client'
import { createHeartbeat, createSequenceStore, type HeartbeatPorts } from './heartbeat'

const durability = vi.hoisted(() => [] as string[])
vi.mock('node:fs/promises', async (original) => {
  const fs = await original<typeof fsPromises>()
  return {
    ...fs,
    open: async (...args: Parameters<typeof fs.open>) => {
      const file = await fs.open(...args)
      const sync = file.sync.bind(file)
      vi.spyOn(file, 'sync').mockImplementation(async () => {
        await sync()
        durability.push('sync')
      })
      return file
    },
    rename: async (...args: Parameters<typeof fs.rename>) => {
      await fs.rename(...args)
      durability.push('rename')
    },
  }
})

const ready: Readiness = { pi: 'ok', claude: 'signed-out', tailscale: 'no-https' }
afterEach(() => vi.useRealTimers())
function fixture() {
  let now = 1000
  let seq = 0
  const requests: HeartbeatRequest[] = []
  const waits: number[] = []
  const logs: string[] = []
  const signal = new AbortController()
  const ports: HeartbeatPorts = {
    now: () => now,
    random: () => 0,
    hostVersion: '1.0.0',
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
      if (ms === 5000 && signal.signal.aborted)
        return new Promise<void>((resolve) =>
          abort.addEventListener('abort', () => resolve(), { once: true }),
        )
      waits.push(ms)
      now += ms
      if (requests.length >= 3) signal.abort()
    },
    log: (line) => logs.push(line),
  }
  return {
    ports,
    requests,
    waits,
    logs,
    signal,
    clock: (value: number) => {
      now = value
    },
  }
}

it('fsyncs and publishes the sequence before transport', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'heartbeat-characterize-'))
  try {
    await chmod(directory, 0o700)
    const f = fixture()
    const store = createSequenceStore(
      directory,
      process.getuid?.(),
      '0b6f7c1e-2f4a-4c8e-9d1b-5a7e3c2f1d00',
    )
    f.ports.seq = store
    durability.length = 0
    f.ports.client = async (body) => {
      expect(await store.read()).toBe(body.seq)
      durability.push('transport')
      f.requests.push(body)
      return { accepted: true, nextInSec: 30 }
    }
    await createHeartbeat(f.ports).run()
    expect(durability).toEqual(
      Array.from({ length: 4 }, () => ['sync', 'rename', 'transport']).flat(),
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

it('keeps sequences monotonic across clock rollback and a canceled transport', async () => {
  const f = fixture()
  const signals: AbortSignal[] = []
  f.ports.seq.read = async () => 9000
  f.ports.client = async (body, signal) => {
    f.requests.push(body)
    signals.push(signal)
    return body.state === 'running' ? new Promise(() => {}) : { accepted: true, nextInSec: 30 }
  }
  const loop = createHeartbeat(f.ports)
  const running = loop.run()
  await vi.waitFor(() => expect(f.requests).toHaveLength(1))
  f.clock(1)
  await loop.drain()
  expect(await running).toBe(0)
  expect(f.requests.map((body) => [body.seq, body.state])).toEqual([
    [9001, 'running'],
    [9002, 'stopping'],
  ])
  expect(signals[0]?.aborted).toBe(true)
  expect(signals[1]).not.toBe(signals[0])
})

it.each([0, 0.5, 1])('caches readiness for one minute with bounded jitter %s', async (jitter) => {
  const f = fixture()
  f.ports.random = () => jitter
  await createHeartbeat(f.ports).run()
  expect(f.waits.slice(0, 3)).toEqual(Array(3).fill(30000 + jitter * 3000))
  expect(f.ports.readiness).toHaveBeenCalledTimes(2)
  expect(f.requests.map((body) => body.readiness)).toEqual(Array(4).fill(ready))
  expect(f.logs).toEqual(['connected', 'stopped'])
})

it.each([-0.001, 1.001, NaN, Infinity])('rejects invalid jitter %s', async (jitter) => {
  const f = fixture()
  f.ports.random = () => jitter
  await expect(createHeartbeat(f.ports).run()).rejects.toThrow('Invalid heartbeat jitter.')
  expect(f.waits).toEqual([])
})

it.each(['conflict', 'too-many-requests'] as const)(
  'retries %s at the minimum interval',
  async (code) => {
    const f = fixture()
    f.ports.client = async (body) => {
      f.requests.push(body)
      if (body.state === 'running') throw new ControlFailure(code)
      return { accepted: true, nextInSec: 30 }
    }
    await createHeartbeat(f.ports).run()
    expect(f.waits.slice(0, 3)).toEqual([10000, 10000, 10000])
    expect(f.logs.filter((line) => line.includes('stale'))).toHaveLength(
      code === 'conflict' ? 1 : 0,
    )
    expect(f.requests.map((body) => body.seq)).toEqual([1000, 11000, 21000, 31000])
  },
)

it.each(['offline', 'unavailable', 'internal'] as const)(
  'caps %s backoff and resets on success',
  async (code) => {
    const f = fixture()
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
    expect(f.waits).toEqual([
      5000, 10000, 20000, 40000, 80000, 160000, 300000, 300000, 30000, 5000, 5000,
    ])
  },
)

it('returns removal exit 77 without retrying or sending a stopping beat', async () => {
  const f = fixture()
  f.ports.onRemoved = vi.fn()
  f.ports.client = async () => {
    throw new ControlFailure('gone')
  }
  expect(await createHeartbeat(f.ports).run()).toBe(77)
  expect(f.ports.onRemoved).toHaveBeenCalledOnce()
  expect(f.waits).toEqual([])
  expect(f.logs).toEqual([
    'This machine was removed from your Phosphor account. Run phosphor setup to add it again.',
  ])
})

it('bounds drain by a five-second beat plus one-second disk publication wait', async () => {
  vi.useFakeTimers()
  const f = fixture()
  let writes = 0
  f.ports.seq.write = async () => {
    if (++writes === 2) await new Promise<void>(() => {})
  }
  f.ports.client = async (body) => {
    f.requests.push(body)
    return new Promise(() => {})
  }
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
  const loop = createHeartbeat(f.ports)
  const running = loop.run()
  await vi.advanceTimersByTimeAsync(0)
  let stopped = false
  const drain = loop.drain().then(() => {
    stopped = true
  })
  await vi.advanceTimersByTimeAsync(5999)
  expect(stopped).toBe(false)
  await vi.advanceTimersByTimeAsync(1)
  await drain
  expect(await running).toBe(0)
  expect(stopped).toBe(true)
  expect(writes).toBe(2)
  expect(vi.getTimerCount()).toBe(0)
})

it('forces the first drain on a second signal with exactly one stopping beat', async () => {
  const f = fixture()
  f.ports.client = async (body) => {
    f.requests.push(body)
    return new Promise(() => {})
  }
  f.ports.wait = async () => new Promise(() => {})
  const loop = createHeartbeat(f.ports)
  const running = loop.run()
  await vi.waitFor(() => expect(f.requests).toHaveLength(1))
  const first = loop.drain()
  await vi.waitFor(() => expect(f.requests).toHaveLength(2))
  await loop.drain()
  await first
  expect(await running).toBe(0)
  expect(f.requests.map((body) => body.state)).toEqual(['running', 'stopping'])
  expect(f.logs).toEqual(['stopped'])
})

it('does not accumulate cancellation listeners across five hundred beats', async () => {
  const f = fixture()
  let active = 0
  let patched = false
  const peaks: number[] = []
  const client = f.ports.client
  f.ports.client = async (body, signal) => {
    if (!patched) {
      patched = true
      const add = signal.addEventListener.bind(signal)
      const remove = signal.removeEventListener.bind(signal)
      signal.addEventListener = (...args: Parameters<AbortSignal['addEventListener']>) => {
        active++
        add(...args)
      }
      signal.removeEventListener = (...args: Parameters<AbortSignal['removeEventListener']>) => {
        active--
        remove(...args)
      }
    }
    return client(body, signal)
  }
  f.ports.wait = async (ms) => {
    peaks.push(active)
    f.clock(f.ports.now() + ms)
    if (f.requests.length >= 500) f.signal.abort()
  }
  expect(await createHeartbeat(f.ports).run()).toBe(0)
  expect(f.requests).toHaveLength(501)
  expect(Math.max(...peaks)).toBeLessThanOrEqual(1)
  expect(active).toBe(0)
})
