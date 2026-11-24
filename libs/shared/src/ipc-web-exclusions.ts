export const connectorConfig = {
  kind: 'unsupported',
  reason: 'Connector configuration and credentials belong to the Host or Desktop.',
} as const

const localBrain = {
  kind: 'unsupported',
  reason: 'Brain is a local Desktop prototype; remote access is unavailable.',
} as const

/** Brain reads one machine's local database and runs its own lanes' models: Desktop only. */
export const BRAIN_WEB = {
  'brain:tidyChanges': localBrain,
  'brain:tidyUndo': localBrain,
  'brain:defrag': localBrain,
  'brain:defragStop': localBrain,
  'brain:undoRun': localBrain,
  'brain:entities': localBrain,
  'brain:status': localBrain,
  'brain:reread': localBrain,
  'brain:neverRead': localBrain,
  'brain:setPrefs': localBrain,
  'brain:download': localBrain,
  'brain:removeModel': localBrain,
  'brain:queue': localBrain,
  'brain:cancel': localBrain,
  'brain:extraction': localBrain,
  'brain:retry': localBrain,
  'brain:reset': localBrain,
  'brain:merge': localBrain,
  'brain:describe': localBrain,
  'brain:removeName': localBrain,
  'brain:split': localBrain,
  'brain:find': localBrain,
  'brain:overview': localBrain,
  'brain:neighbourhood': localBrain,
  'brain:entity': localBrain,
  'brain:connections': localBrain,
  'brain:entityMemories': localBrain,
  'brain:path': localBrain,
  'brain:memory': localBrain,
  'brain:forget': localBrain,
  'brain:ask': localBrain,
  'brain:tell': localBrain,
  'brain:laneRead': localBrain,
  'brain:setOwner': localBrain,
}
