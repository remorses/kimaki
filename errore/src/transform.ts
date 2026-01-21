/**
 * Transform the value if not an error.
 * If the value is an error, returns it unchanged.
 *
 * @example
 * const result = map(user, u => u.name)
 * // If user is User, result is string
 * // If user is NotFoundError, result is NotFoundError
 */
export function map<V, U>(value: V, fn: (v: Exclude<V, Error>) => U): Extract<V, Error> | U {
  if (value instanceof Error) {
    return value as Extract<V, Error>
  }
  return fn(value as Exclude<V, Error>)
}

/**
 * Transform the error if it is an error.
 * If the value is not an error, returns it unchanged.
 *
 * @example
 * const result = mapError(fetchResult, e => new AppError({ cause: e }))
 * // Converts any error type to AppError
 */
export function mapError<V, E2 extends Error>(
  value: V,
  fn: (e: Extract<V, Error>) => E2,
): E2 | Exclude<V, Error> {
  if (value instanceof Error) {
    return fn(value as Extract<V, Error>)
  }
  return value as Exclude<V, Error>
}

/**
 * Chain another errore-returning function.
 * If the value is an error, returns it unchanged.
 * If successful, runs fn and returns its result.
 *
 * @example
 * const result = andThen(userId, id => fetchUser(id))
 * // If userId is ValidationError, result is ValidationError
 * // If userId is string, result is whatever fetchUser returns
 */
export function andThen<V, R>(
  value: V,
  fn: (v: Exclude<V, Error>) => R,
): Extract<V, Error> | R {
  if (value instanceof Error) {
    return value as Extract<V, Error>
  }
  return fn(value as Exclude<V, Error>)
}

/**
 * Async version of andThen.
 *
 * @example
 * const result = await andThenAsync(userId, async id => {
 *   const user = await fetchUser(id)
 *   return user
 * })
 */
export async function andThenAsync<V, R>(
  value: V,
  fn: (v: Exclude<V, Error>) => Promise<R>,
): Promise<Extract<V, Error> | R> {
  if (value instanceof Error) {
    return value as Extract<V, Error>
  }
  return fn(value as Exclude<V, Error>)
}

/**
 * Run a side effect if the value is not an error.
 * Returns the original value unchanged.
 *
 * @example
 * const result = tap(user, u => console.log('Got user:', u.name))
 */
export function tap<V>(value: V, fn: (v: Exclude<V, Error>) => void): V {
  if (!(value instanceof Error)) {
    fn(value as Exclude<V, Error>)
  }
  return value
}

/**
 * Async version of tap.
 *
 * @example
 * const result = await tapAsync(user, async u => {
 *   await logToService(u)
 * })
 */
export async function tapAsync<V>(value: V, fn: (v: Exclude<V, Error>) => Promise<void>): Promise<V> {
  if (!(value instanceof Error)) {
    await fn(value as Exclude<V, Error>)
  }
  return value
}
