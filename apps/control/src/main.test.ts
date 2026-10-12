import { expect, it } from 'vitest'
import { spawn, execFileSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'
import { request } from 'node:http'

it('bundles without runtime node_modules, serves health/site unconfigured and exits on SIGTERM', async () => {
  execFileSync(process.execPath, ['apps/control/scripts/build.mjs'], { stdio: 'pipe' })
  const dir = await mkdtemp(join(tmpdir(), 'phosphor-control-bundle-'))
  await writeFile(join(dir, 'index.html'), 'home')
  const child = spawn(process.execPath, ['apps/control/dist/server.mjs'], {
    env: { ...process.env, PORT: '0', SITE_DIR: dir, SUPABASE_SECRET_KEY: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  const deadline = setTimeout(() => child.kill('SIGKILL'), 5000)
  try {
    const port = await new Promise<number>((resolve, reject) => {
      child.on('error', reject)
      child.on('exit', () => reject(new Error('Server exited before ready')))
      child.stdout.on('data', (chunk) => {
        output += String(chunk)
        const match = output.match(/"port":(\d+)/)
        if (match?.[1]) resolve(Number(match[1]))
      })
    })
    const res = await fetch(`http://127.0.0.1:${port}/healthz`)
    expect(res.status).toBe(200)
    expect(await (await fetch(`http://127.0.0.1:${port}/`)).text()).toBe('home')
    for (const [path, status] of [
      ['/../', 404],
      ['/%2e%2e/', 404],
      ['/api/../', 400],
    ] as const) {
      const result = await new Promise<number | undefined>((resolve, reject) => {
        const req = request({ hostname: '127.0.0.1', port, path }, (res) => {
          res.resume()
          res.on('end', () => resolve(res.statusCode))
        })
        req.on('error', reject)
        req.end()
      })
      expect(result).toBe(status)
    }
    const exit = once(child, 'exit')
    child.kill('SIGTERM')
    expect((await exit)[0]).toBe(0)
  } finally {
    clearTimeout(deadline)
    if (child.exitCode === null) child.kill('SIGKILL')
    await rm(dir, { recursive: true, force: true })
  }
})
