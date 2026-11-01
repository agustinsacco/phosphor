import { mkdtemp, readFile, writeFile, rm, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { HostInspection } from '../commands/doctor'
import { queryMachine } from './machine'
let root: string
let pi: NonNullable<HostInspection['pi']>
beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'machine-query-')))
  pi = {
    launch: { binaryPath: process.execPath, prefixArgs: [join(root, 'pi.cjs')], version: '1' },
    environment: { env: { ONLY: 'host' }, secrets: [], names: [], ambient: [], unset: [] },
  }
})
afterEach(async () => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
  await rm(root, { force: true, recursive: true })
})
it('uses only the validated launch, fixed RPC flags and exact Host environment', async () => {
  vi.stubEnv('CALLER_ENV', 'must not inherit')
  await writeFile(
    join(root, 'pi.cjs'),
    `process.stdin.on('data', c=>{const q=JSON.parse(c);console.log(JSON.stringify({type:'response',id:q.id,success:true,data:{commands:[process.argv.slice(2),process.env.ONLY,process.env.CALLER_ENV||null,process.cwd()]}}))})`,
  )
  expect(await queryMachine(pi, root, 'get_commands')).toEqual([
    ['--mode', 'rpc', '--no-session'],
    'host',
    null,
    root,
  ])
})
it('fails closed on launch errors, early exit and malformed result data', async () => {
  const missing = { ...pi, launch: { ...pi.launch, binaryPath: join(root, 'missing') } }
  await expect(queryMachine(missing, root, 'get_commands')).rejects.toMatchObject({
    code: 'internal',
  })
  await writeFile(join(root, 'pi.cjs'), 'process.exit(0)')
  await expect(queryMachine(pi, root, 'get_commands')).rejects.toMatchObject({ code: 'internal' })
  await writeFile(
    join(root, 'pi.cjs'),
    `process.stdin.on('data',c=>console.log(JSON.stringify({type:'response',id:'feature',success:true,data:null})))`,
  )
  await expect(queryMachine(pi, root, 'get_commands')).rejects.toMatchObject({ code: 'internal' })
})
// pi holds auth.json.lock while it refreshes an OAuth token at startup, and still holds
// it when it answers. Only an orderly exit removes the lock; a SIGKILL leaves it for 30s,
// and the next query (models right after commands) waits on it past its own deadline.
const released = () => join(root, 'released')
const recordExit = () =>
  `const fs=require('fs');const mark=w=>{fs.writeFileSync(${JSON.stringify(released())},w);process.exit(0)}`
it('closes stdin after the answer so pi exits in order and releases its locks', async () => {
  await writeFile(
    join(root, 'pi.cjs'),
    `${recordExit()}
process.stdin.on('data',c=>{const q=JSON.parse(c);console.log(JSON.stringify({type:'response',id:q.id,success:true,data:{commands:[]}}))})
process.stdin.on('end',()=>mark('eof'))
process.on('SIGTERM',()=>mark('term'))`,
  )
  expect(await queryMachine(pi, root, 'get_commands')).toEqual([])
  await vi.waitFor(async () => expect(await readFile(released(), 'utf8')).toBe('eof'), {
    timeout: 3000,
  })
})
it('sends SIGTERM before SIGKILL to a child that does not answer', async () => {
  const ready = join(root, 'ready')
  await writeFile(
    join(root, 'pi.cjs'),
    `${recordExit()}
process.on('SIGTERM',()=>mark('term'))
fs.writeFileSync(${JSON.stringify(ready)},'1')
setInterval(()=>{},1000)`,
  )
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  const query = queryMachine(pi, root, 'get_commands')
  const result = expect(query).rejects.toMatchObject({ code: 'internal' })
  await vi.waitFor(() => readFile(ready), { timeout: 3000 })
  await vi.advanceTimersByTimeAsync(15000)
  await result
  await vi.waitFor(async () => expect(await readFile(released(), 'utf8')).toBe('term'), {
    timeout: 3000,
  })
})
it('times out and kills a non-answering child', async () => {
  await writeFile(join(root, 'pi.cjs'), 'setInterval(()=>{},1000)')
  vi.useFakeTimers()
  const query = queryMachine(pi, root, 'get_commands')
  const result = expect(query).rejects.toMatchObject({ code: 'internal' })
  await vi.advanceTimersByTimeAsync(15000)
  await result
})
