import { describe, test, expect } from 'vitest'
import {
  isError,
  isOk,
  tryFn,
  tryAsync,
  map,
  mapError,
  andThen,
  unwrap,
  unwrapOr,
  match,
  partition,
  TaggedError,
  matchError,
  UnhandledError,
} from './index'

// ============================================================================
// Tagged Error Definitions
// ============================================================================

class NotFoundError extends TaggedError('NotFoundError')<{
  id: string
  message: string
}>() {
  constructor(args: { id: string }) {
    super({ ...args, message: `Not found: ${args.id}` })
  }
}

class ValidationError extends TaggedError('ValidationError')<{
  field: string
  message: string
}>() {}

class NetworkError extends TaggedError('NetworkError')<{
  url: string
  message: string
}>() {}

type User = { id: string; name: string }

// Helper functions that return union types (realistic pattern)
function getUser(found: boolean): NotFoundError | User {
  if (!found) return new NotFoundError({ id: '123' })
  return { id: '1', name: 'Alice' }
}

function parseNumber(s: string): ValidationError | number {
  const n = parseInt(s, 10)
  if (isNaN(n)) return new ValidationError({ field: 'input', message: 'Not a number' })
  return n
}

// ============================================================================
// Type Guards
// ============================================================================

describe('isError / isOk', () => {
  test('isError returns true for errors', () => {
    const result = getUser(false)
    expect(isError(result)).toBe(true)
  })

  test('isOk narrows to value type', () => {
    const result = getUser(true)

    if (isOk(result)) {
      // TypeScript knows: result is User
      expect(result.name).toBe('Alice')
    }
  })

  test('early return pattern (like Go)', () => {
    const user = getUser(true)
    if (isError(user)) return

    // TypeScript knows: user is User
    expect(user.name).toBe('Alice')
  })

  test('isError narrows to error type for matchError', () => {
    const result = getUser(false)

    if (isError(result)) {
      // TypeScript knows: result is NotFoundError
      expect(result.id).toBe('123')
    }
  })
})

// ============================================================================
// tryFn / tryAsync
// ============================================================================

describe('tryFn', () => {
  test('returns value on success', () => {
    const result = tryFn(() => JSON.parse('{"a":1}'))

    if (isOk(result)) {
      expect(result.a).toBe(1)
    }
  })

  test('returns UnhandledError on exception', () => {
    const result = tryFn(() => JSON.parse('invalid'))

    expect(isError(result)).toBe(true)
    if (isError(result)) {
      expect(result).toBeInstanceOf(UnhandledError)
    }
  })

  test('custom catch returns typed error', () => {
    const result = tryFn({
      try: () => JSON.parse('invalid'),
      catch: () => new ValidationError({ field: 'json', message: 'Invalid JSON' }),
    })

    if (isError(result)) {
      // TypeScript knows: result is ValidationError
      expect(result.field).toBe('json')
    }
  })
})

describe('tryAsync', () => {
  test('returns value on success', async () => {
    const result = await tryAsync(() => Promise.resolve(42))

    if (isOk(result)) {
      expect(result).toBe(42)
    }
  })

  test('returns error on rejection', async () => {
    const result = await tryAsync(() => Promise.reject(new Error('fail')))

    expect(isError(result)).toBe(true)
  })

  test('custom catch with async function', async () => {
    const result = await tryAsync({
      try: () => Promise.reject(new Error('network')),
      catch: () => new NetworkError({ url: '/api', message: 'Failed' }),
    })

    if (isError(result)) {
      // TypeScript knows: result is NetworkError
      expect(result.url).toBe('/api')
    }
  })
})

// ============================================================================
// Transformations
// ============================================================================

describe('map', () => {
  test('transforms value when ok', () => {
    const user = getUser(true)
    const result = map(user, (u) => u.name.toUpperCase())

    expect(result).toBe('ALICE')
  })

  test('passes through error unchanged', () => {
    const user = getUser(false)
    const result = map(user, (u) => u.name.toUpperCase())

    expect(isError(result)).toBe(true)
  })
})

