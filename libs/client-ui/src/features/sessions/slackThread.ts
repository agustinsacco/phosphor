import type { ChatItem } from '@/features/chat/chatItems'

/**
 * Slack threads a lane's transcript mentions, as quick links in its header.
 *
 * Only user prompts and finished assistant text count: tool output (for example
 * a Slack search through MCP) can hold dozens of links the lane never cared
 * about. Nothing is stored; the list is re-derived from the chat store, which
 * Desktop and the Host PWA both already hold for the active lane.
 */
export interface SlackThread {
  /** `channel:threadTs`, so a reply and its root collapse to one link. */
  key: string
  /** Rebuilt from the parsed parts, never the pasted string. */
  url: string
  /** Subdomain label: `acme` for acme.slack.com, `app` for the web client. */
  workspace: string
  channel: string
  /** Root of the thread, `seconds.micros`. */
  threadTs: string
  /** The message that mentioned it, with links removed, to jog the memory. */
  snippet: string
}

const URL_CANDIDATE = /https:\/\/[^\s<>()"'`|\]]+/g
const CHANNEL = /^[CGD][A-Z0-9]{2,}$/
const TS = /^\d{10}\.\d{6}$/
const HOST_LABEL = /^[a-z0-9-]+$/
const SNIPPET_MAX = 80

/** One Slack message or thread link, or null for anything else. */
export function parseSlackThreadUrl(raw: string): Omit<SlackThread, 'snippet'> | null {
  let url: URL
  try {
    url = new URL(raw.replace(/[.,;:!?*_~]+$/, ''))
  } catch {
    return null
  }
  const host = url.hostname
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return null
  if (host !== 'slack.com' && !host.endsWith('.slack.com')) return null
  if (!host.split('.').every((label) => HOST_LABEL.test(label))) return null
  const workspace = host === 'slack.com' ? 'slack' : (host.split('.')[0] ?? 'slack')
  return archiveLink(url, host, workspace) ?? clientLink(url, host, workspace)
}

/** `/archives/C…/p1730563200123456[?thread_ts=…]`, the "Copy link" form. */
function archiveLink(
  url: URL,
  host: string,
  workspace: string,
): Omit<SlackThread, 'snippet'> | null {
  const [, channel = '', seconds, micros] =
    /^\/archives\/([^/]+)\/p(\d{10})(\d{6})\/?$/.exec(url.pathname) ?? []
  if (!CHANNEL.test(channel)) return null
  const ts = `${seconds}.${micros}`
  const parent = url.searchParams.get('thread_ts')
  const threadTs = parent && TS.test(parent) ? parent : ts
  const path = `https://${host}/archives/${channel}/p${ts.replace('.', '')}`
  return {
    key: `${channel}:${threadTs}`,
    url: threadTs === ts ? path : `${path}?thread_ts=${threadTs}&cid=${channel}`,
    workspace,
    channel,
    threadTs,
  }
}

/** `app.slack.com/client/T…/C…/thread/C…-1730563200.123456`, the browser's address bar. */
function clientLink(
  url: URL,
  host: string,
  workspace: string,
): Omit<SlackThread, 'snippet'> | null {
  const [, team, channel = '', threadChannel, threadTs = ''] =
    /^\/client\/(T[A-Z0-9]{2,})\/([^/]+)\/thread\/([^/-]+)-(\d{10}\.\d{6})\/?$/.exec(
      url.pathname,
    ) ?? []
  if (!CHANNEL.test(channel) || channel !== threadChannel) return null
  return {
    key: `${channel}:${threadTs}`,
    url: `https://${host}/client/${team}/${channel}/thread/${channel}-${threadTs}`,
    workspace,
    channel,
    threadTs,
  }
}

function snippetOf(text: string): string {
  const plain = text
    .replace(URL_CANDIDATE, ' ')
    .replace(/[<>[\]()|]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/ ([,.;:!?])/g, '$1')
    .trim()
  return plain.length > SNIPPET_MAX ? `${plain.slice(0, SNIPPET_MAX - 1).trimEnd()}…` : plain
}

/** Every Slack thread in one block of text, first mention first. */
export function findSlackThreads(text: string): SlackThread[] {
  if (!text.includes('slack.com')) return []
  const found: SlackThread[] = []
  for (const candidate of text.match(URL_CANDIDATE) ?? []) {
    const link = parseSlackThreadUrl(candidate)
    if (link && !found.some((f) => f.key === link.key)) {
      found.push({ ...link, snippet: snippetOf(text) })
    }
  }
  return found
}

// Items are replaced, not mutated, so an unchanged item keeps its parse.
const perItem = new WeakMap<ChatItem, SlackThread[]>()

function itemThreads(item: ChatItem): SlackThread[] {
  const cached = perItem.get(item)
  if (cached) return cached
  let threads: SlackThread[] = []
  if (item.kind === 'user') threads = findSlackThreads(item.text)
  else if (item.kind === 'assistant' && !item.streaming) {
    const text = item.blocks.map((b) => (b.type === 'text' ? b.text : '')).join('\n')
    threads = findSlackThreads(text)
  } else if (item.kind === 'assistant') return [] // re-read once it settles
  perItem.set(item, threads)
  return threads
}

/** The lane's threads, deduplicated, in the order the transcript first mentions them. */
export function slackThreadsInTranscript(items: readonly ChatItem[] | undefined): SlackThread[] {
  const seen = new Map<string, SlackThread>()
  for (const item of items ?? []) {
    for (const thread of itemThreads(item)) if (!seen.has(thread.key)) seen.set(thread.key, thread)
  }
  return [...seen.values()]
}
