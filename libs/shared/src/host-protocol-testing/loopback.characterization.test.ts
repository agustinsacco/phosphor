import { expect, it } from 'vitest'
import { createLoopbackPair } from './loopback'

it('finishes current listeners before pausing and preserves reentrant send order on resume', async () => {
  const pair = createLoopbackPair()
  const events: string[] = []
  pair.server.onMessage((text) => {
    events.push(`first:${text}`)
    if (text === 'a') {
      pair.server.send('reply')
      pair.client.send('c')
      pair.pause()
    }
  })
  pair.server.onMessage((text) => events.push(`second:${text}`))
  pair.client.onMessage((text) => events.push(`client:${text}`))
  pair.client.send('a')
  pair.client.send('b')
  expect(events).toEqual([])
  await Promise.resolve()
  expect(events).toEqual(['first:a', 'second:a'])
  expect(pair.client.bufferedBytes()).toBe(2)
  expect(pair.server.bufferedBytes()).toBe(5)
  pair.resume()
  expect(events).toEqual(['first:a', 'second:a'])
  await Promise.resolve()
  expect(events).toEqual([
    'first:a',
    'second:a',
    'first:b',
    'second:b',
    'client:reply',
    'first:c',
    'second:c',
  ])
  expect(pair.client.bufferedBytes()).toBe(0)
  expect(pair.server.bufferedBytes()).toBe(0)
})

it('finishes current listeners on close, clears both queues and notifies both ends once asynchronously', async () => {
  const pair = createLoopbackPair()
  const events: string[] = []
  pair.server.onMessage((text) => {
    events.push(`first:${text}`)
    pair.server.send('reply')
    pair.client.close(4000, 'first close')
    expect(pair.client.isOpen()).toBe(false)
    expect(pair.server.isOpen()).toBe(false)
    expect(pair.client.bufferedBytes()).toBe(0)
    expect(pair.server.bufferedBytes()).toBe(0)
    pair.server.close(4001, 'ignored')
    pair.sever()
  })
  pair.server.onMessage((text) => events.push(`second:${text}`))
  pair.client.onMessage((text) => events.push(`client:${text}`))
  pair.client.onClose((code, reason) => events.push(`client close:${code}:${reason}`))
  pair.client.onClose((code) => events.push(`client second close:${code}`))
  pair.server.onClose((code, reason) => events.push(`server close:${code}:${reason}`))
  pair.client.send('a')
  pair.client.send('b')
  await Promise.resolve()
  expect(events).toEqual(['first:a', 'second:a'])
  await Promise.resolve()
  expect(events).toEqual([
    'first:a',
    'second:a',
    'client close:4000:first close',
    'client second close:4000',
    'server close:4000:first close',
  ])
  pair.resume()
  pair.sever()
  await Promise.resolve()
  expect(events).toHaveLength(5)
  expect(() => pair.server.send('late')).toThrow('Socket closed')
})

it('drops before queue accounting even at capacity and never delivers inline', async () => {
  const pair = createLoopbackPair({ queueBytes: 4 })
  const received: string[] = []
  pair.server.onMessage((text) => received.push(text))
  pair.pause()
  pair.client.send('😀')
  pair.dropNext()
  pair.server.send('dropped')
  expect(pair.client.isOpen()).toBe(true)
  expect(pair.client.bufferedBytes()).toBe(4)
  expect(pair.server.bufferedBytes()).toBe(0)
  await Promise.resolve()
  expect(received).toEqual([])
  pair.resume()
  expect(received).toEqual([])
  await Promise.resolve()
  expect(received).toEqual(['😀'])
  pair.dropNext(0)
  pair.client.send('next')
  expect(received).toEqual(['😀'])
  await Promise.resolve()
  expect(received).toEqual(['😀', 'next'])
})
