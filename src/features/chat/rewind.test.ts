import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ImageContent, RpcCommand, RpcSessionState } from '@shared/rpc'
import { useChatStore } from '@/stores/chat'
import { useSessionsStore } from '@/stores/sessions'
import { useChatUiStore } from './uiState'
import type { ChatItem, UserItem } from './chatItems'
import {
  branchMessageForItem,
  currentBranchUserMessages,
  matchRenderedUserMessage,
  rewindToEntry,
} from './rewind'

const invoke = vi.fn()
const piCommand = vi.fn()

function sessionState(sessionFile: string): RpcSessionState {
  return {
    thinkingLevel: 'medium',
    isStreaming: false,
    isCompacting: false,
    steeringMode: 'all',
    followUpMode: 'all',
    sessionFile,
    sessionId: 'pi-session',
    autoCompactionEnabled: true,
    messageCount: 2,
    pendingMessageCount: 0,
  }
}

beforeEach(() => {
  invoke.mockReset().mockResolvedValue(undefined)
  piCommand.mockReset()
  vi.stubGlobal('window', { phosphor: { invoke, piCommand } })
  useChatStore.setState({ sessions: {} }, false)
  useChatUiStore.setState({ prefill: {}, forkPickerFor: null, verbose: {} }, false)
  useSessionsStore.setState({
    live: {
      s1: { phosphorId: 's1', workspacePath: '/repo', diskPath: '/repo/.pi/sessions/old.jsonl' },
    },
    activeSessionId: 's1',
  })
})

/**
 * `fork` always branches pi's live session onto a brand-new file — verified
 * against the installed pi core (`SessionManager.createBranchedSession`),
 * which never truncates the current file in place. So a successful rewind
 * must relearn `sessionFile` via `get_state`, or `live.diskPath` keeps
 * pointing at the file pi just abandoned and the sidebar shows the stale
 * pre-fork session as if it were still the live one.
 */
describe('rewindToEntry', () => {
  it('relearns the new session file so the sidebar stops tracking the abandoned one', async () => {
    piCommand.mockImplementation((_sessionId: string, command: RpcCommand) => {
      switch (command.type) {
        case 'fork':
          expect(command.entryId).toBe('entry-2')
          return Promise.resolve({
            success: true,
            data: { text: 'edited message', cancelled: false },
          })
        case 'get_messages':
          return Promise.resolve({ success: true, data: { messages: [] } })
        case 'get_state':
          return Promise.resolve({
            success: true,
            data: sessionState('/repo/.pi/sessions/new-branch.jsonl'),
          })
        default:
          return Promise.resolve({ success: false })
      }
    })

    await rewindToEntry('s1', 'entry-2')

    expect(useSessionsStore.getState().live.s1?.diskPath).toBe(
      '/repo/.pi/sessions/new-branch.jsonl',
    )
    expect(useChatUiStore.getState().prefill.s1).toEqual({
      text: 'edited message',
      images: undefined,
    })
  })

  /**
   * pi's `fork` reply carries `selectedText` only, so the caller has to hand
   * the images back itself or a rewound screenshot is gone for good.
   */
  it('restores the images the caller passes alongside the text', async () => {
    piCommand.mockImplementation((_sessionId: string, command: RpcCommand) => {
      switch (command.type) {
        case 'fork':
          return Promise.resolve({
            success: true,
            data: { text: 'look at this', cancelled: false },
          })
        case 'get_messages':
          return Promise.resolve({ success: true, data: { messages: [] } })
        case 'get_state':
          return Promise.resolve({ success: true, data: sessionState('/repo/.pi/new.jsonl') })
        default:
          return Promise.resolve({ success: false })
      }
    })
    const images: ImageContent[] = [{ type: 'image', data: 'AAA', mimeType: 'image/png' }]

    await rewindToEntry('s1', 'entry-2', images)

    expect(useChatUiStore.getState().prefill.s1).toEqual({ text: 'look at this', images })
  })

  it('does not touch diskPath or the transcript when an extension cancels the fork', async () => {
    piCommand.mockImplementation((_sessionId: string, command: RpcCommand) => {
      if (command.type === 'fork') {
        return Promise.resolve({ success: true, data: { text: '', cancelled: true } })
      }
      return Promise.resolve({ success: false })
    })

    await rewindToEntry('s1', 'entry-2')

    expect(useSessionsStore.getState().live.s1?.diskPath).toBe('/repo/.pi/sessions/old.jsonl')
    expect(useChatStore.getState().sessions.s1?.error).toBe('Rewind was cancelled by an extension.')
    expect(piCommand).toHaveBeenCalledTimes(1)
  })

  it('does nothing further when the fork RPC call itself fails', async () => {
    piCommand.mockResolvedValue({ success: false, error: 'session gone' })

    await rewindToEntry('s1', 'entry-2')

    expect(useSessionsStore.getState().live.s1?.diskPath).toBe('/repo/.pi/sessions/old.jsonl')
    expect(piCommand).toHaveBeenCalledTimes(1)
  })
})

