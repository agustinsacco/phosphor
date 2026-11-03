import { expect, it } from 'vitest'
import type { ChatItem } from '@/features/chat/chatItems'
import { findSlackThreads, parseSlackThreadUrl, slackThreadsInTranscript } from './slackThread'

const ROOT = 'https://acme.slack.com/archives/C0123ABC/p1730563200123456'

it.each([
  [ROOT, ROOT, 'C0123ABC:1730563200.123456'],
  [
    'https://acme.slack.com/archives/C0123ABC/p1730563300654321?thread_ts=1730563200.123456&cid=C0123ABC',
    'https://acme.slack.com/archives/C0123ABC/p1730563300654321?thread_ts=1730563200.123456&cid=C0123ABC',
    'C0123ABC:1730563200.123456',
  ],
  [
    'https://acme.enterprise.slack.com/archives/G9ZZ/p1730563200123456/',
    'https://acme.enterprise.slack.com/archives/G9ZZ/p1730563200123456',
    'G9ZZ:1730563200.123456',
  ],
  [
    'https://app.slack.com/client/T01ABC/C0123ABC/thread/C0123ABC-1730563200.123456',
    'https://app.slack.com/client/T01ABC/C0123ABC/thread/C0123ABC-1730563200.123456',
    'C0123ABC:1730563200.123456',
  ],
  [`${ROOT}#junk`, ROOT, 'C0123ABC:1730563200.123456'],
  [`${ROOT}?utm=x&thread_ts=nope`, ROOT, 'C0123ABC:1730563200.123456'],
  [`${ROOT}.`, ROOT, 'C0123ABC:1730563200.123456'],
])('accepts %s and rebuilds the link it opens', (raw, url, key) => {
  expect(parseSlackThreadUrl(raw)).toMatchObject({ url, key })
})

it.each([
  'http://acme.slack.com/archives/C0123ABC/p1730563200123456',
  'https://acme.slack.com.evil.io/archives/C0123ABC/p1730563200123456',
  'https://evil.io/archives/C0123ABC/p1730563200123456?slack.com',
  'https://evilslack.com/archives/C0123ABC/p1730563200123456',
  'https://user:pw@acme.slack.com/archives/C0123ABC/p1730563200123456',
  'https://acme.slack.com:8443/archives/C0123ABC/p1730563200123456',
  'https://acme.slack.com/archives/C0123ABC',
  'https://acme.slack.com/archives/x0123/p1730563200123456',
  'https://acme.slack.com/archives/C0123ABC/p17305632',
  'https://app.slack.com/client/T01ABC/C0123ABC/thread/C9999-1730563200.123456',
  'https://slack.com/help/articles/123',
])('rejects %s', (raw) => {
  expect(parseSlackThreadUrl(raw)).toBeNull()
})

it('finds links inside markdown, angle brackets and Slack <url|label> text, deduplicated', () => {
  const reply = `${ROOT.replace('p1730563200123456', 'p1730563300654321')}?thread_ts=1730563200.123456`
  const text = `See [the ask](${ROOT}), and <${reply}|this reply>. Also https://acme.slack.com/archives/C0999/p1730000000000001!`
  const found = findSlackThreads(text)
  expect(found.map((t) => t.key)).toEqual(['C0123ABC:1730563200.123456', 'C0999:1730000000.000001'])
  expect(found[0]?.snippet).toBe('See the ask, and this reply. Also')
})

it('keeps snippets short', () => {
  const [thread] = findSlackThreads(`${'word '.repeat(40)}${ROOT}`)
  expect(thread?.snippet.length).toBeLessThanOrEqual(80)
  expect(thread?.snippet.endsWith('…')).toBe(true)
})

it('reads prompts and settled assistant text, first mention first, never tool output or a stream', () => {
  const other = 'https://acme.slack.com/archives/C0999/p1730000000000001'
  const items: ChatItem[] = [
    { id: '1', kind: 'user', text: `fix what they asked in ${ROOT}` },
    {
      id: '2',
      kind: 'assistant',
      streaming: false,
      blocks: [
        {
          type: 'thinking',
          index: 0,
          text: 'https://acme.slack.com/archives/C0777/p1730000000000001',
          closed: true,
        },
        { type: 'text', index: 1, text: `Related: ${other} and again ${ROOT}`, closed: true },
      ],
    } as ChatItem,
    {
      id: '3',
      kind: 'assistant',
      streaming: true,
      blocks: [
        {
          type: 'text',
          index: 0,
          text: 'https://acme.slack.com/archives/C0555/p1730000000000001',
          closed: false,
        },
      ],
    } as ChatItem,
  ]
  const threads = slackThreadsInTranscript(items)
  expect(threads.map((t) => t.channel)).toEqual(['C0123ABC', 'C0999'])
  expect(threads[0]?.snippet).toBe('fix what they asked in')
  expect(slackThreadsInTranscript(undefined)).toEqual([])
})
