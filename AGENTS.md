
# Project Coding Guidelines

NOTICE: This file is generated using AGENTS.sh and should NEVER be manually updated.

This file contains all coding guidelines and standards for this project.

---


when summarizing changes at the end of the message, be super short, a few words and in bullet points, use bold text to highlight important keywords. use markdown.

please ask questions and confirm assumptions before generating complex architecture code.

NEVER run commands with & at the end to run them in the background. this is leaky and harmful! instead ask me to run commands in the background if needed.

NEVER commit yourself unless asked to do so. I will commit the code myself.

NEVER add comments unless I tell you

## files

always use kebab case for new filenames. never use uppercase letters in filenames

---

# typescript

- ALWAYS use normal imports instead of dynamic imports, unless there is an issue with es module only packages and you are in a commonjs package (this is rare).

- use a single object argument instead of multiple positional args: use object arguments for new typescript functions if the function would accept more than one argument, so it is more readable, ({a,b,c}) instead of (a,b,c). this way you can use the object as a sort of named argument feature, where order of arguments does not matter and it's easier to discover parameters.

- always add the {} block body in arrow functions: arrow functions should never be written as `onClick={(x) => setState('')}`. NEVER. instead you should ALWAYS write `onClick={() => {setState('')}}`. this way it's easy to add new statements in the arrow function without refactoring it.

- minimize useless comments: do not add useless comments if the code is self descriptive. only add comments if requested or if this was a change that i asked for, meaning it is not obvious code and needs some inline documentation. if a comment is required because the part of the code was result of difficult back and forth with me, keep it very short.

- ALWAYS add all information encapsulated in my prompt to comments: when my prompt is super detailed and in depth, all this information should be added to comments in your code. this is because if the prompt is very detailed it must be the fruit of a lot of research. all this information would be lost if you don't put it in the code. next LLM calls would misinterpret the code and miss context.

- NEVER write comments that reference changes between previous and old code generated between iterations of our conversation. do that in prompt instead. comments should be used for information of the current code. code that is deleted does not matter.

- use early returns (and breaks in loops): do not nest code too much. follow the go best practice of if statements: avoid else, nest as little as possible, use top level ifs. minimize nesting. instead of doing `if (x) { if (b) {} }` you should do `if (x && b) {};` for example. you can always convert multiple nested ifs or elses into many linear ifs at one nesting level. use the @think tool for this if necessary.

- typecheck after updating code: after any change to typescript code ALWAYS run the `pnpm typecheck` script of that package, or if there is no typecheck script run `pnpm tsc` yourself

- do not use any: you must NEVER use any. if you find yourself using `as any` or `:any`, use the @think tool to think hard if there are types you can import instead. do even a search in the project for what the type could be. any should be used as a last resort.

- NEVER do `(x as any).field` or `'field' in x` before checking if the code compiles first without it. the code probably doesn't need any or the in check. even if it does not compile, use think tool first! before adding (x as any).something, ALWAYS read the .d.ts to understand the types

- after any change to typescript code ALWAYS run the `pnpm typecheck` script of that package, or if there is no typecheck script run `pnpm tsc` yourself

- do not declare uninitialized variables that are defined later in the flow. instead use an IIFE with returns. this way there is less state. also define the type of the variable before the iife. here is an example:

- use || over in: avoid 'x' in obj checks. prefer doing `obj?.x || ''` over doing `'x' in obj ? obj.x : ''`. only use the in operator if that field causes problems in typescript checks because typescript thinks the field is missing, as a last resort.

- when creating urls from a path and a base url, prefer using `new URL(path, baseUrl).toString()` instead of normal string interpolation. use type-safe react-router `href` or spiceflow `this.safePath` (available inside routes) if possible

- for node built-in imports, never import singular names. instead do `import fs from 'node:fs'`, same for path, os, etc.

- NEVER start the development server with pnpm dev yourself. there is no reason to do so, even with &

- if you encounter typescript lint errors for an npm package, read the node_modules/package/\*.d.ts files to understand the typescript types of the package. if you cannot understand them, ask me to help you with it.

