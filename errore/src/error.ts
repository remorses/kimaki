/**
 * Serialize cause for JSON output
 */
const serializeCause = (cause: unknown): unknown => {
  if (cause instanceof Error) {
    return { name: cause.name, message: cause.message, stack: cause.stack }
  }
  return cause
}

/**
 * Any tagged error (for generic constraints)
 */
type AnyTaggedError = Error & { readonly _tag: string }

/**
 * Type guard for any tagged error
 */
const isAnyTaggedError = (value: unknown): value is AnyTaggedError => {
  return value instanceof Error && '_tag' in value && typeof value._tag === 'string'
}

/**
 * Any class that extends Error
 */
type ErrorClass = new (...args: any[]) => Error

/**
 * Instance type produced by TaggedError factory
 */
export type TaggedErrorInstance<Tag extends string, Props, Base extends Error = Error> = Base & {
  readonly _tag: Tag
  toJSON(): object
} & Readonly<Props>

/**
 * Class type produced by TaggedError factory
 */
export type TaggedErrorClass<Tag extends string, Props, Base extends Error = Error> = {
  new (...args: keyof Props extends never ? [args?: {}] : [args: Props]): TaggedErrorInstance<Tag, Props, Base>
  /** Type guard for this error class */
  is(value: unknown): value is TaggedErrorInstance<Tag, Props, Base>
}

/**
 * Factory for tagged error classes with discriminated _tag property.
 * Enables exhaustive pattern matching on error unions.
 *
 * @example
 * class NotFoundError extends TaggedError("NotFoundError")<{
 *   id: string;
 *   message: string;
 * }>() {}
 *
 * const err = new NotFoundError({ id: "123", message: "Not found" });
 * err._tag    // "NotFoundError"
 * err.id      // "123"
 *
 * // Type guard
 * NotFoundError.is(err) // true
 * TaggedError.is(err)   // true (any tagged error)
 *
 * @example
 * // With custom base class
 * class AppError extends Error {
 *   statusCode: number = 500
 *   report() { console.log(this.message) }
 * }
 *
 * class NotFoundError extends TaggedError("NotFoundError", AppError)<{
 *   id: string;
 *   message: string;
 * }>() {
 *   statusCode = 404
 * }
 *
 * const err = new NotFoundError({ id: "123", message: "Not found" });
 * err.statusCode // 404
 * err.report()   // works
 */
export const TaggedError: {
  <Tag extends string, BaseClass extends ErrorClass = typeof Error>(
    tag: Tag,
    BaseClass?: BaseClass,
  ): <Props extends Record<string, unknown> = {}>() => TaggedErrorClass<Tag, Props, InstanceType<BaseClass>>
  /** Type guard for any TaggedError instance */
  is(value: unknown): value is AnyTaggedError
} = Object.assign(
  <Tag extends string, BaseClass extends ErrorClass = typeof Error>(tag: Tag, BaseClass?: BaseClass) =>
    <Props extends Record<string, unknown> = {}>(): TaggedErrorClass<Tag, Props, InstanceType<BaseClass>> => {
      const ActualBase = (BaseClass ?? Error) as typeof Error

      class Tagged extends ActualBase {
        readonly _tag: Tag = tag

        /** Type guard for this error class */
        static is(value: unknown): value is Tagged {
          return value instanceof Tagged
        }

        constructor(args?: Props) {
          const message = args && 'message' in args && typeof args.message === 'string' ? args.message : undefined
          const cause = args && 'cause' in args ? args.cause : undefined

          super(message, cause !== undefined ? { cause } : undefined)

          if (args) {
            Object.assign(this, args)
          }

          Object.setPrototypeOf(this, new.target.prototype)
          this.name = tag

          if (cause instanceof Error && cause.stack) {
            const indented = cause.stack.replace(/\n/g, '\n  ')
            this.stack = `${this.stack}\nCaused by: ${indented}`
          }
        }

        toJSON(): object {
          return {
            ...this,
            _tag: this._tag,
            name: this.name,
            message: this.message,
            cause: serializeCause(this.cause),
            stack: this.stack,
          }
        }
      }

      return Tagged as unknown as TaggedErrorClass<Tag, Props, InstanceType<BaseClass>>
    },
  { is: isAnyTaggedError },
)

/**
 * Type guard for tagged error instances.
 *
 * @example
 * if (isTaggedError(value)) { value._tag }
 */
export const isTaggedError = isAnyTaggedError

/**
 * Handler map for exhaustive matching (tagged errors only)
 */
type MatchHandlers<E extends AnyTaggedError, R> = {
  [K in E['_tag']]: (err: Extract<E, { _tag: K }>) => R
}

/**
 * Handler map that includes `_` for plain Error (untagged)
 */
type MatchHandlersWithPlain<E extends Error, R> = {
  [K in Extract<E, AnyTaggedError>['_tag']]: (err: Extract<E, { _tag: K }>) => R
} & (Exclude<E, AnyTaggedError> extends never
  ? {}
  : { _: (err: Exclude<E, AnyTaggedError>) => R })

/**
 * Exhaustive pattern match on error union by _tag.
 * Use `_` handler for plain Error instances without _tag.
 *
 * @example
 * // Tagged errors only
 * matchError(err, {
 *   NotFoundError: (e) => `Missing: ${e.id}`,
 *   ValidationError: (e) => `Invalid: ${e.field}`,
 * });
 *
 * @example
 * // Mixed tagged and plain Error
 * matchError(err, {
 *   NotFoundError: (e) => `Missing: ${e.id}`,
 *   _: (e) => `Unknown error: ${e.message}`,
 * });
 */
export function matchError<E extends Error, R>(err: E, handlers: MatchHandlersWithPlain<E, R>): R {
  const h = handlers as unknown as Record<string, (e: Error) => R>
  if ('_tag' in err && typeof err._tag === 'string') {
    const handler = h[err._tag]
    if (handler) {
      return handler(err)
    }
  }
  // Fall through to _ handler for plain Error
  const fallbackHandler = h['_']
  if (fallbackHandler) {
    return fallbackHandler(err)
  }
  throw new Error(`No handler for error: ${err.message}`)
}

/**
 * Partial pattern match with fallback for unhandled tags.
 *
 * @example
 * matchErrorPartial(err, {
 *   NotFoundError: (e) => `Missing: ${e.id}`,
 * }, (e) => `Unknown: ${e.message}`);
 */
export function matchErrorPartial<E extends Error, R>(
  err: E,
  handlers: Partial<MatchHandlersWithPlain<E, R>>,
  fallback: (e: E) => R,
): R {
  const h = handlers as unknown as Record<string, (e: Error) => R>
  if ('_tag' in err && typeof err._tag === 'string') {
    const handler = h[err._tag]
    if (handler) {
      return handler(err)
    }
  }
  // Check for _ handler before fallback
  const underscoreHandler = h['_']
  if (underscoreHandler) {
    return underscoreHandler(err)
  }
  return fallback(err)
}

/**
 * Default error type when catching unknown exceptions.
 */
export class UnhandledError extends TaggedError('UnhandledError')<{
  message: string
  cause: unknown
}>() {
  constructor(args: { cause: unknown }) {
    const message =
      args.cause instanceof Error
        ? `Unhandled exception: ${args.cause.message}`
        : `Unhandled exception: ${String(args.cause)}`
    super({ message, cause: args.cause })
  }
}
