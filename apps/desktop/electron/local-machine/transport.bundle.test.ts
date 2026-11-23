import { mkdtempSync, rmSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import { builtinModules } from 'node:module'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { build, type UserConfig } from 'vite'
import { WebSocketServer } from 'ws'
import { afterAll, beforeAll, expect, it } from 'vitest'
import type { FrameSocket } from '@phosphor/shared/host-protocol'
import config from '../../electron.vite.config'

/**
 * `transport.ts` as Desktop main ships it: bundled by Vite with the main
 * build's CommonJS options, `ws` inside. Vite replaces a missing optional
 * peer (`bufferutil`) with an empty module, so `ws` would call an undefined
 * `bufferUtil.mask` on every client frame of 48 bytes or more, the first
 * `auth` included. The main build keeps those requires inside `ws`'s own
 * try/catch instead, where a missing package falls back to plain JS.
 */
const APP = resolve(import.meta.dirname, '../..')
const main = (config as { main: UserConfig }).main

let dir: string
let server: Server
let wss: WebSocketServer
let openLocalSocket: (path: string) => Promise<FrameSocket>

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'm2a-bundle-'))
  // A production Node library build like electron-vite's main: only then does
  // Vite stub a missing optional peer with `{}` (in development the stub throws).
  const nodeEnv = process.env.NODE_ENV
  process.env.NODE_ENV = 'production'
  await build({
    configFile: false,
    logLevel: 'silent',
    root: APP,
    resolve: {
      alias: main.resolve?.alias,
      conditions: ['node', 'import', 'default'],
      mainFields: ['module', 'jsnext:main', 'jsnext'],
    },
    build: {
      lib: {
        entry: 'electron/local-machine/transport.ts',
        formats: ['es'],
        fileName: () => 'transport.mjs',
      },
      outDir: join(dir, 'out'),
      minify: false,
      target: 'node22',
      commonjsOptions: main.build?.commonjsOptions,
      rollupOptions: { external: [...builtinModules, /^node:/] },
    },
  }).finally(() => {
    process.env.NODE_ENV = nodeEnv
  })
  ;({ openLocalSocket } = (await import(pathToFileURL(join(dir, 'out/transport.mjs')).href)) as {
    openLocalSocket: typeof openLocalSocket
  })
  server = createServer()
  wss = new WebSocketServer({ server })
  wss.on('connection', (ws) => ws.on('message', (data) => ws.send(`echo:${String(data)}`)))
  await new Promise<void>((done) => server.listen(join(dir, 's.sock'), done))
}, 60_000)

afterAll(async () => {
  for (const client of wss?.clients ?? []) client.terminate()
  await new Promise<void>((done) => (wss ? wss.close(() => server.close(() => done())) : done()))
  rmSync(dir, { recursive: true, force: true })
})

it('the bundled transport sends an auth-sized frame and a 200-byte frame', async () => {
  const socket = await openLocalSocket(join(dir, 's.sock'))
  const got: string[] = []
  socket.onMessage((text) => got.push(text))
  const auth = JSON.stringify({ type: 'auth', grant: `phosphor-local.v1.${'x'.repeat(40)}.` })
  const large = 'y'.repeat(200)
  expect(auth.length).toBeGreaterThanOrEqual(48)
  socket.send(auth)
  socket.send(large)
  await expect.poll(() => got).toEqual([`echo:${auth}`, `echo:${large}`])
  socket.close(1000, '')
})
