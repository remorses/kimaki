# Migrating to errore

> **Note:** Always use `import * as errore from 'errore'` instead of named imports. This makes code easier to move between files, and more readable for people unfamiliar with errore since every function call is clearly namespaced (e.g. `errore.isError()` instead of just `isError()`).

This guide shows how to migrate a TypeScript codebase from try-catch exceptions to type-safe errors as values, Go-style.

## Philosophy

Instead of:
```ts
try {
  const user = await fetchUser(id)
  const posts = await fetchPosts(user.id)
  return posts
} catch (e) {
  // What errors can happen here? Who knows!
  console.error(e)
}
```

You write:
```ts
import * as errore from 'errore'

const user = await fetchUser(id)
if (errore.isError(user)) return user  // early return, like Go

const posts = await fetchPosts(user.id)
if (errore.isError(posts)) return posts

return posts
```

TypeScript knows exactly what errors can occur and enforces handling them.

## Migration Strategy: Start from the Leaves

Migrate bottom-up, starting with the lowest-level functions that interact with external systems (database, network, file system). Then work your way up.

```
High-level handlers (migrate last)
       ↑
  Business logic
       ↑
  Service functions
       ↑
Low-level utilities (migrate first) ← START HERE
```

## Step 1: Define Your Error Types

Create typed errors for your domain using `TaggedError`:

```ts
// errors.ts
import * as errore from 'errore'

// Database errors
export class DbConnectionError extends errore.TaggedError('DbConnectionError')<{
  message: string
  cause?: unknown
}>() {}

export class RecordNotFoundError extends errore.TaggedError('RecordNotFoundError')<{
  table: string
  id: string
  message: string
}>() {
  constructor(args: { table: string; id: string }) {
    super({ ...args, message: `${args.table} with id ${args.id} not found` })
  }
}

// Network errors
export class NetworkError extends errore.TaggedError('NetworkError')<{
  url: string
  status?: number
  message: string
}>() {}

// Validation errors
export class ValidationError extends errore.TaggedError('ValidationError')<{
  field: string
  message: string
}>() {}

// Auth errors
export class UnauthorizedError extends errore.TaggedError('UnauthorizedError')<{
  message: string
}>() {
  constructor() {
    super({ message: 'Unauthorized' })
  }
}
```

## Step 2: Migrate Leaf Functions

### Before: Function that throws

```ts
async function getUserById(id: string): Promise<User> {
  const user = await db.query('SELECT * FROM users WHERE id = ?', [id])
  if (!user) {
    throw new Error('User not found')
  }
  return user
}
```

### After: Function returns error or value

```ts
import * as errore from 'errore'
import { DbConnectionError, RecordNotFoundError } from './errors'

async function getUserById(id: string): Promise<DbConnectionError | RecordNotFoundError | User> {
  const result = await errore.tryAsync({
    try: () => db.query('SELECT * FROM users WHERE id = ?', [id]),
    catch: (e) => new DbConnectionError({ message: 'Database query failed', cause: e })
  })
  
  if (errore.isError(result)) return result
  if (!result) return new RecordNotFoundError({ table: 'users', id })
  
  return result
}
```

## Step 3: Migrate Callers (Early Return Pattern)

### Before: try-catch

```ts
async function getFullUser(id: string): Promise<FullUser> {
  try {
    const user = await getUserById(id)
    const profile = await getProfileByUserId(user.id)
    const settings = await getSettingsByUserId(user.id)
    
    return { ...user, profile, settings }
  } catch (e) {
    console.error('Failed to get full user:', e)
    throw e
  }
}
```

### After: Early returns (Go-style)

```ts
import * as errore from 'errore'

type GetFullUserError = 
  | DbConnectionError 
  | RecordNotFoundError

async function getFullUser(id: string): Promise<GetFullUserError | FullUser> {
  const user = await getUserById(id)
  if (errore.isError(user)) return user

  const profile = await getProfileByUserId(user.id)
  if (errore.isError(profile)) return profile

  const settings = await getSettingsByUserId(user.id)
  if (errore.isError(settings)) return settings

  return { ...user, profile, settings }
}
```

