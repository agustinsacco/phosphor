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
  'brain:tidy': localBrain,
  'brain:tidyApply': localBrain,
  'brain:tidyCancel': localBrain,
  'brain:tidyChanges': localBrain,
  'brain:tidyDismiss': localBrain,
  'brain:tidyRun': localBrain,
  'brain:tidySuggestion': localBrain,
  'brain:tidyUndo': localBrain,
  'brain:entities': localBrain,
  'brain:recent': localBrain,
  'brain:status': localBrain,
  'brain:history': localBrain,
  'brain:reread': localBrain,
  'brain:neverRead': localBrain,
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
}

const localRuntime = {
  kind: 'unsupported',
  reason: "This Mac's runtime and its move to the Phosphor service belong to Desktop.",
} as const

/** This Mac's runtime card belongs to Desktop. */
export const LOCAL_MACHINE_WEB = {
  'app:localMachine': localRuntime,
  'app:localMachineAction': localRuntime,
} as const
