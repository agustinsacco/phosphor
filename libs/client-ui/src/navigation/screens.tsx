import {
  ArtifactsIcon,
  MachinesIcon,
  SkillsIcon,
  ClockIcon,
  GearIcon,
  FileIcon,
  ChangesIcon,
  BranchIcon,
  TerminalIcon,
  SidebarToggleIcon,
  PlusIcon,
  WarningIcon,
} from '@/components/icons'
import { lazy, Suspense, type ComponentType } from 'react'
import type { GlobalPage } from '@/stores/layout'
import type { LanePane, Page } from './location'

const Machines = lazy(() =>
  import('@/features/machines/MachinesPage').then((m) => ({ default: m.MachinesPage })),
)
const Routines = lazy(() =>
  import('@/features/routines/RoutinesPage').then((m) => ({ default: m.RoutinesPage })),
)
const Skills = lazy(() =>
  import('@/features/skills/SkillsPage').then((m) => ({ default: m.SkillsPage })),
)
const Artifacts = lazy(() =>
  import('@/features/artifacts/ArtifactsPage').then((m) => ({ default: m.ArtifactsPage })),
)

interface Screen {
  title: string
  icon: ComponentType<{ size?: number; className?: string }>
  component?: ComponentType<{ workspacePath: string }>
  scope: 'remote' | 'both'
  expanded: 'page' | 'pane' | 'modal' | 'sidebar' | 'home'
  compact: 'page' | 'pane' | { notYet: string }
}
/** Every shared screen has a place in both shells, or an explicit platform gap. */
export const SCREENS = {
  lanes: {
    title: 'Lanes',
    icon: SidebarToggleIcon,
    scope: 'both',
    expanded: 'sidebar',
    compact: 'page',
  },
  inbox: { title: 'Inbox', icon: WarningIcon, scope: 'both', expanded: 'modal', compact: 'page' },
  new: { title: 'New', icon: PlusIcon, scope: 'both', expanded: 'home', compact: 'page' },
  machines: {
    icon: MachinesIcon,
    component: Machines,
    title: 'Machines',
    scope: 'both',
    expanded: 'page',
    compact: 'page',
  },
  routines: {
    icon: ClockIcon,
    component: Routines,
    title: 'Routines',
    scope: 'both',
    expanded: 'page',
    compact: 'page',
  },
  skills: {
    icon: SkillsIcon,
    component: Skills,
    title: 'Skills',
    scope: 'both',
    expanded: 'page',
    compact: 'page',
  },
  artifacts: {
    icon: ArtifactsIcon,
    component: Artifacts,
    title: 'Artifacts',
    scope: 'both',
    expanded: 'page',
    compact: 'page',
  },
  settings: {
    icon: GearIcon,
    title: 'Settings',
    scope: 'both',
    expanded: 'modal',
    compact: 'page',
  },
  chat: {
    icon: SidebarToggleIcon,
    title: 'Chat',
    scope: 'both',
    expanded: 'pane',
    compact: 'pane',
  },
  files: { icon: FileIcon, title: 'Files', scope: 'both', expanded: 'pane', compact: 'pane' },
  changes: {
    icon: ChangesIcon,
    title: 'Changes',
    scope: 'both',
    expanded: 'pane',
    compact: 'pane',
  },
  subagents: {
    icon: BranchIcon,
    title: 'Subagents',
    scope: 'both',
    expanded: 'pane',
    compact: { notYet: 'Subagent inspection is not available on remote lanes yet.' },
  },
  terminal: {
    icon: TerminalIcon,
    title: 'Terminal',
    scope: 'both',
    expanded: 'pane',
    compact: { notYet: 'Terminals are available in Desktop.' },
  },
} satisfies Record<Page | LanePane | 'lanes' | 'new' | 'inbox', Screen>

export function GlobalScreen({
  page,
  workspacePath,
}: {
  page: GlobalPage
  workspacePath: string
}): React.JSX.Element {
  const Component = SCREENS[page].component
  return (
    <Suspense
      fallback={
        <p role="status" className="p-4">
          Loading {SCREENS[page].title}…
        </p>
      }
    >
      <Component workspacePath={workspacePath} />
    </Suspense>
  )
}