## Step 4: Handle Errors at the Top Level

At your API handlers or entry points, handle all errors explicitly:

```ts
import * as errore from 'errore'

app.get('/users/:id', async (req, res) => {
  const user = await getFullUser(req.params.id)
  
  if (errore.isError(user)) {
    const response = errore.matchError(user, {
      RecordNotFoundError: (e) => ({ status: 404, body: { error: `User ${e.id} not found` } }),
      DbConnectionError: (e) => ({ status: 500, body: { error: 'Database error' } }),
    })
    return res.status(response.status).json(response.body)
  }
  
  return res.json(user)
})
```

## Common Patterns

### Wrapping External Libraries

Use `tryFn` or `tryAsync` to wrap functions that throw:

```ts
import * as errore from 'errore'

// Sync: JSON parsing
function parseJson(input: string): ValidationError | unknown {
  const result = errore.tryFn({
    try: () => JSON.parse(input),
    catch: () => new ValidationError({ field: 'json', message: 'Invalid JSON' })
  })
  return result
}

// Async: fetch wrapper
async function fetchJson<T>(url: string): Promise<NetworkError | T> {
  const response = await errore.tryAsync({
    try: () => fetch(url),
    catch: (e) => new NetworkError({ url, message: `Fetch failed: ${e}` })
  })
  if (errore.isError(response)) return response
  
  if (!response.ok) {
    return new NetworkError({ url, status: response.status, message: `HTTP ${response.status}` })
  }
  
  const data = await errore.tryAsync({
    try: () => response.json() as Promise<T>,
    catch: () => new NetworkError({ url, message: 'Invalid JSON response' })
  })
  return data
}
```

### Optional Values: Use `| null`

Combine error handling with optional values naturally:

```ts
import * as errore from 'errore'

async function findUserByEmail(email: string): Promise<DbConnectionError | User | null> {
  const result = await errore.tryAsync({
    try: () => db.query('SELECT * FROM users WHERE email = ?', [email]),
    catch: (e) => new DbConnectionError({ message: 'Query failed', cause: e })
  })
  
  if (errore.isError(result)) return result
  return result ?? null  // explicitly return null if not found
}

// Caller
const user = await findUserByEmail('test@example.com')
if (errore.isError(user)) return user
if (user === null) {
  // Handle not found case
  return new RecordNotFoundError({ table: 'users', id: email })
}
// user is User
```

### Validating Input

```ts
function validateCreateUser(input: unknown): ValidationError | CreateUserInput {
  if (!input || typeof input !== 'object') {
    return new ValidationError({ field: 'body', message: 'Invalid request body' })
  }
  
  const { email, name } = input as Record<string, unknown>
  
  if (typeof email !== 'string' || !email.includes('@')) {
    return new ValidationError({ field: 'email', message: 'Invalid email' })
  }
  
  if (typeof name !== 'string' || name.length < 2) {
    return new ValidationError({ field: 'name', message: 'Name must be at least 2 characters' })
  }
  
  return { email, name }
}
```

### Multiple Sequential Operations

```ts
import * as errore from 'errore'

async function createUserWithProfile(
  input: CreateUserInput
): Promise<ValidationError | DbConnectionError | User> {
  // Validate
  const validated = validateCreateUser(input)
  if (errore.isError(validated)) return validated

  // Create user
  const user = await createUser(validated)
  if (errore.isError(user)) return user

  // Create default profile
  const profile = await createProfile({ userId: user.id, bio: '' })
  if (errore.isError(profile)) return profile

  // Send welcome email (don't fail if this fails)
  const emailResult = await sendWelcomeEmail(user.email)
  if (errore.isError(emailResult)) {
    console.warn('Failed to send welcome email:', emailResult.message)
    // Continue anyway
  }

  return user
}
```

### Parallel Operations

