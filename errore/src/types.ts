/**
 * The core type: either an Error or a value T.
 * Unlike Result<T, E>, this is just a union - no wrapper needed.
 */
export type Errore<T, E extends Error = Error> = E | T

/**
 * Extract the error type from an Errore union.
 * @example InferError<NetworkError | User> // NetworkError
 */
export type InferError<T> = T extends Error ? T : never

/**
 * Extract the value type from an Errore union.
 * @example InferValue<NetworkError | User> // User
 */
export type InferValue<T> = T extends Error ? never : T

/**
 * Utility to ensure T is not an Error type.
 * Used to prevent ambiguous unions like Error | Error.
 */
export type EnsureNotError<T> = T extends Error
  ? 'Error: Value type T cannot extend Error - this would make the union ambiguous'
  : T