describe('mapError', () => {
  test('transforms error type', () => {
    const result = getUser(false)
    const mapped = mapError(result, (e) => new NetworkError({ url: '/api', message: e.message }))

    if (isError(mapped)) {
      // TypeScript knows: mapped is NetworkError
      expect(mapped.url).toBe('/api')
    }
  })
})

describe('andThen', () => {
  test('chains errore-returning functions', () => {
    const result = andThen(parseNumber('21'), (n) => n * 2)

    expect(result).toBe(42)
  })

  test('short-circuits on error', () => {
    const result = andThen(parseNumber('bad'), (n) => n * 2)

    expect(isError(result)).toBe(true)
  })

  test('chains multiple errore functions', () => {
    function divide(a: number, b: number): ValidationError | number {
      if (b === 0) return new ValidationError({ field: 'divisor', message: 'Cannot divide by zero' })
      return a / b
    }

    const result = andThen(parseNumber('20'), (n) => divide(n, 4))

    expect(result).toBe(5)
  })
})

// ============================================================================
// Extraction
// ============================================================================

describe('unwrap', () => {
  test('returns value when ok', () => {
    const result = parseNumber('42')

    expect(unwrap(result)).toBe(42)
  })

  test('throws when error', () => {
    const result = parseNumber('bad')

    expect(() => unwrap(result)).toThrow()
  })
})

describe('unwrapOr', () => {
  test('returns value when ok', () => {
    const result = parseNumber('42')

    expect(unwrapOr(result, 0)).toBe(42)
  })

  test('returns fallback when error', () => {
    const result = parseNumber('bad')

    expect(unwrapOr(result, 0)).toBe(0)
  })
})

describe('match', () => {
  test('calls ok handler for value', () => {
    const user = getUser(true)

    const message = match(user, {
      ok: (u) => `Hello, ${u.name}`,
      err: (e) => `Error: ${e.message}`,
    })

    expect(message).toBe('Hello, Alice')
  })

  test('calls err handler for error', () => {
    const user = getUser(false)

    const message = match(user, {
      ok: (u) => `Hello, ${u.name}`,
      err: (e) => `Error: ${e.id}`,
    })

    expect(message).toBe('Error: 123')
  })
})

describe('partition', () => {
  test('splits array into values and errors', () => {
    const results = [
      parseNumber('1'),
      parseNumber('bad'),
      parseNumber('2'),
      parseNumber('nope'),
      parseNumber('3'),
    ]

    const [values, errors] = partition(results)

    expect(values).toEqual([1, 2, 3])
    expect(errors).toHaveLength(2)
  })
})

// ============================================================================
// Tagged Errors
// ============================================================================

describe('TaggedError', () => {
  test('has _tag property', () => {
    const err = new NotFoundError({ id: '123' })

    expect(err._tag).toBe('NotFoundError')
  })

  test('static is() type guard', () => {
    const err: Error = new NotFoundError({ id: '123' })

    expect(NotFoundError.is(err)).toBe(true)
    expect(ValidationError.is(err)).toBe(false)
  })

  test('TaggedError.is() for any tagged error', () => {
    const err = new NotFoundError({ id: '123' })

    expect(TaggedError.is(err)).toBe(true)
    expect(TaggedError.is(new Error('plain'))).toBe(false)
  })
})

describe('matchError', () => {
  test('exhaustive pattern matching by _tag', () => {
    function fetchData(): NotFoundError | ValidationError | string {
      return new NotFoundError({ id: '123' })
    }

    const result = fetchData()

    if (isError(result)) {
      const message = matchError(result, {
        NotFoundError: (e) => `Missing: ${e.id}`,
        ValidationError: (e) => `Invalid: ${e.field}`,
      })
      expect(message).toBe('Missing: 123')
    }
  })
})

// ============================================================================
// Real-world Example
// ============================================================================