```ts
import * as errore from 'errore'

async function getUserDashboard(
  userId: string
): Promise<DbConnectionError | RecordNotFoundError | Dashboard> {
  // Fetch in parallel
  const [userResult, postsResult, statsResult] = await Promise.all([
    getUser(userId),
    getUserPosts(userId),
    getUserStats(userId),
  ])

  // Check each result
  if (errore.isError(userResult)) return userResult
  if (errore.isError(postsResult)) return postsResult
  if (errore.isError(statsResult)) return statsResult

  return {
    user: userResult,
    posts: postsResult,
    stats: statsResult,
  }
}
```

### Replacing `let` + try-catch with Expressions

A common pattern is declaring a variable with `let`, then assigning inside try-catch for error recovery. This is ugly and error-prone. errore makes these into clean expressions.

#### Pattern 1: Fallback value on error

**Before:**
```ts
let config;
try {
  config = JSON.parse(fs.readFileSync('config.json', 'utf-8'))
} catch (e) {
  config = { port: 3000, debug: false }  // fallback
}
```

**After:** Use `unwrapOr` for a one-liner
```ts
import * as errore from 'errore'

const config = errore.unwrapOr(
  errore.tryFn(() => JSON.parse(fs.readFileSync('config.json', 'utf-8'))),
  { port: 3000, debug: false }
)
```

#### Pattern 2: Different fallback logic based on error

**Before:**
```ts
let user;
try {
  user = await fetchUser(id)
} catch (e) {
  if (e.code === 'NOT_FOUND') {
    user = await createDefaultUser(id)
  } else {
    throw e
  }
}
```

**After:** Use `isError` + conditional
```ts
import * as errore from 'errore'

const fetchResult = await fetchUser(id)
const user = errore.isError(fetchResult) && RecordNotFoundError.is(fetchResult)
  ? await createDefaultUser(id)
  : fetchResult

// Or more explicitly:
const user = (() => {
  const result = await fetchUser(id)
  if (RecordNotFoundError.is(result)) {
    return createDefaultUser(id)
  }
  return result
})()
```

#### Pattern 3: Retry on failure

**Before:**
```ts
let result;
let attempts = 0;
while (attempts < 3) {
  try {
    result = await fetchData()
    break
  } catch (e) {
    attempts++
    if (attempts >= 3) throw e
    await sleep(1000)
  }
}
```

**After:** Loop with early break
```ts
import * as errore from 'errore'

async function fetchWithRetry(): Promise<NetworkError | Data> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const result = await fetchData()
    if (errore.isOk(result)) return result
    
    if (attempt < 2) await sleep(1000)  // don't sleep on last attempt
  }
  return new NetworkError({ url: '/api', message: 'Failed after 3 attempts' })
}

const result = await fetchWithRetry()
```

#### Pattern 4: Accumulating results, some may fail

**Before:**
```ts
const results = []
for (const id of ids) {
  try {
    const item = await fetchItem(id)
    results.push(item)
  } catch (e) {
    console.warn(`Failed to fetch ${id}`)
    // continue with others
  }
}
```

**After:** Use `partition` or filter
```ts
import * as errore from 'errore'

const allResults = await Promise.all(ids.map(fetchItem))
const [items, errors] = errore.partition(allResults)

// Log errors if needed
errors.forEach(e => console.warn('Failed:', e.message))

// items contains only successful results
```

#### Pattern 5: Transform or default

**Before:**
```ts
let value;
try {
  const raw = await fetchValue()
  value = transform(raw)
} catch (e) {
  value = defaultValue
}
```

**After:** Clean expression
```ts
import * as errore from 'errore'

const raw = await fetchValue()
const value = errore.isError(raw) ? defaultValue : transform(raw)
```

#### Pattern 6: Cache with fallback to fetch

**Before:**
```ts
let data;
try {
  data = cache.get(key)
  if (!data) throw new Error('cache miss')
} catch (e) {
  data = await fetchFromDb(key)
  cache.set(key, data)
}
```

