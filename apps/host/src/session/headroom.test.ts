import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { createServer, get } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createHeadroomService, type DaemonHeadroom } from './headroom'
import { ownsHeadroomPort } from './headroom-port'
import { createHeadroomContribution } from './contributions/headroom'

let dir: string
let socket: string
let service: DaemonHeadroom
const failed = vi.fn()

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'hr-'))
  socket = join(dir, 'run', 'headroom.sock')
  failed.mockClear()
})
afterEach(async () => {
  await service?.stop()
  await rm(dir, { recursive: true, force: true })
})

function create(options: Partial<Parameters<typeof createHeadroomService>[0]> = {}) {
  return createHeadroomService({
    directory: dir,
    uid: process.getuid!(),
    candidates: [socket],
    logFailed: failed,
    ...options,
  })
}

async function binary(code: string) {
  const fixture = join(dir, 'fixture.cjs')
  await writeFile(fixture, code)
  await writeFile(
    join(dir, 'headroom'),
    `#!/bin/sh\nexec "${process.execPath}" "${fixture}" "$@"\n`,
    { mode: 0o700 },
  )
}
const listener = `require('node:http').createServer((_req, res) => res.end('ok'))
  .listen(Number(process.argv[process.argv.indexOf('--port')+1]), '127.0.0.1')`

async function activate() {
  service.activate({ HOME: dir, PATH: dir, TMPDIR: dir })
  await service.handlers['headroom.set']({ enabled: true })
}

async function state() {
  return (await service.handlers['headroom.status']()).state
}

function health() {
  return new Promise<number | undefined>((resolve, reject) => {
    get({ socketPath: socket, path: '/health' }, (res) => {
      res.resume()
      resolve(res.statusCode)
    }).on('error', reject)
  })
}

it('persists an owner toggle before acquiring lanes, proves its child once, and returns 503 on child exit', async () => {
  await binary(listener)
  const prove = vi.fn(ownsHeadroomPort)
  service = create({ prove })
  expect(await state()).toBe('off')
  await service.handlers['headroom.set']({ enabled: true })
  expect(JSON.parse(await readFile(join(dir, 'headroom.json'), 'utf8'))).toEqual({
    version: 1,
    enabled: true,
  })
  expect((await stat(join(dir, 'headroom.json'))).mode & 0o777).toBe(0o600)
  await expect(stat(socket)).rejects.toMatchObject({ code: 'ENOENT' })
  await service.stop()
  service = create({ prove })
  service.activate({ HOME: dir, PATH: dir, TMPDIR: dir })
  await expect.poll(state, { timeout: 6000 }).toBe('ready')
  const contribution = createHeadroomContribution(service)!
  expect(await contribution.spawn({} as never, {} as never)).toEqual({
    env: { PHOSPHOR_HEADROOM_SOCKET: socket },
  })
  expect(await health()).toBe(200)
  expect(prove).toHaveBeenCalledOnce()
  const [ourChild, port] = prove.mock.calls[0]!
  expect(port).toBeGreaterThan(0)
  expect(port).not.toBe(8787)
  process.kill(ourChild) // only our fixture, whose open listener the prover just checked
  await expect.poll(state).toBe('failed')
  expect(await health()).toBe(503)
  expect(service.socket()).toBeUndefined()
  await service.handlers['headroom.set']({ enabled: false })
  expect(await state()).toBe('off')
  await expect(stat(socket)).rejects.toMatchObject({ code: 'ENOENT' })
}, 12000)

it('refuses a healthy listener that beats the spawned child to the port', async () => {
  await binary('setInterval(() => {}, 5000)') // this child is alive but never listens
  const foreign = createServer((_req, res) => res.end('ok'))
  await new Promise<void>((resolve) => foreign.listen(0, '127.0.0.1', resolve))
  try {
    const freePort = async () => (foreign.address() as AddressInfo).port
    service = create({ freePort })
    await activate()
    await expect.poll(state, { timeout: 6000 }).toBe('failed')
    expect(service.socket()).toBeUndefined()
    expect(await health()).toBe(503)
    expect(failed).toHaveBeenCalledOnce()
    expect(foreign.listening).toBe(true)
  } finally {
    await new Promise<void>((resolve) => foreign.close(() => resolve()))
  }
}, 12000)

it('fails closed and logs once when ownership proof is unavailable', async () => {
  await binary(listener)
  const prove = vi.fn(async (): Promise<boolean> => {
    throw new Error('unavailable')
  })
  service = create({ prove })
  await activate()
  await expect.poll(state, { timeout: 6000 }).toBe('failed')
  expect(prove).toHaveBeenCalledOnce()
  expect(service.socket()).toBeUndefined()
  expect(await health()).toBe(503)
  expect(failed).toHaveBeenCalledOnce()
}, 12000)