```ts
// BAD. DO NOT DO THIS
let favicon: string | undefined
if (docsConfig?.favicon) {
    if (typeof docsConfig.favicon === 'string') {
        favicon = docsConfig.favicon
    } else if (docsConfig.favicon?.light) {
        // Use light favicon as default, could be enhanced with theme detection
        favicon = docsConfig.favicon.light
    }
}
// DO THIS. use an iife. Immediately Invoked Function Expression
const favicon: string = (() => {
    if (!docsConfig?.favicon) {
        return ''
    }
    if (typeof docsConfig.favicon === 'string') {
        return docsConfig.favicon
    }
    if (docsConfig.favicon?.light) {
        // Use light favicon as default, could be enhanced with theme detection
        return docsConfig.favicon.light
    }
    return ''
})()
// if you already know the type use it:
const favicon: string = () => {
    // ...
}
```

- when a package has to import files from another packages in the workspace never add a new tsconfig path, instead add that package as a workspace dependency using `pnpm i "package@workspace:*"`

## typescript

NEVER use require. always esm imports

always try to use non-relative imports. each package has an absolute import with the package name, you can find it in the tsconfig.json paths section. for example, paths inside website can be imported from website. notice these paths also need to include the src directory.

this is preferable to other aliases like @/ because i can easily move the code from one package to another without changing the import paths. this way you can even move a file and import paths do not change much.

always specify the type when creating arrays, especially for empty arrays. if you don't, typescript will infer the type as `never[]`, which can cause type errors when adding elements later.

**Example:**

```ts
// BAD: Type will be never[]
const items = []

// GOOD: Specify the expected type
const items: string[] = []
const numbers: number[] = []
const users: User[] = []
```

remember to always add the explicit type to avoid unexpected type inference.

---

# package manager: pnpm with workspace

this project uses pnpm workspaces to manage dependencies. important scripts are in the root package.json or various packages' package.json

try to run commands inside the package folder that you are working on. for example you should never run `pnpm test` from the root

if you need to install packages always use pnpm

instead of adding packages directly in package.json use `pnpm install package` inside the right workspace folder. NEVER manually add a package by updating package.json

## fixing duplicate pnpm dependencies

sometimes typescript will fail if there are 2 duplicate packages in the workspace node_modules. this can happen in pnpm if a package is used in 2 different places (even if inside a node_module package, transitive dependency) with a different set of versions for a peer dependency

for example if better-auth depends on zod peer dep and zod is in different versions in 2 dependency subtrees

to identify if a pnpm package is duplicated, search for the string " packagename@" inside `pnpm-lock.yaml`, notice the space in the search string. then if the result returns multiple instances with a different set of peer deps inside the round brackets, it means that this package is being duplicated. here is an example of a package getting duplicated:

```

  better-auth@1.3.6(react-dom@19.1.1(react@19.1.1))(react@19.1.1)(zod@3.25.76):
    dependencies:
      '@better-auth/utils': 0.2.6
      '@better-fetch/fetch': 1.1.18
      '@noble/ciphers': 0.6.0
      '@noble/hashes': 1.8.0
      '@simplewebauthn/browser': 13.1.2
      '@simplewebauthn/server': 13.1.2
      better-call: 1.0.13
      defu: 6.1.4
      jose: 5.10.0
      kysely: 0.28.5
      nanostores: 0.11.4
      zod: 3.25.76
    optionalDependencies:
      react: 19.1.1
      react-dom: 19.1.1(react@19.1.1)

  better-auth@1.3.6(react-dom@19.1.1(react@19.1.1))(react@19.1.1)(zod@4.0.17):
    dependencies:
      '@better-auth/utils': 0.2.6
      '@better-fetch/fetch': 1.1.18
      '@noble/ciphers': 0.6.0
      '@noble/hashes': 1.8.0
      '@simplewebauthn/browser': 13.1.2
      '@simplewebauthn/server': 13.1.2
      better-call: 1.0.13
      defu: 6.1.4
      jose: 5.10.0
      kysely: 0.28.5
      nanostores: 0.11.4
      zod: 4.0.17
    optionalDependencies:
      react: 19.1.1
      react-dom: 19.1.1(react@19.1.1)

```

as you can see, better-auth is listed twice with different sets of peer deps. in this case it's because of zod being in version 3 and 4 in two subtrees of our workspace dependencies.

as a first step, try running `pnpm dedupe better-auth` with your package name and see if there is still the problem.

below i will describe how to generally deduplicate a package. i will use zod as an example. it works with any dependency found in the previous step.

to deduplicate the package, we have to make sure we only have 1 version of zod installed in your workspace. DO NOT use overrides for this. instead, fix the problem by manually updating the dependencies that are forcing the older version of zod in the dependency tree.