// ---------------------------------------------------------------------------
// Which entry a rewind forks from
// ---------------------------------------------------------------------------

const image = (data: string): ImageContent => ({ type: 'image', data, mimeType: 'image/png' })

let nextTs = 1_000
function userEntry(
  id: string,
  parentId: string | null,
  content: string | Array<Record<string, unknown>>,
  timestamp = nextTs++,
): Record<string, unknown> {
  return { type: 'message', id, parentId, message: { role: 'user', content, timestamp } }
}
function assistantEntry(id: string, parentId: string): Record<string, unknown> {
  return {
    type: 'message',
    id,
    parentId,
    message: { role: 'assistant', content: [{ type: 'text', text: `re ${parentId}` }] },
  }
}

/** What pi's rendered transcript holds for a user entry: text + timestamp. */
function renderedUser(id: string, entry: Record<string, unknown>, extra?: Partial<UserItem>) {
  const message = entry.message as { content: string; timestamp: number }
  const text = typeof message.content === 'string' ? message.content : ''
  return { id, kind: 'user' as const, text, timestamp: message.timestamp, ...extra }
}

function serveEntries(entries: Array<Record<string, unknown>>, leafId: string | null): void {
  piCommand.mockImplementation((_sessionId: string, command: RpcCommand) => {
    if (command.type === 'get_entries') {
      return Promise.resolve({ success: true, data: { entries, leafId } })
    }
    return Promise.resolve({ success: false })
  })
}

/**
 * The shape that lost a user most of a thread: a session file holding an
 * abandoned branch and an image-only message, then a compaction. pi's
 * `get_fork_messages` lists all six text messages across both branches; the
 * transcript renders only what the compaction kept. The old ordinal mapping
 * sent "Rewind" on the second rendered message to fork candidate #1, the
 * abandoned branch's second message.
 */
function compactedBranchedSession() {
  const u1 = userEntry('u1', null, 'start the migration')
  const a1 = assistantEntry('a1', 'u1')
  // Abandoned branch off a1: rewound away from long ago.
  const x1 = userEntry('x1', 'a1', 'abandoned idea')
  const xa = assistantEntry('xa', 'x1')
  const x2 = userEntry('x2', 'xa', 'abandoned follow-up')
  // The current branch, also off a1.
  const u2 = userEntry('u2', 'a1', [{ type: 'image', data: 'SHOT', mimeType: 'image/png' }])
  const a2 = assistantEntry('a2', 'u2')
  const u3 = userEntry('u3', 'a2', 'continue')
  const a3 = assistantEntry('a3', 'u3')
  const compaction = {
    type: 'compaction',
    id: 'c1',
    parentId: 'a3',
    firstKeptEntryId: 'u3',
    summary: 'earlier work',
    tokensBefore: 180_000,
  }
  const u4 = userEntry('u4', 'c1', [
    { type: 'text', text: 'check this' },
    { type: 'image', data: 'PIC', mimeType: 'image/jpeg' },
  ])
  const a4 = assistantEntry('a4', 'u4')
  const u5 = userEntry('u5', 'a4', 'continue')
  const a5 = assistantEntry('a5', 'u5')
  return {
    entries: [u1, a1, x1, xa, x2, u2, a2, u3, a3, compaction, u4, a4, u5, a5],
    leafId: 'a5',
    byId: { u1, u2, u3, u4, u5, x1, x2 },
  }
}

describe('currentBranchUserMessages', () => {
  it('lists the current branch only, including compacted and image-only messages', async () => {
    const session = compactedBranchedSession()
    serveEntries(session.entries, session.leafId)

    const branch = await currentBranchUserMessages('s1')

    expect(branch?.map((m) => m.entryId)).toEqual(['u1', 'u2', 'u3', 'u4', 'u5'])
    expect(branch?.[1]).toMatchObject({ text: '', images: [image('SHOT')] })
    expect(branch?.[3]).toMatchObject({
      text: 'check this',
      images: [{ type: 'image', data: 'PIC', mimeType: 'image/jpeg' }],
    })
  })

  it('follows the leaf pi reports, not the last line of the file', async () => {
    const session = compactedBranchedSession()
    // Navigated back onto the abandoned branch (a tree jump).
    serveEntries(session.entries, 'x2')

    const branch = await currentBranchUserMessages('s1')

    expect(branch?.map((m) => m.entryId)).toEqual(['u1', 'x1', 'x2'])
  })

  it('treats a null leaf as an empty branch, as pi does', async () => {
    const session = compactedBranchedSession()
    serveEntries(session.entries, null)

    expect(await currentBranchUserMessages('s1')).toEqual([])
  })

  it('returns null when the entries cannot be read', async () => {
    piCommand.mockResolvedValue({ success: false, error: 'session gone' })

    expect(await currentBranchUserMessages('s1')).toBeNull()
  })
})

