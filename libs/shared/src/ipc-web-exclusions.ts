export const connectorConfig = {
  kind: 'unsupported',
  reason: 'Connector configuration and credentials belong to the Host or Desktop.',
} as const

const laneMove = {
  kind: 'unsupported',
  reason: 'Moving lanes needs Desktop, which carries the lane between machines.',
} as const

/** Moving a lane between machines, which Desktop carries. */
export const DESKTOP_TRANSFERS_WEB = {
  'hosts:laneMovePlan': laneMove,
  'hosts:laneMove': laneMove,
}

const localBrain = {
  kind: 'unsupported',
  reason: 'Brain is a local Desktop prototype; remote access is unavailable.',
} as const

/** Brain reads one machine's local database and runs its own lanes' models: Desktop only. */
export const BRAIN_WEB = {
  'brain:status': localBrain,
  'brain:history': localBrain,
  'brain:reread': localBrain,
  'brain:setPrefs': localBrain,
  'brain:download': localBrain,
  'brain:removeModel': localBrain,
  'brain:queue': localBrain,
  'brain:cancel': localBrain,
  'brain:extraction': localBrain,
  'brain:proposal': localBrain,
  'brain:review': localBrain,
  'brain:retry': localBrain,
  'brain:reset': localBrain,
  'brain:merge': localBrain,
  'brain:find': localBrain,
  'brain:overview': localBrain,
  'brain:neighbourhood': localBrain,
  'brain:entity': localBrain,
  'brain:connections': localBrain,
  'brain:entityMemories': localBrain,
  'brain:path': localBrain,
  'brain:memory': localBrain,
  'brain:forget': localBrain,
}
