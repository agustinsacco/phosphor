/**
 * The op catalog's public entry, `@phosphor/shared/ops-catalog`. Kept apart from
 * `@phosphor/shared/ops` because the catalog's argument schemas use typebox, and
 * the contract parser graph must stay free of package imports.
 */
export { OP_CATALOG, OP_GAPS } from './ops/index'
export type { CatalogSpec } from './ops/domains/spec'
