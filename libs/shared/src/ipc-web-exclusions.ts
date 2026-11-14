export const connectorConfig = {
  kind: 'unsupported',
  reason: 'Connector configuration and credentials belong to the Host or Desktop.',
} as const

const laneMove = {
  kind: 'unsupported',
  reason: 'Moving lanes needs Desktop, which carries the lane between machines.',
} as const

const fileDownload = {
  kind: 'unsupported',
  reason: 'Downloading a Host file needs Desktop, which saves it.',
} as const

const filePreview = {
  kind: 'unsupported',
  reason: 'Streaming a Host file into a viewer needs Desktop’s file scheme.',
} as const

/** Transfers Desktop carries: lanes between machines, Host files into Downloads or a viewer. */
export const DESKTOP_TRANSFERS_WEB = {
  'hosts:laneMovePlan': laneMove,
  'hosts:laneMove': laneMove,
  'hosts:fileDownload': fileDownload,
  'hosts:fileDownloadCancel': fileDownload,
  'hosts:filePreviewUrl': filePreview,
}

const localBrain = {
  kind: 'unsupported',
  reason: 'Brain is a local Desktop prototype; remote access is unavailable.',
} as const

/** Brain reads one machine's local database and runs its own lanes' models: Desktop only. */
export const BRAIN_WEB = {
  'brain:status': localBrain,
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