**After:** Explicit flow
```ts
import * as errore from 'errore'

const cached = cache.get(key)  // returns Data | null

const data = cached ?? await (async () => {
  const fetched = await fetchFromDb(key)
  if (errore.isOk(fetched)) cache.set(key, fetched)
  return fetched
})()
```

Or simpler:
```ts
import * as errore from 'errore'

async function getWithCache(key: string): Promise<DbError | Data> {
  const cached = cache.get(key)
  if (cached) return cached
  
  const fetched = await fetchFromDb(key)
  if (errore.isOk(fetched)) cache.set(key, fetched)
  
  return fetched
}
```

#### Pattern 7: Multiple sources with fallback chain

**Before:**
```ts
let config;
try {
  config = loadFromEnv()
} catch {
  try {
    config = loadFromFile()
  } catch {
    config = defaultConfig
  }
}
```

**After:** Chain with `??` and `unwrapOr`
```ts
import * as errore from 'errore'

const envConfig = loadFromEnv()      // ConfigError | Config
const fileConfig = loadFromFile()    // ConfigError | Config

const config = errore.isOk(envConfig) ? envConfig
  : errore.isOk(fileConfig) ? fileConfig
  : defaultConfig
```

Or as a function:
```ts
import * as errore from 'errore'

function loadConfig(): Config {
  const sources = [loadFromEnv, loadFromFile]
  
  for (const load of sources) {
    const result = load()
    if (errore.isOk(result)) return result
  }
  
  return defaultConfig
}
```

#### Key Insight: Expressions over Statements

The pattern is always:
1. **Before:** `let x; try { x = ... } catch { x = ... }` (statements)
2. **After:** `const x = errore.isError(result) ? fallback : result` (expression)

This makes code:
- More readable (no mutation)
- Type-safe (TypeScript tracks the union)
- Easier to test (pure expressions)

### Converting Existing Code Gradually

You can convert one function at a time. Use `unwrap` at boundaries:

```ts
import * as errore from 'errore'

// New code using errore
async function getUser(id: string): Promise<DbConnectionError | User> {
  // ... returns error or value
}

// Old code that expects throws - use unwrap at the boundary
async function legacyHandler(id: string) {
  const user = await getUser(id)
  // unwrap throws if error, returns value otherwise
  return errore.unwrap(user, 'Failed to get user')
}
```

## Checklist

- [ ] Define error types in `errors.ts` using `TaggedError`
- [ ] Identify leaf functions (database, network, file I/O)
- [ ] Migrate leaf functions to return `Error | Value`
- [ ] Update function signatures with explicit error unions
- [ ] Replace `try-catch` with `isError` checks and early returns
- [ ] Use `matchError` at top-level handlers for exhaustive handling
- [ ] Use `| null` for optional values instead of `| undefined`
- [ ] Add `_` handler in `matchError` if you need to catch unexpected errors

## Quick Reference

```ts
import * as errore from 'errore'
// errore.tryFn        - wrap sync throwing function
// errore.tryAsync     - wrap async throwing function
// errore.isError      - check if value is error (type guard)
// errore.isOk         - check if value is NOT error
// errore.unwrap       - extract value or throw
// errore.unwrapOr     - extract value or use fallback
// errore.match        - pattern match ok/err
// errore.matchError   - pattern match by error _tag
// errore.TaggedError  - create typed error classes

// Define errors
class MyError extends errore.TaggedError('MyError')<{ message: string }>() {}

// Return errors instead of throwing
function myFn(): MyError | string {
  if (bad) return new MyError({ message: 'failed' })
  return 'success'
}

// Early return pattern
const result = myFn()
if (errore.isError(result)) return result
// result is string here

// Handle at top level
if (errore.isError(result)) {
  const msg = errore.matchError(result, {
    MyError: e => e.message,
    _: e => `Unknown: ${e.message}`  // plain Error fallback
  })
  console.log(msg)
}
```
