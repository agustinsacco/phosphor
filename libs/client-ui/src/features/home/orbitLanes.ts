import type { HostLaneView } from '@shared/ipc'
import { relativeTimeShort } from '@/lib/time'
import { remoteLanePresentation } from '@/features/sessions/remoteLaneView'
import { hostLaneUrgency, laneTime } from './boardSections'

/**
 * What one dot on Host home's orbit says about its lane, most pressing first. The
 * first two are the board's urgency; the rest are the sidebar's indicator dots.
 */
export type OrbitTone = 'needs-you' | 'working' | 'unread' | 'live' | 'idle'

const TONE_RANK: Record<OrbitTone, number> = {
  'needs-you': 0,
  working: 1,
  unread: 2,
  live: 3,
  idle: 4,
}

/** Dots the ring holds before the oldest quiet lanes drop off it; Lanes lists every one. */
export const ORBIT_LIMIT = 48

export interface OrbitLane {
  lane: HostLaneView
  tone: OrbitTone
  updatedAt: number
}

export type OrbitCounts = Record<OrbitTone, number>

export interface Orbit {
  /** Clockwise from twelve o'clock: what needs you, what is working, then the rest by recency. */
  shown: OrbitLane[]
  counts: OrbitCounts
  total: number
}

export function orbitTone(lane: HostLaneView, ready: boolean): OrbitTone {
  const urgency = hostLaneUrgency(lane, ready)
  if (urgency !== 'idle') return urgency
  const { indicator } = remoteLanePresentation(lane, ready)
  return indicator === 'unseen' ? 'unread' : indicator === 'live' ? 'live' : 'idle'
}

export function hostOrbit(
  lanes: readonly HostLaneView[],
  ready: boolean,
  limit = ORBIT_LIMIT,
): Orbit {
  const counts: OrbitCounts = { 'needs-you': 0, working: 0, unread: 0, live: 0, idle: 0 }
  const all = lanes.map((lane) => {
    const tone = orbitTone(lane, ready)
    counts[tone] += 1
    return { lane, tone, updatedAt: laneTime(lane.updatedAt) }
  })
  all.sort((a, b) => TONE_RANK[a.tone] - TONE_RANK[b.tone] || b.updatedAt - a.updatedAt)
  return { shown: all.slice(0, limit), counts, total: lanes.length }
}

export interface OrbitSummary {
  /** The headline number; absent when there is nothing to count. */
  count?: number
  label: string
  /** Set when the headline asks something of you, so the label takes its colour. */
  tone?: OrbitTone
  detail: string
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

/** The dial's centre at rest: the one number worth reading first, and the rest in a line. */
export function orbitSummary(counts: OrbitCounts, total: number): OrbitSummary {
  if (!total) return { label: 'No lanes yet', detail: 'Describe a task below.' }
  const lanes = plural(total, 'lane')
  const needs = counts['needs-you']
  if (needs)
    return {
      count: needs,
      label: needs === 1 ? 'needs you' : 'need you',
      tone: 'needs-you',
      detail: [counts.working && `${counts.working} working`, lanes].filter(Boolean).join(' · '),
    }
  if (counts.working)
    return {
      count: counts.working,
      label: 'working',
      tone: 'working',
      detail: [counts.unread && `${counts.unread} unread`, lanes].filter(Boolean).join(' · '),
    }
  if (counts.unread) return { count: counts.unread, label: 'unread', tone: 'unread', detail: lanes }
  return { label: 'All quiet', detail: lanes }
}

/** One line for a lane in the dial's centre and its dot's name. */
export function orbitStateText({ lane, tone }: Pick<OrbitLane, 'lane' | 'tone'>): string {
  if (tone === 'needs-you') return lane.activity === 'failed' ? 'Failed · needs you' : 'Needs you'
  if (tone === 'working') return 'Working'
  const age = relativeTimeShort(Date.parse(lane.updatedAt))
  if (tone === 'unread') return `New activity · ${age}`
  return tone === 'live' ? `Live · ${age}` : age
}

/** The ring's radius as a share of the dial's width. */
export const ORBIT_RING = 0.4

/** Where dot `index` of `count` sits, in percent of the dial from its top-left corner. */
export function orbitPoint(index: number, count: number): { x: number; y: number } {
  const angle = (index / Math.max(count, 1)) * 2 * Math.PI - Math.PI / 2
  const round = (n: number) => Math.round(n * 1000) / 1000
  return {
    x: round(50 + ORBIT_RING * 100 * Math.cos(angle)),
    y: round(50 + ORBIT_RING * 100 * Math.sin(angle)),
  }
}

/** Roving focus around the ring: arrows step and wrap, Home and End jump to the ends. */
export function orbitStep(key: string, index: number, count: number): number | null {
  if (!count) return null
  if (key === 'ArrowRight' || key === 'ArrowDown') return (index + 1) % count
  if (key === 'ArrowLeft' || key === 'ArrowUp') return (index - 1 + count) % count
  if (key === 'Home') return 0
  if (key === 'End') return count - 1
  return null
}
