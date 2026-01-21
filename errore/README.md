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
import * as errore from 'errore'

// Define typed errors
class NotFoundError extends errore.TaggedError('NotFoundError')<{
  id: string
  message: string
}>() {
  constructor(args: { id: string }) {
    super({ ...args, message: `User ${args.id} not found` })
  }
}

class DbError extends errore.TaggedError('DbError')<{
  message: string
  cause: unknown
}>() {}

// Function returns Error | Value (no wrapper!)
async function getUser(id: string): Promise<NotFoundError | DbError | User> {
  const result = await errore.tryAsync({
    try: () => db.query(id),
    catch: e => new DbError({ message: 'Query failed', cause: e })
  })
  
  if (errore.isError(result)) return result
  if (!result) return new NotFoundError({ id })
  
  return result
}

// Caller handles errors explicitly
const user = await getUser('123')

if (errore.isError(user)) {
  errore.matchError(user, {
    NotFoundError: e => console.log(`User ${e.id} not found`),
    DbError: e => console.log(`Database error: ${e.message}`)
  })
  return
}

// TypeScript knows: user is User
console.log(user.name)
```

## Example: API Error Handling

A complete example with custom base class, HTTP status codes, and error reporting:

```ts
import * as errore from 'errore'

// Base class with shared functionality
class AppError extends Error {
  statusCode: number = 500
  
  toResponse() {
    return { error: this.message, code: this.statusCode }
  }
}

// Specific errors with status codes
class NotFoundError extends errore.TaggedError('NotFoundError', AppError)<{
  resource: string
  message: string
}>() {
  statusCode = 404
}

class ValidationError extends errore.TaggedError('ValidationError', AppError)<{
  field: string
  message: string
}>() {
  statusCode = 400
}

class UnauthorizedError extends errore.TaggedError('UnauthorizedError', AppError)<{
  message: string
}>() {
  statusCode = 401
}

// Service function
async function updateUser(
  userId: string,
  data: { email?: string }
): Promise<NotFoundError | ValidationError | UnauthorizedError | User> {
  const session = await getSession()
  if (!session) {
    return new UnauthorizedError({ message: 'Not logged in' })
  }
  
  const user = await db.users.find(userId)
  if (!user) {
    return new NotFoundError({ resource: 'user', message: `User ${userId} not found` })
  }
  
  if (data.email && !isValidEmail(data.email)) {
    return new ValidationError({ field: 'email', message: 'Invalid email format' })
  }
  
  return db.users.update(userId, data)
}

// API handler
app.post('/users/:id', async (req, res) => {
  const result = await updateUser(req.params.id, req.body)
  
  if (errore.isError(result)) {
    // All errors have toResponse() from AppError base
    return res.status(result.statusCode).json(result.toResponse())
  }
  
  return res.json(result)
})
```

## API

### Type Guards

```ts
import * as errore from 'errore'

const result: NetworkError | User = await fetchUser(id)

if (errore.isError(result)) {
  // result is NetworkError
  return result
}
// result is User
```

### Try Functions

```ts
import * as errore from 'errore'

// Sync - wraps exceptions in UnhandledError
const parsed = errore.tryFn(() => JSON.parse(input))

// Sync - with custom error type
const parsed = errore.tryFn({
  try: () => JSON.parse(input),
  catch: e => new ParseError({ cause: e })
})

// Async
const response = await errore.tryAsync(() => fetch(url))

// Async - with custom error
const response = await errore.tryAsync({
  try: () => fetch(url),
  catch: e => new NetworkError({ cause: e })
})
```

### Transformations

```ts
import * as errore from 'errore'

// Transform value (if not error)
const name = errore.map(user, u => u.name)

// Transform error
const appError = errore.mapError(dbError, e => new AppError({ cause: e }))

// Chain operations
const posts = errore.andThen(user, u => fetchPosts(u.id))

// Side effects
const logged = errore.tap(user, u => console.log('Got user:', u.name))
```

### Composing Operations

Chain multiple operations together:

```ts
import * as errore from 'errore'

// Define operations that can fail
function parseNumber(s: string): ValidationError | number { ... }
function validatePositive(n: number): ValidationError | number { ... }
function divide(a: number, b: number): DivisionError | number { ... }

// Compose with nested calls
const result = errore.andThen(
  errore.andThen(parseNumber(input), validatePositive),
  n => divide(100, n)
)

// Or step by step (often clearer)
function calculate(input: string): ValidationError | DivisionError | number {
  const parsed = parseNumber(input)
  if (errore.isError(parsed)) return parsed

  const validated = validatePositive(parsed)
  if (errore.isError(validated)) return validated

  return divide(100, validated)
}