to do so, we first have to run the command `pnpm -r why zod@3.25.76` to see the reason the older zod version is installed. in this case, the result is something like this:

```

website /Users/morse/Documents/GitHub/holocron/website (PRIVATE)

dependencies:
@better-auth/stripe 1.2.10
├─┬ better-auth 1.3.6
│ └── zod 3.25.76 peer
└── zod 3.25.76
db link:../db
└─┬ docs-website link:../docs-website
  ├─┬ fumadocs-docgen 2.0.1
  │ └── zod 3.25.76
  ├─┬ fumadocs-openapi link:../fumadocs/packages/openapi
  │ └─┬ @modelcontextprotocol/sdk 1.17.3
  │   ├── zod 3.25.76
  │   └─┬ zod-to-json-schema 3.24.6
  │     └── zod 3.25.76 peer
  └─┬ searchapi link:../searchapi
    └─┬ agents 0.0.109
      ├─┬ @modelcontextprotocol/sdk 1.17.3
      │ ├── zod 3.25.76
      │ └─┬ zod-to-json-schema 3.24.6
      │   └── zod 3.25.76 peer
      └─┬ ai 4.3.19
        ├─┬ @ai-sdk/provider-utils 2.2.8
        │ └── zod 3.25.76 peer
        └─┬ @ai-sdk/react 1.2.12
          ├─┬ @ai-sdk/provider-utils 2.2.8
          │ └── zod 3.25.76 peer
          └─┬ @ai-sdk/ui-utils 1.2.11
            └─┬ @ai-sdk/provider-utils 2.2.8
              └── zod 3.25.76 peer
```

here we can see zod 3 is installed because of @modelcontextprotocol/sdk, @better-auth/stripe and agents packages. to fix the problem, we can run

```
pnpm update -r --latest  @modelcontextprotocol/sdk @better-auth/stripe agents
```

this way, if these packages include the newer version of the dependency, zod will be deduplicated automatically.

in this case, we could have only updated @better-auth/stripe to fix the issue too, that's because @better-auth/stripe is the one that has better-auth as a peer dep. but finding what is the exact problematic package is difficult, so it is easier to just update all packages you notice that we depend on directly in our workspace package.json files.

if after doing this we still have duplicate packages, you will have to ask the user for help. you can try deleting the node_modules and restarting the approach, but it rarely helps.

---

## sentry

this project uses sentry to notify about unexpected errors.

the website folder will have a src/lib/errors.ts file with an exported function `notifyError(error: Error, contextMessage: string)`.

you should ALWAYS use notifyError in these cases:

- create a new spiceflow api app, put notifyError in the onError callback with context message including the api route path
- suppressing an error for operations that can fail. instead of doing console.error(error) you should instead call notifyError
- wrapping a promise with cloudflare `waitUntil`. add a .catch and a notifyError so errors are tracked

this function will add the error in sentry so that the developer is able to track users' errors

## errors.ts file

if a package is missing the errors.ts file, here is the template for adding one.

notice that

- dsn should be replaced by the user with the right one. ask to do so
- use the sentries npm package, this handles correctly every environment like Bun, Node, Browser, etc

```tsx
import { captureException, flush, init } from "sentries";

init({
  dsn: "https://e702f9c3dff49fd1aa16500c6056d0f7@o4509638447005696.ingest.de.sentry.io/4509638454476880",
  integrations: [],
  tracesSampleRate: 0.01,
  profilesSampleRate: 0.01,
  beforeSend(event) {
    if (process.env.NODE_ENV === "development") {
      return null;
    }
    if (process.env.BYTECODE_RUN) {
      return null;
    }
    if (event?.["name"] === "AbortError") {
      return null;
    }

    return event;
  },
});

export async function notifyError(error: any, msg?: string) {
  console.error(msg, error);
  captureException(error, { extra: { msg } });
  await flush(1000);
}

export class AppError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AppError";
  }
}
```

## app error

every time you throw a user-readable error you should use AppError instead of Error

AppError messages will be forwarded to the user as is. normal Error instances instead could have their messages obfuscated


---

# testing

do not write new test files unless asked. do not write tests if there is not already a test or describe block for that function or module.

tests should validate complex and non-obvious logic. if a test looks like a placeholder, do not add it.

