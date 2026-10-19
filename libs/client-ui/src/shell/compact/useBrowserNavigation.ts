import { useMachinesStore } from '@/stores/machines'
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { createHistoryNavigation } from '@/navigation/history'
import { useLayoutStore } from '@/stores/layout'
import { useSessionsStore } from '@/stores/sessions'
import { useRemoteLanesStore } from '@/stores/remoteLanes'
import { useMachinePagesStore } from '@/stores/machinePages'
import { locationMachine, type Location } from '@/navigation/location'
import { useDefaultNewMachine } from './useDefaultNewMachine'

export function useBrowserNavigation() {
  const [history] = useState(() => createHistoryNavigation(window))
  const applying = useRef(false)
  const location = useSyncExternalStore(history.subscribe, history.getSnapshot)
  const remoteEnabled = useMachinesStore((s) => s.remoteEnabled)
  const filter = useRemoteLanesStore((s) => s.filter)
  const page = useLayoutStore((s) => s.page)
  useDefaultNewMachine(history, location, remoteEnabled)
  const expectedFilter = locationMachine(location) ?? 'all'
  const expectedPage = location.to === 'page' && location.page !== 'settings' ? location.page : null
  const pending = !remoteEnabled || filter !== expectedFilter || page !== expectedPage
  const navigate = useCallback(
    (next: Location) => {
      history.navigate(next)
    },
    [history],
  )
  useEffect(() => {
    if (!remoteEnabled) return
    const machine = locationMachine(location)
    applying.current = true
    if (location.to !== 'lane') {
      // Native activate(null) persists app:setLastSession; browser home has no local resume target.
      useSessionsStore.getState().claimNav()
      useSessionsStore.setState({ activeSessionId: null, opening: null })
    }
    useRemoteLanesStore.getState().setFilter(machine ?? 'all')
    useMachinePagesStore.setState({
      skillsMachine: null,
      routinesMachine: '',
      artifactsMachine: '',
    })
    const page = location.to === 'page' && location.page !== 'settings' ? location.page : null
    useLayoutStore.getState().setPage(page)
    if (location.to === 'page' && location.page === 'machines')
      useMachinesStore.setState({
        view: location.machine ? { kind: 'machine', id: location.machine } : { kind: 'list' },
      })
    applying.current = false
  }, [location, remoteEnabled])
  // Legacy feature actions still use the native store setters. Project those into
  // URLs rather than duplicating the features or changing native persistence.
  useEffect(() => {
    let listening = true
    const offSessions = useSessionsStore.subscribe((state, previous) => {
      if (applying.current) return
      if (state.activeSessionId === previous.activeSessionId || !state.activeSessionId) return
      const entry = state.live[state.activeSessionId]
      if (entry?.target?.kind !== 'remote' || !entry.laneId) return
      const current = history.getSnapshot()
      if (
        current.to === 'lane' &&
        'hostId' in current.lane &&
        current.lane.hostId === entry.target.hostId &&
        current.lane.laneId === entry.laneId
      )
        return
      history.navigate({
        to: 'lane',
        lane: { hostId: entry.target.hostId, laneId: entry.laneId },
        pane: 'chat',
      })
    })
    const offLayout = useLayoutStore.subscribe((state, previous) => {
      if (applying.current) return
      if (state.page === previous.page) {
        const session = useSessionsStore.getState().activeSessionId
        const pane = session ? state.bySession[session]?.pane : undefined
        const prior = session ? previous.bySession[session]?.pane : undefined
        const current = history.getSnapshot()
        if (pane !== prior && current.to === 'lane')
          history.navigate({ ...current, pane: pane ?? 'chat' })
        return
      }
      const current = history.getSnapshot()
      if (state.page && (current.to !== 'page' || current.page !== state.page)) {
        const choices = useMachinePagesStore.getState()
        const selected =
          state.page === 'skills'
            ? choices.skillsMachine
            : state.page === 'routines'
              ? choices.routinesMachine
              : choices.artifactsMachine
        const filter = useRemoteLanesStore.getState().filter
        const machine =
          selected?.replace(/^host:/, '') ||
          (filter !== 'all' && filter !== 'local' ? filter : undefined)
        history.navigate({ to: 'page', page: state.page, ...(machine ? { machine } : {}) })
      } else if (!state.page && current.to === 'page' && current.page !== 'settings') {
        // activate() closes the page before publishing the active lane in the same tick.
        // Let that lane own the URL rather than adding an intermediate Home history entry.
        queueMicrotask(() => {
          if (
            listening &&
            history.getSnapshot() === current &&
            useLayoutStore.getState().page === null
          )
            history.navigate({ to: 'lanes' })
        })
      }
    })
    const offDirectory = useMachinesStore.subscribe((state, previous) => {
      const current = history.getSnapshot()
      if (
        applying.current ||
        state.view === previous.view ||
        current.to !== 'page' ||
        current.page !== 'machines'
      )
        return
      history.navigate({
        to: 'page',
        page: 'machines',
        ...(state.view.kind === 'machine' ? { machine: state.view.id } : {}),
      })
    })
    const offMachines = useMachinePagesStore.subscribe((state, previous) => {
      if (applying.current) return
      const current = history.getSnapshot()
      if (current.to !== 'page') return
      const field =
        current.page === 'skills'
          ? 'skillsMachine'
          : current.page === 'routines'
            ? 'routinesMachine'
            : current.page === 'artifacts'
              ? 'artifactsMachine'
              : null
      if (!field || state[field] === previous[field]) return
      const selection = state[field]?.replace(/^host:/, '')
      if (selection === 'local') return
      history.navigate({
        ...current,
        machine: !selection || selection === 'all' ? undefined : selection,
      })
    })
    return () => {
      listening = false
      offDirectory()
      offMachines()
      offSessions()
      offLayout()
    }
  }, [history])
  return { location, navigate, pending }
}
