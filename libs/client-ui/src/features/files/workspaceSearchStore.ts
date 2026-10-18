import { create } from 'zustand'
import { keyedSlice } from '@/stores/keyedSlice'
import { ipcErrorText } from '@shared/errors'
import { DEFAULT_SEARCH_OPTIONS, escapeRegExp, type SearchOptions } from '@shared/text-search'
import {
  compileSearch,
  EMPTY_SEARCH_RESULT,
  type WorkspaceSearchResult,
} from '@shared/workspace-search'

/**
 * The Files pane's workspace search, per workspace: what the panel asks for
 * and the last answer main gave (`fs:searchWorkspace`).
 *
 * Kept here rather than in the panel so it outlives the panel: closing the
 * search to look at the tree, or the Files pane itself, and coming back finds
 * the same query and results.
 */
interface SearchSlice {
  /** The Files pane shows the search in place of the explorer tree. */
  open: boolean
  query: string
  options: SearchOptions
  /** Comma-separated globs (`shared/glob.ts`). */
  include: string
  exclude: string
  /** The include / exclude fields are showing. */
  showScope: boolean
  /** The latest search's answer; null before one runs or once the query is cleared. */
  result: WorkspaceSearchResult | null
  searching: boolean
  /** Workspace-relative paths whose matches are folded away. */
  collapsed: Record<string, true>
  /** Changes on every `openSearch`, so the panel re-focuses its field. */
  focusRequest: number
  /** Changes on every `closeSearch`, so the pane hands focus back to the explorer. */
  explorerFocusRequest: number
}

type SearchInputs = Pick<SearchSlice, 'query' | 'options' | 'include' | 'exclude'>

const searches = keyedSlice<SearchSlice>({
  open: false,
  query: '',
  options: DEFAULT_SEARCH_OPTIONS,
  include: '',
  exclude: '',
  showScope: false,
  result: null,
  searching: false,
  collapsed: {},
  focusRequest: 0,
  explorerFocusRequest: 0,
})

/**
 * Where focus requests come from, shared by every workspace so a request is
 * never mistaken for one already honoured, even for a workspace whose search
 * was dropped and started over.
 */
let focusSeq = 0

/** Typing settles for this long before a search starts; each keystroke would cancel the last. */
export const SEARCH_DEBOUNCE_MS = 250

interface WorkspaceSearchState {
  byWorkspace: Record<string, SearchSlice>
  /**
   * Show (or re-focus) the search. A `seed` (the selected text) replaces the
   * query, escaped when regex is on so it still finds itself.
   */
  openSearch: (workspacePath: string, seed?: string) => void
  /** Go back to the explorer tree, which takes focus. */
  closeSearch: (workspacePath: string) => void
  /** Change what is searched for; a new search follows once typing settles. */
  setInputs: (workspacePath: string, inputs: Partial<SearchInputs>) => void
  toggleOption: (workspacePath: string, key: keyof SearchOptions) => void
  setShowScope: (workspacePath: string, show: boolean) => void
  toggleCollapsed: (workspacePath: string, path: string) => void
  /** Fold every file (true) or none (false). */
  collapseAll: (workspacePath: string, collapse: boolean) => void
  /** Search now with the current inputs; also what the refresh button does. */
  run: (workspacePath: string) => Promise<void>
}

/** A workspace's search; the shared frozen empty value when it has none yet. */
export function workspaceSearch(state: WorkspaceSearchState, workspacePath: string): SearchSlice {
  return searches.read(state.byWorkspace, workspacePath)
}

/**
 * Why the inputs cannot be searched as they stand, or null. Checked here as
 * well as in main so a half-typed regex says so at once, without a round trip.
 */
export function inputError(inputs: SearchInputs): string | null {
  const compiled = compileSearch({
    query: { text: inputs.query, ...inputs.options },
    include: inputs.include,
    exclude: inputs.exclude,
  })
  return compiled.status === 'invalid' ? compiled.error : null
}

/** The search in flight per workspace, by id: only its answer is kept. */
const inFlight = new Map<string, string>()
const timers = new Map<string, ReturnType<typeof setTimeout>>()