describe('matchRenderedUserMessage', () => {
  it('matches by timestamp, whatever the compaction and abandoned branch did to positions', async () => {
    const session = compactedBranchedSession()
    serveEntries(session.entries, session.leafId)
    const branch = (await currentBranchUserMessages('s1'))!
    // What get_messages renders after the compaction: u3 onward.
    const rendered = [
      renderedUser('r3', session.byId.u3),
      { id: 'ra3', kind: 'assistant' as const, blocks: [] },
      renderedUser('r4', session.byId.u4, { text: 'check this' }),
      renderedUser('r5', session.byId.u5),
    ] as ChatItem[]

    expect(matchRenderedUserMessage(branch, rendered, rendered[0] as UserItem)?.entryId).toBe('u3')
    expect(matchRenderedUserMessage(branch, rendered, rendered[2] as UserItem)?.entryId).toBe('u4')
    expect(matchRenderedUserMessage(branch, rendered, rendered[3] as UserItem)?.entryId).toBe('u5')
  })

  it('misses rather than guesses when the timestamp is on no branch message', async () => {
    const session = compactedBranchedSession()
    serveEntries(session.entries, session.leafId)
    const branch = (await currentBranchUserMessages('s1'))!
    // Same text as u5, but a message the current branch does not hold.
    const stale: UserItem = { id: 'r9', kind: 'user', text: 'continue', timestamp: 1 }

    expect(matchRenderedUserMessage(branch, [stale], stale)).toBeNull()
  })

  it('breaks a shared-millisecond tie by text, and misses when text cannot', () => {
    const branch = [
      { entryId: 'e1', text: 'one', timestamp: 5 },
      { entryId: 'e2', text: 'two', timestamp: 5 },
    ]
    const two: UserItem = { id: 'r2', kind: 'user', text: 'two', timestamp: 5 }
    const other: UserItem = { id: 'r3', kind: 'user', text: 'three', timestamp: 5 }

    expect(matchRenderedUserMessage(branch, [two], two)?.entryId).toBe('e2')
    expect(matchRenderedUserMessage(branch, [other], other)).toBeNull()
  })

  it('without a timestamp, counts identical texts from the end', () => {
    const branch = [
      { entryId: 'e1', text: 'continue', timestamp: 1 },
      { entryId: 'e2', text: 'other', timestamp: 2 },
      { entryId: 'e3', text: 'continue', timestamp: 3 },
      { entryId: 'e4', text: 'continue', timestamp: 4 },
    ]
    // The transcript lost e1 to a compaction; none of these carry a timestamp.
    const rendered = [
      { id: 'r2', kind: 'user', text: 'other' },
      { id: 'r3', kind: 'user', text: 'continue' },
      { id: 'r4', kind: 'user', text: 'continue' },
      { id: 'r5', kind: 'user', text: 'continue', optimistic: true },
    ] as ChatItem[]

    expect(matchRenderedUserMessage(branch, rendered, rendered[1] as UserItem)?.entryId).toBe('e3')
    expect(matchRenderedUserMessage(branch, rendered, rendered[2] as UserItem)?.entryId).toBe('e4')
    expect(matchRenderedUserMessage(branch, rendered, rendered[0] as UserItem)?.entryId).toBe('e2')
  })

  it('without a timestamp, misses when no branch message has the text', () => {
    const branch = [{ entryId: 'e1', text: 'hello', timestamp: 1 }]
    const item: UserItem = { id: 'r1', kind: 'user', text: 'goodbye' }

    expect(matchRenderedUserMessage(branch, [item], item)).toBeNull()
  })
})

describe('branchMessageForItem', () => {
  it('resolves against the transcript as it stands after the round trip', async () => {
    const session = compactedBranchedSession()
    serveEntries(session.entries, session.leafId)
    const item = renderedUser('r5', session.byId.u5)
    useChatStore.setState({ sessions: { s1: { items: [item] } } } as never, false)

    expect((await branchMessageForItem('s1', item))?.entryId).toBe('u5')
  })
})
