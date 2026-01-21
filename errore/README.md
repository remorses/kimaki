# errore

Type-safe errors as values for TypeScript. Like Go, but with full type inference.

## Why?

Instead of wrapping values in a `Result<T, E>` type, functions simply return `E | T`. TypeScript's type narrowing handles the rest:

```ts
// Go-style: errors as values
const user = await fetchUser(id)
if (isError(user)) return user  // TypeScript narrows type
console.log(user.name)          // user is now User, not Error | User
```

## Install

```sh
npm install errore
```

## Quick Start

```ts
import { tryAsync, isError, TaggedError, matchError } from 'errore'

// Define typed errors
class NotFoundError extends TaggedError('NotFoundError')<{
  id: string
  message: string
}>() {
  constructor(args: { id: string }) {
    super({ ...args, message: `User ${args.id} not found` })
  }
}

class DbError extends TaggedError('DbError')<{
  message: string
  cause: unknown
}>() {}

// Function returns Error | Value (no wrapper!)
async function getUser(id: string): Promise<NotFoundError | DbError | User> {
  const result = await tryAsync({
    try: () => db.query(id),
    catch: e => new DbError({ message: 'Query failed', cause: e })
  })
  
  if (isError(result)) return result
  if (!result) return new NotFoundError({ id })
  
  return result
}

// Caller handles errors explicitly
const user = await getUser('123')

if (isError(user)) {
  matchError(user, {
    NotFoundError: e => console.log(`User ${e.id} not found`),
    DbError: e => console.log(`Database error: ${e.message}`)
  })
  return
}

// TypeScript knows: user is User
console.log(user.name)
```

## API

### Type Guards

```ts
import { isError, isOk } from 'errore'

const result: NetworkError | User = await fetchUser(id)

if (isError(result)) {
  // result is NetworkError
  return result
}
// result is User
```

### Try Functions

```ts
import { tryFn, tryAsync } from 'errore'

// Sync - wraps exceptions in UnhandledError
const parsed = tryFn(() => JSON.parse(input))

// Sync - with custom error type
const parsed = tryFn({
  try: () => JSON.parse(input),
  catch: e => new ParseError({ cause: e })
})

// Async
const response = await tryAsync(() => fetch(url))

// Async - with custom error
const response = await tryAsync({
  try: () => fetch(url),
  catch: e => new NetworkError({ cause: e })
})
```

### Transformations

```ts
import { map, mapError, andThen, tap } from 'errore'

// Transform value (if not error)
const name = map(user, u => u.name)

// Transform error
const appError = mapError(dbError, e => new AppError({ cause: e }))

// Chain operations
const posts = andThen(user, u => fetchPosts(u.id))

// Side effects
const logged = tap(user, u => console.log('Got user:', u.name))
```

### Extraction

```ts
import { unwrap, unwrapOr, match, partition } from 'errore'

// Extract or throw
const user = unwrap(result)
const user = unwrap(result, 'Custom error message')

// Extract or fallback
const name = unwrapOr(result, 'Anonymous')

// Pattern match
const message = match(result, {
  ok: user => `Hello, ${user.name}`,
  err: error => `Failed: ${error.message}`
})

// Split array into [successes, errors]
const [users, errors] = partition(results)
```

### Tagged Errors

```ts
import { TaggedError, matchError, matchErrorPartial } from 'errore'

// Define errors with _tag discriminant
class ValidationError extends TaggedError('ValidationError')<{
  field: string
  message: string
}>() {}

class NetworkError extends TaggedError('NetworkError')<{
  url: string
  message: string
}>() {}

type AppError = ValidationError | NetworkError

// Exhaustive matching (TypeScript ensures all cases handled)
matchError(error, {
  ValidationError: e => `Invalid ${e.field}`,
  NetworkError: e => `Failed to fetch ${e.url}`
})

// Partial matching with fallback
matchErrorPartial(error, {
  ValidationError: e => `Invalid ${e.field}`
}, e => `Unknown error: ${e.message}`)

// Type guards
ValidationError.is(value)  // specific class
TaggedError.is(value)      // any tagged error
```

## How Type Safety Works

TypeScript narrows types after `instanceof Error` checks:

```ts
function example(result: NetworkError | User): string {
  if (result instanceof Error) {
    // TypeScript knows: result is NetworkError
    return result.message
  }
  // TypeScript knows: result is User (Error excluded)
  return result.name
}
```

This works because:
1. `Error` is a built-in class TypeScript understands
2. Custom error classes extend `Error`
3. After an `instanceof Error` check, TS excludes all Error subtypes

## Comparison with Result Types

| Result Pattern | errore |
|---------------|--------|
| `Result.ok(value)` | just `return value` |
| `Result.err(error)` | just `return error` |
| `result.value` | direct access after guard |
| `result.map(fn)` | `map(result, fn)` |
| `Result<User, Error>` | `Error \| User` |

## License

MIT