use vitest to run tests. tests should be run from the current package directory and not root. try using the test script instead of vitest directly. additional vitest flags can be added at the end, like --run to disable watch mode or -u to update snapshots.

to understand how the code you are writing works, you should add inline snapshots in the test files with expect().toMatchInlineSnapshot(), then run the test with `pnpm test -u --run` or `pnpm vitest -u --run` to update the snapshot in the file, then read the file again to inspect the result. if the result is not expected, update the code and repeat until the snapshot matches your expectations. never write the inline snapshots in test files yourself. just leave them empty and run `pnpm test -u --run` to update them.

> always call `pnpm vitest` or `pnpm test` with `--run` or they will hang forever waiting for changes!
> ALWAYS read back the test if you use the `-u` option to make sure the inline snapshots are as you expect.

- for very long snapshots you should use `toMatchFileSnapshot(filename)` instead of `toMatchInlineSnapshot()`. put the snapshot files in a snapshots/ directory and use the appropriate extension for the file based on the content

never test client react components. only server code that runs on the server.

most tests should be simple calls to functions with some expect calls, no mocks. test files should be called the same as the file where the tested function is being exported from.

NEVER use mocks. the database does not need to be mocked, just use it. simply do not test functions that mutate the database if not asked.

tests should strive to be as simple as possible. the best test is a simple `.toMatchInlineSnapshot()` call. these can be easily evaluated by reading the test file after the run passing the -u option. you can clearly see from the inline snapshot if the function behaves as expected or not.

try to use only describe and test in your tests. do not use beforeAll, before, etc if not strictly required.

NEVER write tests for react components or react hooks. NEVER write tests for react components. you will be fired if you do.

sometimes tests work directly on database data, using prisma. to run these tests you have to use the package.json script, which will call `doppler run -- vitest` or similar. never run doppler cli yourself as you could delete or update production data. tests generally use a staging database instead.

never write tests yourself that call prisma or interact with database or emails. for these, ask the user to write them for you.

---

## reading github repositories

you can use gitchamber.com to read repo files. run `curl https://gitchamber.com` to see how the API works. always use curl to fetch the responses of gitchamber.com

### vercel ai sdk documentation

when working with the vercel ai sdk, you can fetch the latest docs using:
https://gitchamber.com/repos/vercel/ai/main/files

use gitchamber to read the .md files using curl

you can swap out the topic with text you want to search docs for. you can also limit the total results returned with the param token to limit the tokens that will be added to the context window

---

## changelog

after you make a change that is noteworthy, add an entry in the CHANGELOG.md file in the root of the package. there are 2 kinds of packages, public and private packages. private packages have a private: true field in package.json, public packages do not and instead have a version field in package.json. public packages are the ones that are published to npm.

to write a changelog.md file for a public package, use the following format, add a heading with the new version and a bullet list of your changes, like this:

```md
## 0.1.3

### Patch Changes

- bug fixes

## 0.1.2

### Patch Changes

- add support for githubPath
```

for private packages, which do not have versions, you must instead use the current date and time, for example:

```md
# Changelog

## 2025-01-24 19:50

- Added a feature to improve user experience
- Fixed a bug that caused the app to crash on startup
```

these are just examples. be clear and concise in your changelog entries.

use present tense. be detailed but concise, omit useless verbs like "implement", "added", just put the subject there instead, so it is shorter. it's implicit we are adding features or fixes. do not use nested bullet points. always show example code snippets if applicable, and use proper markdown formatting.