function cancelPending(workspacePath: string): void {
  const timer = timers.get(workspacePath)
  if (timer !== undefined) clearTimeout(timer)
  timers.delete(workspacePath)
  const searchId = inFlight.get(workspacePath)
  inFlight.delete(workspacePath)
  if (searchId) void window.phosphor.invoke('fs:cancelWorkspaceSearch', searchId).catch(() => {})
}

export const useWorkspaceSearchStore = create<WorkspaceSearchState>((set, get) => {
  const patch = (workspacePath: string, fields: Partial<SearchSlice>): void =>
    set((s) => ({
      byWorkspace: searches.patch(s.byWorkspace, workspacePath, (w) => ({ ...w, ...fields })),
    }))

  const schedule = (workspacePath: string): void => {
    const timer = timers.get(workspacePath)
    if (timer !== undefined) clearTimeout(timer)
    timers.set(
      workspacePath,
      setTimeout(() => {
        timers.delete(workspacePath)
        void get().run(workspacePath)
      }, SEARCH_DEBOUNCE_MS),
    )
  }

  return {
    byWorkspace: {},

    openSearch: (workspacePath, seed) => {
      const current = workspaceSearch(get(), workspacePath)
      const query =
        seed === undefined ? undefined : current.options.regex ? escapeRegExp(seed) : seed
      const reseed = query !== undefined && query !== current.query
      patch(workspacePath, {
        open: true,
        focusRequest: ++focusSeq,
        ...(reseed ? { query } : {}),
      })
      if (reseed) void get().run(workspacePath)
    },

    closeSearch: (workspacePath) =>
      patch(workspacePath, { open: false, explorerFocusRequest: ++focusSeq }),

    setInputs: (workspacePath, inputs) => {
      patch(workspacePath, inputs)
      schedule(workspacePath)
    },

    toggleOption: (workspacePath, key) => {
      const { options } = workspaceSearch(get(), workspacePath)
      patch(workspacePath, { options: { ...options, [key]: !options[key] } })
      // A toggle is one deliberate change, not typing: no reason to wait.
      void get().run(workspacePath)
    },

    setShowScope: (workspacePath, show) => {
      const current = workspaceSearch(get(), workspacePath)
      patch(workspacePath, { showScope: show })
      // Hidden globs still filtering would leave results no one can explain.
      if (!show && (current.include || current.exclude)) {
        get().setInputs(workspacePath, { include: '', exclude: '' })
      }
    },

    toggleCollapsed: (workspacePath, path) => {
      const { collapsed } = workspaceSearch(get(), workspacePath)
      const next = { ...collapsed }
      if (next[path]) delete next[path]
      else next[path] = true
      patch(workspacePath, { collapsed: next })
    },

    collapseAll: (workspacePath, collapse) => {
      const { result } = workspaceSearch(get(), workspacePath)
      const collapsed: Record<string, true> = {}
      if (collapse) for (const file of result?.files ?? []) collapsed[file.path] = true
      patch(workspacePath, { collapsed })
    },

    run: async (workspacePath) => {
      cancelPending(workspacePath)
      const search = workspaceSearch(get(), workspacePath)
      const { query, options, include, exclude } = search
      if (query === '' || inputError(search)) {
        // Nothing to ask main; the panel explains an invalid input itself.
        patch(workspacePath, { result: null, searching: false, collapsed: {} })
        return
      }
      const searchId = crypto.randomUUID()
      inFlight.set(workspacePath, searchId)
      patch(workspacePath, { searching: true })
      let result: WorkspaceSearchResult
      try {
        result = await window.phosphor.invoke('fs:searchWorkspace', {
          searchId,
          workspacePath,
          query: { text: query, ...options },
          include: include || undefined,
          exclude: exclude || undefined,
        })
      } catch (error) {
        result = { ...EMPTY_SEARCH_RESULT, error: ipcErrorText(error) }
      }
      // A newer search, or a cleared query, replaced this one while it ran.
      if (inFlight.get(workspacePath) !== searchId) return
      inFlight.delete(workspacePath)
      patch(workspacePath, { result, searching: false, collapsed: {} })
    },
  }
})
