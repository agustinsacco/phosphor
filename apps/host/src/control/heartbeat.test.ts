import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises'
import type * as fsPromises from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { HeartbeatRequest, Readiness } from '@phosphor/shared/control-api'
import { ControlFailure, createControlClient } from './client'
import { freshKey } from './signer'
import {
  createHeartbeat,
  createSequenceStore,
  type HeartbeatPorts,
  untilAborted,
} from './heartbeat'

const durability = vi.hoisted(() => {
  const events: string[] = []
  return { events, failSync: false }
})
vi.mock('node:fs/promises', async (importOriginal) => {
  const fs = await importOriginal<typeof fsPromises>()
  return {
    ...fs,
    open: async (...args: Parameters<typeof fs.open>) => {
      const file = await fs.open(...args)
      if (typeof args[0] === 'string' && args[0].includes('.heartbeat-')) {
        const sync = file.sync.bind(file)
        vi.spyOn(file, 'sync').mockImplementation(async () => {
          if (durability.failSync) throw new Error('private fs failure')
          await sync()
          durability.events.push('synced')
        })
      }
      return file
    },
    rename: async (...args: Parameters<typeof fs.rename>) => {
      await fs.rename(...args)
      if (typeof args[0] === 'string' && args[0].includes('.heartbeat-'))
        durability.events.push('renamed')
    },
  }
})

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
  it('never logs transport error messages, keys or signatures', async () => {
    const f = loopFixture()
    const detail = freshKey().export({ type: 'pkcs8', format: 'pem' }).toString()
    f.ports.client = async (body) => {
      f.requests.push(body)
      const failure = new ControlFailure('offline')
      failure.message = detail
      throw failure
    }
    await createHeartbeat(f.ports).run()
    expect(f.logs).toEqual(['retrying in 5s', 'retrying in 10s', 'stopped'])
    expect(f.logs.join('\n')).not.toContain(detail)
    expect(f.logs.join('\n')).not.toContain('PRIVATE KEY')
  })
  it('refreshes readiness exactly after five minutes, not on every beat', async () => {
    const f = loopFixture()
    f.ports.wait = async (ms) => {
      f.setClock(1000 + f.requests.length * ms)
      if (f.requests.length === 11) f.signal.abort()
    }
    await createHeartbeat(f.ports).run()
    expect(f.ports.readiness).toHaveBeenCalledTimes(2)
  })
  it('refreshes readiness at the exact five-minute boundary', async () => {
    const f = loopFixture()
    const times = [300999, 301000]
    f.ports.wait = async () => {
      const next = times.shift()
      if (next === undefined) f.signal.abort()
      else f.setClock(next)
    }
    const probed: number[] = []
    f.ports.readiness = async () => {
      probed.push(f.ports.now())
      return ready
    }
    await createHeartbeat(f.ports).run()
    expect(probed).toEqual([1000, 301000])
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
  it.each([-0.001, 1.001, NaN, Infinity])('refuses out-of-range jitter %s', async (random) => {
    const f = loopFixture()
    f.ports.random = () => random
    await expect(createHeartbeat(f.ports).run()).rejects.toThrow('Invalid heartbeat jitter.')
    expect(f.waits).toEqual([])
  })
  it('does not send when sequence persistence fails', async () => {
    const f = loopFixture()
    f.ports.seq.write = async () => {
      throw new Error('storage unavailable')
    }
    await expect(createHeartbeat(f.ports).run()).rejects.toThrow('storage unavailable')
    expect(f.requests).toEqual([])
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
  it('stop cancels the running request and its wait, and the stopping beat gets its own signal', async () => {
    const f = loopFixture()
    const signals: AbortSignal[] = []
    f.ports.client = async (body, signal) => {
      f.requests.push(body)
      signals.push(signal)
      return body.state === 'stopping' ? { accepted: true, nextInSec: 30 } : new Promise(() => {})
    }
    const loop = createHeartbeat(f.ports)
    const run = loop.run()
    await vi.waitFor(() => expect(signals).toHaveLength(1))
    expect(signals[0]?.aborted).toBe(false)
    await loop.drain()
    expect(await run).toBe(0)
    expect(f.requests.map((body) => body.state)).toEqual(['running', 'stopping'])
    expect(signals[0]?.aborted).toBe(true)
    expect(signals[1]).not.toBe(signals[0])
  })
  it('keeps cancellation registrations bounded over a long run (review r1)', async () => {
    const f = loopFixture()
    let active = 0
    let patched: AbortSignal | undefined
    const peaks: number[] = []
    const client = f.ports.client
    f.ports.client = async (body, signal) => {
      if (!patched) {
        patched = signal
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
      f.setClock(f.ports.now() + ms)
      if (f.requests.length >= 500) f.signal.abort()
    }
    expect(await createHeartbeat(f.ports).run()).toBe(0)
    expect(f.requests).toHaveLength(501)
    expect(Math.max(...peaks)).toBeLessThanOrEqual(1)
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

describe('untilAborted', () => {
  it('settles with the work, then with the fallback once aborted, and removes its listener', async () => {
    const controller = new AbortController()
    const remove = vi.spyOn(controller.signal, 'removeEventListener')
    await expect(untilAborted(Promise.resolve(1), controller.signal, 0)).resolves.toBe(1)
    await expect(
      untilAborted(Promise.reject(new Error('x')), controller.signal, 0),
    ).rejects.toThrow('x')
    expect(remove).toHaveBeenCalledTimes(2)
    const hung = untilAborted(new Promise<number>(() => {}), controller.signal, 0)
    controller.abort()
    await expect(hung).resolves.toBe(0)
    await expect(
      untilAborted(Promise.reject(new Error('late')), controller.signal, 7),
    ).resolves.toBe(7)
  })
})

describe('heartbeat transport', () => {
  const request: HeartbeatRequest = {
    seq: 1,
    state: 'running',
    hostVersion: '1.0.0',
    uptimeSec: 0,
    readiness: ready,
    lanes: { running: 0, waiting: 0 },
    endpoint: null,
  }
  it('validates both boundaries before transport', async () => {
    const fetch = vi.fn<typeof globalThis.fetch>()
    const client = createControlClient('https://example.com', { fetch })
    const key = freshKey()
    expect(() => client.heartbeat('bad', key, request)).toThrow()
    expect(() => client.heartbeat(hostId, key, { ...request, seq: 0 })).toThrow()
    expect(fetch).not.toHaveBeenCalled()
    await expect(
      createControlClient('https://example.com', {
        fetch: async () => Response.json({ accepted: true, nextInSec: 9 }),
      }).heartbeat(hostId, key, request),
    ).rejects.toMatchObject({ code: 'internal' })
  })
  it('uses a fresh cancellation signal for stopping after the running request is aborted', async () => {
    const running = new AbortController()
    running.abort()
    const client = createControlClient('https://example.com', {
      signal: running.signal,
      fetch: async (_url, init) => {
        if (init?.signal?.aborted) throw new Error('private transport details')
        return Response.json({ accepted: true, nextInSec: 10 })
      },
    })
    const key = freshKey()
    await expect(client.heartbeat(hostId, key, request)).rejects.toMatchObject({ code: 'offline' })
    await expect(
      client.heartbeat(
        hostId,
        key,
        { ...request, state: 'stopping' },
        new AbortController().signal,
      ),
    ).resolves.toEqual({ accepted: true, nextInSec: 10 })
  })
})

describe('heartbeat sequence storage', () => {
  it('syncs the temp file before publishing, and keeps the old sequence if sync fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'host-seq-'))
    try {
      await chmod(root, 0o700)
      const store = createSequenceStore(root, process.getuid?.(), hostId)
      durability.events.length = 0
      await store.write(1)
      expect(durability.events).toEqual(['synced', 'renamed'])
      durability.events.length = 0
      durability.failSync = true
      await expect(store.write(2)).rejects.toThrow()
      expect(durability.events).toEqual([])
      expect(await store.read()).toBe(1)
      expect(await readdir(root)).toEqual(['heartbeat.json'])
    } finally {
      durability.failSync = false
      await rm(root, { recursive: true, force: true })
    }
  })
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
  it('supports exactly the safe integer limit and refuses the next value or malformed host', async () => {
    const root = await mkdtemp(join(tmpdir(), 'host-seq-'))
    try {
      await chmod(root, 0o700)
      const store = createSequenceStore(root, process.getuid?.(), hostId)
      await store.write(Number.MAX_SAFE_INTEGER)
      expect(await store.read()).toBe(Number.MAX_SAFE_INTEGER)
      for (const seq of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity])
        await expect(store.write(seq)).rejects.toThrow('Invalid heartbeat sequence.')
      expect(() => createSequenceStore(root, process.getuid?.(), 'bad')).toThrow()
      const f = loopFixture()
      f.ports.seq = store
      await expect(createHeartbeat(f.ports).run()).rejects.toThrow('Invalid heartbeat metadata.')
      expect(f.requests).toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
  it('accepts a valid file exactly at 4 KiB and refuses one byte more', async () => {
    const root = await mkdtemp(join(tmpdir(), 'host-seq-'))
    try {
      await chmod(root, 0o700)
      const store = createSequenceStore(root, process.getuid?.(), hostId)
      const text = JSON.stringify({ version: 1, hostId, seq: 1 })
      const path = join(root, 'heartbeat.json')
      await writeFile(path, text + ' '.repeat(4096 - text.length), { mode: 0o600 })
      expect(await store.read()).toBe(1)
      await writeFile(path, text + ' '.repeat(4097 - text.length))
      await expect(store.read()).rejects.toThrow()
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
  it.each(['symlink', 'mode', 'oversize', 'malformed', 'directory'])(
    'refuses unsafe sequence storage: %s',
    async (kind) => {
      const root = await mkdtemp(join(tmpdir(), 'host-seq-'))
      const path = join(root, 'heartbeat.json')
      try {
        await chmod(root, 0o700)
        const valid = JSON.stringify({ version: 1, hostId, seq: 1 })
        if (kind === 'directory') await mkdir(path)
        else if (kind === 'symlink') {
          const target = join(root, 'target.json')
          await writeFile(target, valid, { mode: 0o600 })
          await symlink(target, path)
        } else
          await writeFile(
            path,
            kind === 'oversize' ? ' '.repeat(4097) : kind === 'mode' ? valid : '{}',
            {
              mode: kind === 'mode' ? 0o644 : 0o600,
            },
          )
        await expect(createSequenceStore(root, process.getuid?.(), hostId).read()).rejects.toThrow()
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    },
  )
})
