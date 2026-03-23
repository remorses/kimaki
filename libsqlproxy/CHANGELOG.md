## 0.1.0

Initial release.

1. **Expose SQLite databases via the libSQL remote protocol (Hrana v2)** — connect any tool that speaks libSQL (TablePlus, Drizzle Studio, `@libsql/client`, Prisma, Drizzle ORM) to a local or Cloudflare-hosted SQLite database over HTTP:

   ```ts
   import { createClient } from '@libsql/client'

   const client = createClient({
     url: 'https://libsql.example.com',
     authToken: 'my-do-id:my-secret',
   })

   await client.execute('SELECT * FROM users')
   ```

2. **Cloudflare Durable Object support** — expose your DO's embedded SQLite to data explorers like [Drizzle Studio](https://github.com/drizzle-team/drizzle-orm) and TablePlus so you can browse, edit, and manage your DO storage from a GUI:

   ```ts
   import { DurableObject } from 'cloudflare:workers'
   import { createLibsqlHandler, durableObjectExecutor, type LibsqlHandler } from 'libsqlproxy'

   export class MyDO extends DurableObject {
     #hrana: LibsqlHandler

     constructor(ctx: DurableObjectState, env: Env) {
       super(ctx, env)
       this.#hrana = createLibsqlHandler(durableObjectExecutor(ctx.storage))
     }

     async hranaHandler(request: Request): Promise<Response> {
       return this.#hrana(request)
     }
   }
   ```

   The Worker proxy parses `Bearer namespace:secret` (split on last colon) and routes to the correct DO via RPC:

   ```ts
   import { createLibsqlProxy } from 'libsqlproxy'

   export default {
     async fetch(request: Request, env: Env) {
       const url = new URL(request.url)
       if (url.hostname.startsWith('libsql.')) {
         const proxy = createLibsqlProxy({
           secret: env.LIBSQL_SECRET,
           getStub: ({ namespace, env }) => {
             return env.MY_DO.get(env.MY_DO.idFromString(namespace))
           },
         })
         return proxy(request, env)
       }
       return new Response('Not found', { status: 404 })
     },
   }
   ```

3. **Node.js adapter** — wrap the fetch handler for `http.createServer()` with optional Bearer auth and configurable body size limit (default 10 MB):

   ```ts
   import http from 'node:http'
   import Database from 'libsql'
   import { createLibsqlHandler, createLibsqlNodeHandler, libsqlExecutor } from 'libsqlproxy'

   const handler = createLibsqlHandler(libsqlExecutor(new Database('my.db')))
   const nodeHandler = createLibsqlNodeHandler(handler, {
     auth: { bearer: 'my-secret' },
   })
   http.createServer(nodeHandler).listen(8080)
   ```

4. **Custom SQL driver support** — implement `LibsqlExecutor` for any database. Sync and async executors both work:

   ```ts
   const handler = createLibsqlHandler({
     executeSql(sql, params) {
       return myDriver.query(sql, params)
     },
     execRaw(sql) {
       myDriver.exec(sql)
     },
   })
   ```

5. **Full Hrana v2 protocol** — `execute`, `batch` (with `ok`/`error`/`not`/`and`/`or` conditions), `sequence`, `describe`, `store_sql`, `close_sql`, `close`. Baton-based stateful streams with unpredictable `crypto.randomUUID()` batons and 120s inactivity eviction.
