import { realpathSync } from 'node:fs'
import { folderTaskObstacle as obstacle } from '@phosphor/session-runtime/routines/preflight'
import type { RoutineInput } from '@shared/routines'
import { registry } from '../registry'

export const occupiedRoutineFolder = (path: string) =>
  registry.list().some((s) => realpathSync.native(s.workspacePath) === path)

export const folderTaskObstacle = (path: string, intent: RoutineInput['intent']) =>
  obstacle(path, intent, occupiedRoutineFolder)
