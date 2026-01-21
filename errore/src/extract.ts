/**
 * Extract the value or throw if it's an error.
 *
 * @example
 * const user = unwrap(result) // throws if result is an error
 * console.log(user.name)
 *
 * @example With custom message
 * const user = unwrap(result, 'Failed to get user')
 */
export function unwrap<V>(value: V, message?: string): Exclude<V, Error> {
  if (value instanceof Error) {
    throw new Error(message ?? `Unwrap called on error: ${value.message}`, { cause: value })
  }
  return value as Exclude<V, Error>
}

/**
 * Extract the value or return a fallback if it's an error.
 *
 * @example
 * const name = unwrapOr(result, 'Anonymous')
 * // If result is User, returns user
 * // If result is Error, returns 'Anonymous'
 */
export function unwrapOr<V, U>(value: V, fallback: U): Exclude<V, Error> | U {
  if (value instanceof Error) {
    return fallback
  }
  return value as Exclude<V, Error>
}

/**
 * Pattern match on an errore value.
 * Handles both success and error cases.
 *
 * @example
 * const message = match(result, {
 *   ok: user => `Hello, ${user.name}`,
 *   err: error => `Failed: ${error.message}`
 * })
 */
export function match<V, R>(
  value: V,
  handlers: {
    ok: (v: Exclude<V, Error>) => R
    err: (e: Extract<V, Error>) => R
  },
): R {
  if (value instanceof Error) {
    return handlers.err(value as Extract<V, Error>)
  }
  return handlers.ok(value as Exclude<V, Error>)
}

/**
 * Partition an array of errore values into [successes, errors].
 *
 * @example
 * const results = await Promise.all(ids.map(fetchUser))
 * const [users, errors] = partition(results)
 */
export function partition<V>(values: V[]): [Exclude<V, Error>[], Extract<V, Error>[]] {
  const oks: Exclude<V, Error>[] = []
  const errs: Extract<V, Error>[] = []
  for (const v of values) {
    if (v instanceof Error) {
      errs.push(v as Extract<V, Error>)
    } else {
      oks.push(v as Exclude<V, Error>)
    }
  }
  return [oks, errs]
}

/**
 * Flatten a nested errore: (E1 | (E2 | T)) becomes (E1 | E2 | T).
 * Useful when chaining operations that can fail.
 *
 * @example
 * const nested: NetworkError | (ParseError | User) = await fetchAndParse()
 * const flat: NetworkError | ParseError | User = flatten(nested)
 */
export function flatten<V>(value: V): V {
  return value
}