describe('real-world: fetch user flow', () => {
  async function fetchUser(id: string): Promise<NotFoundError | NetworkError | User> {
    if (id === 'network-fail') {
      return new NetworkError({ url: '/users', message: 'Connection failed' })
    }
    if (id === 'not-found') {
      return new NotFoundError({ id })
    }
    return { id, name: 'Alice' }
  }

  test('success case', async () => {
    const user = await fetchUser('123')

    if (isError(user)) return

    // TypeScript knows: user is User
    expect(user.name).toBe('Alice')
  })

  test('error handling with matchError', async () => {
    const user = await fetchUser('not-found')

    if (isError(user)) {
      const message = matchError(user, {
        NotFoundError: (e) => `User ${e.id} not found`,
        NetworkError: (e) => `Network error: ${e.message}`,
      })
      expect(message).toBe('User not-found not found')
    }
  })

  test('error handling with match', async () => {
    const user = await fetchUser('network-fail')

    const message = match(user, {
      ok: (u) => `Got user: ${u.name}`,
      err: (e) => `Failed: ${e.message}`,
    })

    expect(message).toBe('Failed: Connection failed')
  })
})

// ============================================================================
// Error | T | null/undefined - Result + Option combined naturally
// ============================================================================

describe('Error | T | null (Result + Option combined)', () => {
  // This pattern combines Result and Option without nesting!
  // In Rust you'd need Result<Option<T>, E> or Option<Result<T, E>>
  // Here it's just: Error | T | null

  function findUser(id: string): NotFoundError | User | null {
    if (id === 'error') return new NotFoundError({ id })
    if (id === 'missing') return null
    return { id, name: 'Alice' }
  }

  test('success case - returns value', () => {
    const user = findUser('123')

    if (isError(user)) return
    if (user === null) return

    // TypeScript knows: user is User
    expect(user.name).toBe('Alice')
  })

  test('null case - using ?? operator', () => {
    const user = findUser('missing')

    if (isError(user)) return

    // Can use ?? naturally with null
    const name = user?.name ?? 'Anonymous'
    expect(name).toBe('Anonymous')
  })

  test('error case - still works with isError', () => {
    const user = findUser('error')

    if (isError(user)) {
      expect(user.id).toBe('error')
    }
  })

  test('optional chaining works naturally', () => {
    const user = findUser('missing')

    if (isError(user)) return

    // ?. works because user is User | null
    const nameLength = user?.name?.length
    expect(nameLength).toBeUndefined()
  })

  test('nullish coalescing with method calls', () => {
    function getConfig(): ValidationError | { timeout?: number } | null {
      return { timeout: undefined }
    }

    const config = getConfig()

    if (isError(config)) return

    // Chain ?. and ?? naturally
    const timeout = config?.timeout ?? 5000
    expect(timeout).toBe(5000)
  })
})

describe('Error | T | undefined', () => {
  function lookup(key: string): NetworkError | string | undefined {
    if (key === 'error') return new NetworkError({ url: '/lookup', message: 'Failed' })
    if (key === 'missing') return undefined
    return 'found-value'
  }

  test('success returns value', () => {
    const value = lookup('exists')

    if (isError(value)) return
    if (value === undefined) return

    expect(value).toBe('found-value')
  })

  test('undefined case with ?? fallback', () => {
    const value = lookup('missing')

    if (isError(value)) return

    const result = value ?? 'default'
    expect(result).toBe('default')
  })

  test('error case still caught by isError', () => {
    const value = lookup('error')

    expect(isError(value)).toBe(true)
    if (isError(value)) {
      expect(value.url).toBe('/lookup')
    }
  })
})

describe('complex: Error | T | null | undefined', () => {
  // Even triple union works naturally!
  function query(sql: string): ValidationError | { rows: string[] } | null | undefined {
    if (sql === 'invalid') return new ValidationError({ field: 'sql', message: 'Bad query' })
    if (sql === 'empty') return null
    if (sql === 'no-table') return undefined
    return { rows: ['a', 'b', 'c'] }
  }

  test('all branches narrowed correctly', () => {
    const result = query('SELECT *')

    if (isError(result)) {
      // TypeScript: result is ValidationError
      return result.field
    }

    if (result == null) {
      // TypeScript: result is null | undefined
      return 'no data'
    }

    // TypeScript: result is { rows: string[] }
    expect(result.rows).toEqual(['a', 'b', 'c'])
  })

  test('combined with ?? for defaults', () => {
    const result = query('empty')

    if (isError(result)) return

    // Works with null OR undefined
    const rows = result?.rows ?? []
    expect(rows).toEqual([])
  })
})