// Transform errors at the end
const appResult = errore.mapError(
  calculate(userInput),
  e => new AppError({ source: e._tag, message: e.message })
)
```

Real-world async composition:

```ts
import * as errore from 'errore'

async function processOrder(orderId: string): Promise<OrderError | Receipt> {
  const order = await fetchOrder(orderId)
  if (errore.isError(order)) return order

  const validated = validateOrder(order)
  if (errore.isError(validated)) return validated

  const payment = await processPayment(validated)
  if (errore.isError(payment)) return payment

  return generateReceipt(payment)
}

// Caller gets union of all possible errors
const receipt = await processOrder('123')
if (errore.isError(receipt)) {
  const message = errore.matchError(receipt, {
    NotFoundError: e => `Order ${e.id} not found`,
    ValidationError: e => `Invalid: ${e.field}`,
    PaymentError: e => `Payment failed: ${e.reason}`,
  })
  console.log(message)
  return
}
```

### Extraction

```ts
import * as errore from 'errore'

// Extract or throw
const user = errore.unwrap(result)
const user = errore.unwrap(result, 'Custom error message')

// Extract or fallback
const name = errore.unwrapOr(result, 'Anonymous')

// Pattern match
const message = errore.match(result, {
  ok: user => `Hello, ${user.name}`,
  err: error => `Failed: ${error.message}`
})

// Split array into [successes, errors]
const [users, errors] = errore.partition(results)
```

### Tagged Errors

```ts
import * as errore from 'errore'

// Define errors with _tag discriminant
class ValidationError extends errore.TaggedError('ValidationError')<{
  field: string
  message: string
}>() {}

class NetworkError extends errore.TaggedError('NetworkError')<{
  url: string
  message: string
}>() {}

type AppError = ValidationError | NetworkError

// Exhaustive matching (TypeScript ensures all cases handled)
const message = errore.matchError(error, {
  ValidationError: e => `Invalid ${e.field}`,
  NetworkError: e => `Failed to fetch ${e.url}`
})
console.log(message)

// Handle plain Error with _ (underscore) handler
function riskyOp(): ValidationError | Error { ... }
const err = riskyOp()
const msg = errore.matchError(err, {
  ValidationError: e => `Invalid ${e.field}`,
  _: e => `Plain error: ${e.message}`  // catches non-tagged Error
})

// Partial matching with fallback
const fallbackMsg = errore.matchErrorPartial(error, {
  ValidationError: e => `Invalid ${e.field}`
}, e => `Unknown error: ${e.message}`)
console.log(fallbackMsg)

// Type guards
ValidationError.is(value)  // specific class
errore.TaggedError.is(value)      // any tagged error
```

### Custom Base Class

Extend from your own base class to share functionality across all errors:

```ts
import * as errore from 'errore'

// Custom base with shared functionality
class AppError extends Error {
  statusCode: number = 500
  
  report() {
    sentry.captureException(this)
  }
}

// Pass base class as second argument
class NotFoundError extends errore.TaggedError('NotFoundError', AppError)<{
  id: string
  message: string
}>() {
  statusCode = 404
}

class ServerError extends errore.TaggedError('ServerError', AppError)<{
  message: string
}>() {}

const err = new NotFoundError({ id: '123', message: 'User not found' })
err.statusCode  // 404
err.report()    // calls sentry
err._tag        // 'NotFoundError'
err instanceof AppError  // true
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
import * as errore from 'errore'

// Result + Option in one natural type
function findUser(id: string): NotFoundError | User | null {
  if (id === 'bad') return new NotFoundError({ id })
  if (id === 'missing') return null
  return { id, name: 'Alice' }
}

const user = findUser('123')

// Handle error first
if (errore.isError(user)) {
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
import * as errore from 'errore'

function lookup(key: string): NetworkError | string | undefined {
  if (key === 'fail') return new NetworkError({ url: '/api', message: 'Failed' })
  if (key === 'missing') return undefined
  return 'found-value'
}

const value = lookup('key')

if (errore.isError(value)) return value

// ?? works naturally with undefined
const result = value ?? 'default'
```

### Triple union: `Error | T | null | undefined`

Even this works with full type inference:

```ts
import * as errore from 'errore'

function query(sql: string): ValidationError | { rows: string[] } | null | undefined {
  if (sql === 'invalid') return new ValidationError({ field: 'sql', message: 'Bad' })
  if (sql === 'empty') return null      // explicitly no data
  if (sql === 'no-table') return undefined  // table doesn't exist
  return { rows: ['a', 'b'] }
}

const result = query('SELECT *')

if (errore.isError(result)) {
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

## Import Style

> **Note:** Always use `import * as errore from 'errore'` instead of named imports. This makes code easier to move between files, and more readable for people unfamiliar with errore since every function call is clearly namespaced (e.g. `errore.isError()` instead of just `isError()`).

## License

MIT
