// Types
export type { Errore, InferError, InferValue, EnsureNotError } from './types.js'

// Core functions
export { isError, isOk, tryFn, tryAsync } from './core.js'

// Transformations
export { map, mapError, andThen, andThenAsync, tap, tapAsync } from './transform.js'

// Extraction
export { unwrap, unwrapOr, match, partition, flatten } from './extract.js'

// Tagged errors
export { TaggedError, matchError, matchErrorPartial, isTaggedError, UnhandledError } from './error.js'
export type { TaggedErrorInstance, TaggedErrorClass } from './error.js'