```

the website package has a dependency on docs-website. instead of duplicating code that is needed both in website and docs-website keep a file in docs-website instead and import from there for the website package.

---

## writing docs

when generating a .md or .mdx file to document things, always add a frontmatter with title and description. also add a prompt field with the exact prompt used to generate the doc. use @ to reference files and urls and provide any context necessary to be able to recreate this file from scratch using a model. if you used urls also reference them. reference all files you had to read to create the doc. use yaml | syntax to add this prompt and never go over the column width of 80

---

## cac for cli development

the cli uses cac npm package.

notice that if you add a route in the spiceflow server you will need to run `pnpm --filter website gen-client` to update the apiClient inside cli.


---

## styling

- always use tailwind for styling. prefer using simple styles using flex and gap. margins should be avoided, instead use flexbox gaps, grid gaps, or separate spacing divs.

- use shadcn theme colors instead of tailwind default colors. this way there is no need to add `dark:` variants most of the time.

- `flex flex-col gap-3` is preferred over `space-y-3`. same for the x direction.

- try to keep styles as simple as possible, for breakpoints too.

- to join many classes together use the `cn('class-1', 'class-2')` utility instead of `${}` or other methods. this utility is usually used in shadcn-compatible projects and mine is exported from `website/src/lib/cn` usually. prefer doing `cn(bool && 'class')` instead of `cn(bool ? 'class' : '')`

- prefer `size-4` over `w-4 h-4`

## components

this project uses shadcn components placed in the website/src/components/ui folder. never add a new shadcn component yourself by writing code. instead use the shadcn cli installed locally.

try to reuse these available components when you can, for example for buttons, tooltips, scroll areas, etc.

---

## tailwind v4

this project uses tailwind v4. this new tailwind version does not use tailwind.config.js. instead it does all configuration in css files.

read https://tailwindcss.com/docs/upgrade-guide to understand the updates landed in tailwind v4 if you do not have tailwind v4 in your training context. ignore the parts that talk about running the upgrade cli. this project already uses tailwind v4 so no need to upgrade anything.

---

## calling the server from the client

for simple routes that only have one interaction in the page, for example a form page, you should use react-router forms and actions to interact with the server.

but when you do interactions from a component that can be rendered from multiple routes, or simply is not implemented inside a route page, you should use spiceflow client instead.

the website exposes an API via spiceflow. here is spiceflow docs: https://getspiceflow.com/

> ALWAYS use the fetch tool to get the latest docs if you need to implement a new route in a spiceflow API app server or need to add a new rpc call with a spiceflow api client!

spiceflow has support for client-side type-safe rpc. use this client when you need to interact with the server from the client, for example for a settings save deep inside a component. here is example usage of it

> SUPER IMPORTANT! if you add a new route to a spiceflow app, use the spiceflow app state like `userId` to add authorization to the route. if there is no state then you can use functions like `getSession({request})` or similar.
> make sure the current userId has access to the fetched or updated rows. this can be done by checking that the parent row or current row has a relation with the current userId. for example `prisma.site.findFirst({where: {users: {some: {userId }}}})`

> IMPORTANT! spiceflow api client cannot be called server side to call a route! In that case instead you MUST call the server functions used in the route directly, otherwise the server would do fetch requests that would fail!

always use `const {data, error} = await apiClient...` when calling spiceflow rpc. if data is already declared, give it a different name with `const {data: data2, error} = await apiClient...`. this pattern of destructuring is preferred for all apis that return data and error object fields.

## getting spiceflow docs

spiceflow is a little-known api framework. if you add server routes to a file that includes spiceflow in the name or you are using the apiClient rpc, you always need to fetch the spiceflow docs first, using the @fetch tool on https://getspiceflow.com/

this url returns a single long documentation that covers your use case. always fetch this document so you know how to use spiceflow. spiceflow is different from hono and other api frameworks, that's why you should ALWAYS fetch the docs first before using it


---

## ai sdk

i use the vercel ai sdk to interact with LLMs, also known as the npm package `ai`. never use the openai sdk or provider-specific sdks, always use the vercel ai sdk, npm package `ai`. streamText is preferred over generateText, unless the model used is very small and fast and the current code doesn't care about streaming tokens or showing a preview to the user. `streamObject` is also preferred over generateObject.

ALWAYS fetch the latest docs for the ai sdk using this url with curl:
https://gitchamber.com/repos/vercel/ai/main/files

use gitchamber to read the .md files using curl

you can swap out the topic with text you want to search docs for. you can also limit the total results returned with the param token to limit the tokens that will be added to the context window

---

## playwright

you can control the browser using the playwright mcp tools. these tools let you control the browser to get information or accomplish actions

if i ask you to test something in the browser, know that the website dev server is already running at http://localhost:7664 for website and :7777 for docs-website (but docs-website needs to use the website domain specifically, for example name-hash.localhost:7777)

---

## zod

use zod to create schemas and types that need to be used for tool inputs or spiceflow API routes.

when you need to create a complex type that comes from a prisma table, do not create a new schema that tries to recreate the prisma table structure. instead just use `z.any() as ZodType<PrismaTable>)` to get type safety but leave any in the schema. this gets most of the benefits of zod without having to define a new zod schema that can easily go out of sync.

---

