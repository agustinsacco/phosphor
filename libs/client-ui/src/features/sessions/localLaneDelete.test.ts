import { beforeEach, expect, it } from 'vitest'
import type { SessionMeta } from '@shared/models'
import { useChatStore, type ChatSession } from '@/stores/chat'
import { usePullRequestsStore } from '@/stores/pullRequests'
import { useSessionsStore } from '@/stores/sessions'
import { buildLaneDelete } from './localLaneDelete'

const lane = (n: number): SessionMeta =>
  ({
    path: `/repo/s${n}.jsonl`,
    sessionId: `s${n}`,
    cwd: '/repo',
    createdAt: '',
    name: `Lane ${n}`,
    firstUserText: '',
    mtimeMs: 0,
    lastActivityAt: '',
    branchCount: 0,
    cost: 0,
  }) as SessionMeta

beforeEach(() => {
  usePullRequestsStore.setState({ byRepo: {} })
  useSessionsStore.setState({
    disk: { '/repo': [lane(1), lane(2)] },
    live: { p1: { phosphorId: 'p1', workspacePath: '/repo', diskPath: '/repo/s1.jsonl' } },
    gitByCwd: {},
    laneMarkers: {},
  })
  useChatStore.setState({
    sessions: {
      p1: { meta: { sessionName: 'Live name' }, isStreaming: true } as unknown as ChatSession,
    },
  })
})

it('titles and warns a lane through its live session, found by its session file', () => {
  const { lanes } = buildLaneDelete(['/repo/s1.jsonl', '/repo/s2.jsonl'], '/repo')
  expect(lanes.map((l) => [l.title, l.warnings])).toEqual([
    ['Live name', ['running']],
    ['Lane 2', []],
  ])
})
