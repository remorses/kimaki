// Types
export type { Errore, InferError, InferValue, EnsureNotError } from './types'

// Core functions
export { isError, isOk, tryFn, tryAsync } from './core'

// Transformations
export { map, mapError, andThen, andThenAsync, tap, tapAsync } from './transform'

// Extraction
export { unwrap, unwrapOr, match, partition, flatten } from './extract'

// Tagged errors
export { TaggedError, matchError, matchErrorPartial, isTaggedError, UnhandledError } from './error'
export type { TaggedErrorInstance, TaggedErrorClass } from './error'
