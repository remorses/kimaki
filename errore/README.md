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

### Composing Operations

Chain multiple operations together:

```ts
import { map, andThen, mapError, isError } from 'errore'

// Define operations that can fail
function parseNumber(s: string): ValidationError | number { ... }
function validatePositive(n: number): ValidationError | number { ... }
function divide(a: number, b: number): DivisionError | number { ... }

// Compose with nested calls
const result = andThen(
  andThen(parseNumber(input), validatePositive),
  n => divide(100, n)
)

// Or step by step (often clearer)
function calculate(input: string): ValidationError | DivisionError | number {
  const parsed = parseNumber(input)
  if (isError(parsed)) return parsed

  const validated = validatePositive(parsed)
  if (isError(validated)) return validated

  return divide(100, validated)
}

// Transform errors at the end
const appResult = mapError(
  calculate(userInput),
  e => new AppError({ source: e._tag, message: e.message })
)
```

Real-world async composition:

```ts
async function processOrder(orderId: string): Promise<OrderError | Receipt> {
  const order = await fetchOrder(orderId)
  if (isError(order)) return order

  const validated = validateOrder(order)
  if (isError(validated)) return validated

  const payment = await processPayment(validated)
  if (isError(payment)) return payment

  return generateReceipt(payment)
}

// Caller gets union of all possible errors
const receipt = await processOrder('123')
if (isError(receipt)) {
  matchError(receipt, {
    NotFoundError: e => `Order ${e.id} not found`,
    ValidationError: e => `Invalid: ${e.field}`,
    PaymentError: e => `Payment failed: ${e.reason}`,
  })
}
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

## Result + Option Combined: `Error | T | null`

One of errore's best features: you can naturally combine error handling with optional values. No wrapper nesting needed!

In Rust, you'd need `Result<Option<T>, E>` or `Option<Result<T, E>>` and worry about the order. Here it's just a union:

```ts
// Result + Option in one natural type
function findUser(id: string): NotFoundError | User | null {
  if (id === 'bad') return new NotFoundError({ id })
  if (id === 'missing') return null
  return { id, name: 'Alice' }
}

const user = findUser('123')

// Handle error first
if (isError(user)) {
  return user.message  // TypeScript: user is NotFoundError
}

// Handle null/missing case - use ?. and ?? naturally!
const name = user?.name ?? 'Anonymous'

// Or check explicitly
if (user === null) {
  return 'User not found'
}

// TypeScript knows: user is User
console.log(user.name)
```

### Works with `undefined` too

```ts
function lookup(key: string): NetworkError | string | undefined {
  if (key === 'fail') return new NetworkError({ url: '/api', message: 'Failed' })
  if (key === 'missing') return undefined
  return 'found-value'
}

const value = lookup('key')

if (isError(value)) return value

// ?? works naturally with undefined
const result = value ?? 'default'
```

### Triple union: `Error | T | null | undefined`

Even this works with full type inference:

```ts
function query(sql: string): ValidationError | { rows: string[] } | null | undefined {
  if (sql === 'invalid') return new ValidationError({ field: 'sql', message: 'Bad' })
  if (sql === 'empty') return null      // explicitly no data
  if (sql === 'no-table') return undefined  // table doesn't exist
  return { rows: ['a', 'b'] }
}

const result = query('SELECT *')

if (isError(result)) {
  return result.field  // TypeScript: ValidationError
}

if (result == null) {
  return 'no data'  // handles both null and undefined
}

// TypeScript: { rows: string[] }
console.log(result.rows)
```

### Why this is better than Rust/Zig

| Language | Result + Option | Order matters? |
|----------|-----------------|----------------|
| Rust | `Result<Option<T>, E>` or `Option<Result<T, E>>` | Yes, must unwrap in order |
| Zig | `!?T` (error union + optional) | Yes, specific syntax |
| **errore** | `Error \| T \| null` | **No!** Check in any order |

With errore:
- Use `?.` and `??` naturally
- Check `isError()` or `=== null` in any order
- No unwrapping ceremony
- TypeScript infers everything

## Comparison with Result Types

| Result Pattern | errore |
|---------------|--------|
| `Result.ok(value)` | just `return value` |
| `Result.err(error)` | just `return error` |
| `result.value` | direct access after guard |
| `result.map(fn)` | `map(result, fn)` |
| `Result<User, Error>` | `Error \| User` |
| `Result<Option<T>, E>` | `Error \| T \| null` |

## License

MIT
