// libsqlproxy — Runtime-agnostic Hrana v2 HTTP server for SQLite.
//
// Expose any SQLite database via the libSQL remote protocol.
// Works with Cloudflare Durable Objects, Node.js libsql, better-sqlite3,
// or any custom SQL driver via the LibsqlExecutor interface.
//
// Auth model for multi-tenant (Cloudflare Workers):
//   Bearer token = "namespace:secret"
//   Client: createClient({ url: 'https://libsql.example.com', authToken: 'ns-id:secret' })
//
// Hrana v2 spec: https://github.com/tursodatabase/libsql/blob/main/docs/HTTP_V2_SPEC.md

// Core handler
export { createLibsqlHandler } from './handler.ts'
export type { LibsqlHandler } from './handler.ts'

// Executor interface + adapters
export type { LibsqlExecutor } from './executor.ts'
export { libsqlExecutor } from './libsql-executor.ts'
export type { LibsqlDatabase, LibsqlStatement } from './libsql-executor.ts'
export { durableObjectExecutor } from './durable-object-executor.ts'
export type {
  DurableObjectSqlCursor,
  DurableObjectSqlStorage,
  DurableObjectStorage,
} from './durable-object-executor.ts'

// Node.js http adapter
export { createLibsqlNodeHandler } from './node-handler.ts'
export type { LibsqlNodeHandler, LibsqlNodeHandlerOptions } from './node-handler.ts'

// Cloudflare Worker proxy
export { createLibsqlProxy } from './proxy.ts'
export type { LibsqlProxyOptions, LibsqlDurableObjectStub } from './proxy.ts'

// Protocol internals (for advanced use / testing)
export { processHranaRequest, evaluateHranaCondition } from './protocol.ts'
export { encodeHranaValue, decodeHranaValue, decodeHranaParams } from './values.ts'

// Types
export type {
  HranaValue,
  HranaStmt,
  HranaCondition,
  HranaBatchStep,
  HranaRequest,
  HranaPipelineRequest,
  HranaPipelineResponse,
  HranaColInfo,
  HranaExecuteResult,
  HranaDescribeResult,
  HranaError,
  HranaStreamResult,
} from './types.ts'
