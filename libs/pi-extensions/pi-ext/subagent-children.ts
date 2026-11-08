/**
 * Sub-agents run with their session's guards, context rules and budget.
 *
 * pi-subagents children load none of the `-e` extensions their parent got,
 * and foreground ones run inside the parent's pi process. In a worktree lane
 * a child therefore sent the main checkout's CLAUDE.md/AGENTS.md on every
 * request, could read the other branch's files, kept malformed tool names,
 * and grew past the session's context budget (one worker reached 484k).
 *
 * pi-subagents' host API (`registerRequiredChildExtensions`) makes every
 * child of a session load named extensions: foreground, detached, nested or
 * resumed. The parent half registers this file for each session; its default
 * export is the child set. Not the UI surfaces, Swarm or lane reload: a child
 * has no host to drive them, and Swarm authority must not pass down.
 */
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import contextBudget, { type BudgetApi } from './context-budget'
import contextFiles from './context-files'
import toolNameGuard from './tool-name-guard'
import worktreePaths from './worktree-paths'

interface Registration {
  dispose(): void
}
export type RegisterChildren = (input: {
  sessionId: string
  extensions: { id: string; path: string }[]
}) => Registration

interface ParentApi {
  on(event: string, handler: (event: unknown, ctx: unknown) => unknown): void
  getAllTools?(): unknown
}

/** The id pi-subagents shows in launch evidence. */
export const SUBAGENT_EXTENSION_ID = 'phosphor-subagent'

/** pi-subagents' registration, resolved from the package that registered its tools. */
export async function findRegister(pi: ParentApi): Promise<RegisterChildren | undefined> {
  const tools = pi.getAllTools?.()
  const tool = Array.isArray(tools)
    ? (tools as { name?: string; sourceInfo?: { path?: unknown } }[]).find(
        (t) => t?.name === 'subagent' || t?.name === 'subagents_enable',
      )
    : undefined
  const source = tool?.sourceInfo?.path
  if (typeof source !== 'string') return undefined
  try {
    const api = createRequire(source).resolve('pi-subagents/required-child-extensions')
    const mod = (await import(pathToFileURL(api).href)) as {
      registerRequiredChildExtensions?: RegisterChildren
    }
    return mod.registerRequiredChildExtensions
  } catch {
    return undefined // a pi-subagents from before the host API
  }
}

/** This file, for the children to load; unknown when bundled to CommonJS. */
function ownPath(): string | undefined {
  try {
    return fileURLToPath(import.meta.url)
  } catch {
    return undefined
  }
}

/** Parent half: register the child set for each session this pi process runs. */
export function registerSubagentChildren(
  pi: ParentApi,
  find: (pi: ParentApi) => Promise<RegisterChildren | undefined> = findRegister,
  self: string | undefined = ownPath(),
): void {
  let registration: Registration | undefined
  const release = (): void => {
    registration?.dispose()
    registration = undefined
  }
  pi.on('session_start', async (_event, ctx) => {
    release()
    const manager = (ctx as { sessionManager?: { getSessionId?(): string } } | undefined)
      ?.sessionManager
    const sessionId = manager?.getSessionId?.()
    const register = sessionId && self ? await find(pi) : undefined
    if (!register || !sessionId || !self) return
    try {
      registration = register({
        sessionId,
        extensions: [{ id: SUBAGENT_EXTENSION_ID, path: self }],
      })
    } catch (error) {
      console.error(`[Phosphor] sub-agents run without Phosphor's extensions: ${String(error)}`)
    }
  })
  pi.on('session_shutdown', release)
}

/** Child half: everything Phosphor runs in a session that needs no host. */
export default function subagentChild(pi: BudgetApi): void {
  worktreePaths(pi)
  toolNameGuard(pi)
  contextFiles(pi)
  contextBudget(pi)
}
