/** Catalog-aware CLI grammar; deliberately outside the wire parser graph. */
export { helpArgv, optionsEnd, resolveOp, unknownOperation } from './ops/aliases'
export { validateOpArgs } from './ops/constraints'
export { opCommand, renderHelp } from './ops/help'
export { parseOpArgv, type OpArgvResult } from './ops/parse'
