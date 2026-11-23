import { folders } from './folders'
import { laneControls } from './lane-controls'
import { lanes } from './lanes'
import { machineOps } from './machine'
import { metaOps } from './meta'
import { neverOps } from './reserved'
import { resources } from './resources'
import { routines } from './routines'
import { settingsOps } from './settings'
import type { CatalogSpec } from './spec'
import { workspace } from './workspace'

/** In help order; each schema is a closed TypeBox object. */
export const OP_CATALOG: readonly CatalogSpec[] = Object.freeze([
  ...metaOps,
  ...laneControls,
  ...lanes,
  ...workspace,
  ...folders,
  ...routines,
  ...resources,
  ...settingsOps,
  ...machineOps,
  ...neverOps,
])
