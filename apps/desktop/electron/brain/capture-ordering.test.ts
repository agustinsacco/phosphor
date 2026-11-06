import { EventEmitter } from 'node:events'
import { afterEach, expect, it, vi } from 'vitest'
import type { BrainCapture } from '@phosphor/shared/brain'
import type { LiveSession } from '@phosphor/session-runtime/pi/session-registry'
import type {
  SessionInputReceipt,
  SessionUserInput,
} from '@phosphor/session-runtime/pi/session-startup'
import { PiRpcClient } from '@phosphor/session-runtime/pi/rpc-client'
import { withSessionInput } from '@phosphor/session-runtime/pi/session-input'
import type { DesktopMemoryClient } from './memory-client'
const authority = vi.hoisted(() => ({ scope: '/repo', branch: 'main' }))
vi.mock('./authority', async (original) => ({
  ...(await original<object>()),
  laneAuthority: async () => ({ ...authority }),
}))
import { attachBrainCapture } from './capture'

const cleanups: (() => void | Promise<void>)[] = []
afterEach(async () => {
  for (const close of cleanups.splice(0).reverse()) await close()
})
const response = (disposition: string) => ({
  type: 'response' as const,
  command: 'prompt',
  success: true as const,
  data: { disposition },
})
const entry = (id: string, text: string, parentId: string | null = null) => ({
  type: 'message',
  id,
  parentId,
  timestamp: new Date(Date.now() + 100).toISOString(),
  message: { role: 'user', content: text },
})
function memory() {
  const captures: BrainCapture[] = []
  const onError = vi.fn()
  const store = {
    snapshot: async () => ({ prefs: { enabled: true, workspaces: ['/repo'] }, policyEpoch: 1 }),
    captureAt: async (_epoch: number, capture: BrainCapture) => {
      captures.push(capture)
      return null
    },
  } as unknown as DesktopMemoryClient
  return { captures, onError, store }
}
async function fixture() {
  authority.branch = 'main'
  const m = memory()
  let entries = [entry('baseline', 'old history')]
  const client = Object.assign(new EventEmitter(), {
    request: vi.fn(async (command: { type: string }) =>
      command.type === 'get_state'
        ? { success: true, data: { sessionId: 'native' } }
        : { success: true, data: { entries } },
    ),
  })
  const live = { sessionId: 'runtime', workspacePath: '/repo', client } as unknown as LiveSession
  const observer = await attachBrainCapture(live, m.store, 1, m.onError)
  cleanups.push(observer)
  live.memoryInput = {
    beforeInput: observer.beforeInput,
    invalidate: observer,
    failed: async () => observer(),
  }
  const scan = async (): Promise<void> => {
    client.emit('event', { type: 'agent_end' })
    await new Promise((resolve) => setImmediate(resolve))
  }
  return {
    ...m,
    client,
    live,
    observer,
    scan,
    setEntries(value: typeof entries) {
      entries = value
    },
    admit: (text: string) => observer.beforeInput({ type: 'prompt', message: text }),
  }
}
it('captures a unique successful input when its response and agent_end are coalesced by the actual PiRpcClient', async () => {
  authority.branch = 'main'
  const m = memory()
  const source = `let entries=[];let buffer='';process.stdin.on('data',chunk=>{buffer+=chunk;let end;while((end=buffer.indexOf('\\n'))>=0){const q=JSON.parse(buffer.slice(0,end));buffer=buffer.slice(end+1);let data={};let event='';if(q.type==='get_state')data={sessionId:'native'};if(q.type==='get_entries')data={entries};if(q.type==='prompt'){entries.push({type:'message',id:'input',parentId:null,timestamp:new Date().toISOString(),message:{role:'user',content:q.message}});data={disposition:'started'};event=JSON.stringify({type:'agent_end'})+'\\n';}process.stdout.write(JSON.stringify({id:q.id,type:'response',command:q.type,success:true,data})+'\\n'+event)}});`
  const client = new PiRpcClient(
    {
      cwd: import.meta.dirname,
      binaryPath: process.execPath,
      prefixArgs: ['-e', source],
      inheritEnv: false,
      env: {},
    },
    { log() {}, isClosing: () => false },
  )
  client.spawn()
  cleanups.push(() => client.dispose(100))
  const live: LiveSession = { sessionId: 'runtime', workspacePath: '/repo', client }
  const observer = await attachBrainCapture(live, m.store, 1, m.onError)
  cleanups.push(observer)
  const order: string[] = []
  client.on('event', (event) => {
    if (event.type === 'agent_end') order.push('event')
  })
  live.memoryInput = {
    beforeInput: async (command: SessionUserInput): Promise<SessionInputReceipt | undefined> => {
      const receipt = await observer.beforeInput(command)
      return (
        receipt && {
          complete: async (result) => {
            order.push('complete')
            await receipt.complete(result)
          },
        }
      )
    },
    invalidate: observer,
    failed: async () => observer(),
  }
  const command = { type: 'prompt' as const, message: 'actual admitted user input' }
  await withSessionInput(live, command, () => client.request(command))
  expect(order).toEqual(['event', 'complete'])
  expect(m.onError).not.toHaveBeenCalled()
  expect(m.captures).toMatchObject([{ entryId: 'input', text: command.message, branch: 'main' }])
})
it('preserves earlier unresolved and later queued receipts until both complete', async () => {
  const f = await fixture()
  const first = await f.admit('first input')
  f.setEntries([entry('baseline', 'old history'), entry('first', 'first input', 'baseline')])
  await f.scan()
  authority.branch = 'second'
  const second = await f.admit('second input')
  f.setEntries([
    entry('baseline', 'old history'),
    entry('first', 'first input', 'baseline'),
    entry('second', 'second input', 'first'),
  ])
  await f.scan()
  await second?.complete(response('queued'))
  expect(f.captures).toEqual([])
  await first?.complete(response('started'))
  expect(f.captures).toMatchObject([
    { entryId: 'first', branch: 'main' },
    { entryId: 'second', branch: 'second' },
  ])
})
it('keeps pre-admission entries ineligible for a later receipt while an earlier input is unresolved', async () => {
  const f = await fixture()
  const first = await f.admit('first input')
  f.setEntries([
    entry('baseline', 'old history'),
    entry('first', 'first input', 'baseline'),
    entry('unadmitted', 'later text', 'first'),
  ])
  await f.scan()
  const later = await f.admit('later text')
  await first?.complete(response('started'))
  await later?.complete(response('queued'))
  expect(f.captures.map((capture) => capture.entryId)).toEqual(['first'])
  f.setEntries([
    entry('baseline', 'old history'),
    entry('first', 'first input', 'baseline'),
    entry('unadmitted', 'later text', 'first'),
    entry('later', 'later text', 'unadmitted'),
  ])
  await f.scan()
  expect(f.captures.map((capture) => capture.entryId)).toEqual(['first', 'later'])
})
it.each(['handled', 'failed'])(
  'does not capture entries observed before an unresolved receipt becomes %s',
  async (outcome) => {
    const f = await fixture()
    const receipt = await f.admit('not accepted')
    f.setEntries([entry('baseline', 'old history'), entry('generated', 'not accepted', 'baseline')])
    await f.scan()
    await receipt?.complete(
      outcome === 'handled'
        ? response('handled')
        : { type: 'response', command: 'prompt', success: false, error: 'Rejected' },
    )
    const later = await f.admit('not accepted')
    await later?.complete(response('started'))
    expect(f.captures).toEqual([])
  },
)
it('does not guess among duplicate texts across multiple unresolved receipts', async () => {
  const f = await fixture()
  const first = await f.admit('same text')
  f.setEntries([entry('baseline', 'old history'), entry('one', 'same text', 'baseline')])
  await f.scan()
  const second = await f.admit('same text')
  f.setEntries([
    entry('baseline', 'old history'),
    entry('one', 'same text', 'baseline'),
    entry('two', 'same text', 'one'),
  ])
  await f.scan()
  await first?.complete(response('started'))
  await second?.complete(response('queued'))
  expect(f.captures).toEqual([])
})
