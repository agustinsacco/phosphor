import { mkdtemp, writeFile, rm, realpath } from 'node:fs/promises'
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
it('times out and kills a non-answering child', async () => {
  await writeFile(join(root, 'pi.cjs'), 'setInterval(()=>{},1000)')
  vi.useFakeTimers()
  const query = queryMachine(pi, root, 'get_commands')
  const result = expect(query).rejects.toMatchObject({ code: 'internal' })
  await vi.advanceTimersByTimeAsync(15000)
  await result
})
