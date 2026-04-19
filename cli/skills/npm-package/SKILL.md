---
name: npm-package
description: >
  Opinionated TypeScript npm package template for ESM packages. Enforces
  src→dist builds with tsc, strict TypeScript defaults, explicit exports, and
  publish-safe package metadata. Use this when creating or updating any npm
  package in this repo.
version: 0.0.1
---

<!-- Purpose: canonical checklist for TypeScript npm package layout and publish config. -->

# npm-package

Use this skill when scaffolding or fixing npm packages.

## Package.json rules

1. Always set `"type": "module"`.
2. Always fill `"description"`.
3. Always include GitHub metadata:
   - `repository` with `type`, `url`, and `directory`
   - `homepage`
   - `bugs`
4. Always include meaningful `keywords`.
5. Always export `./package.json`.
6. Exports structure must include:
   - `"."` for runtime entrypoint (`dist`)
   - `"./src"` and `"./src/*"` pointing to `.ts` source files
7. In every export object, put `types` first.
   - For runtime exports (for example `"."`), point `types` to emitted
     declaration files in `dist`.
   - For source exports (`"./src"`, `"./src/*"`), point `types` to source
     files in `src` (not `./dist/*.d.ts`).
8. Always include `default` in exports.
9. `files` must include at least:
    - `src`
    - `dist`
    - any runtime-required extra files (for example `schema.prisma`)
    - `skills/` directory if the package ships an agent skill (see "Agent
      skill" section below). Skill files live at `skills/<name>/SKILL.md`,
      never at the package root.
    - if tests are inside src and gets included in dist, it's fine. don't try to exclude them
    - **Do NOT create package-level README.md files.** In workspaces, keep one
      README at the repository root. Package READMEs don't get read by anyone.
      The root README is the single source of truth for the whole project.
10. `scripts.build` should be `tsc && chmod +x dist/cli.js` (skip the chmod if
     the package has no bin). No bundling. Do not delete `dist/` in `build` by
     default because forcing a clean build on every local build can cause
     issues. Optionally include running scripts with `tsx` if needed to
     generate build artifacts.
11. `prepublishOnly` must always do the cleanup before `build` (optionally run
     generation before build when required). Always add this script:
     ```json
     { "prepublishOnly": "rimraf dist \"*.tsbuildinfo\" && pnpm build" }
     ```
     This ensures `dist/` is fresh before every `npm publish`, so deleted files
     do not accidentally stay in the published package. Use `rimraf` here
     instead of bare shell globs so the script behaves the same in zsh, bash,
     and Windows shells even when no `.tsbuildinfo` file exists.

## bin field

Use `bin` as a plain string pointing to the compiled entrypoint, not an object:

```json
{ "bin": "dist/cli.js" }
```

The bin file must be executable and start with a shebang. After creating or
building it, always run:

```bash
chmod +x dist/cli.js
```

Add the shebang as the first line of the source file (`src/cli.ts`):

```ts
#!/usr/bin/env node
```

`tsc` preserves the shebang in the emitted `.js` file. The `chmod +x` is
already part of the `build` script, so `prepublishOnly` still gets it through
`pnpm build` after the cleanup step.

## Reading package version at runtime

When Node code needs the package version, prefer reading it from `package.json`
via `createRequire`. This works cleanly in ESM packages without adding a JSON
import assertion.

```ts
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const packageJson = require("../package.json") as {
  version: string;
};

export const packageVersion = packageJson.version;
```

- Use a relative path from the current file to `package.json`.
- Read only the fields you need, usually `version`.
- Prefer this over hardcoding the version or duplicating it in source files.

## Resolving paths relative to the package

ESM does not have `__dirname`. Derive it from `import.meta.url` with the
`node:url` and `node:path` modules, then resolve relative paths from there.

```ts
import url from "node:url";
import path from "node:path";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));

// e.g. from src/cli.ts → read SKILL.md under skills/<name>/SKILL.md
// (skill files always live in skills/<name>/SKILL.md, never at the package root)
const skillPath = path.resolve(__dirname, "../skills/mypkg/SKILL.md");

// from dist/cli.js (after tsc) → reach back to src/
const srcFile = path.resolve(__dirname, "../src/template.md");
```

- Remember that `tsc` compiles `src/` → `dist/`. At runtime the file lives in
  `dist/`, so one `..` gets you back to the package root.
- From a file in `src/` during dev (running with `tsx`), `..` also reaches the
  package root since `src/` is one level deep.
- Use `path.resolve(__dirname, ...)` instead of string concatenation so it
  works on all platforms.

## Detecting development mode

Check whether `import.meta.url` ends with `.ts` or `.tsx`. In dev you run
source files directly (via `tsx` or `bun`), so the URL points to a `.ts` file.
After `tsc` builds to `dist/`, the URL ends with `.js`.

```ts
const isDev = import.meta.url.endsWith(".ts") || import.meta.url.endsWith(".tsx");
```

This is useful for conditionally resolving paths that differ between `src/` and
`dist/`, or enabling dev-only logging without relying on `NODE_ENV`.

## tsconfig rules

Use Node ESM-compatible compiler settings:

```json
{
  "compilerOptions": {
    "allowImportingTsExtensions": true,
    "rewriteRelativeImportExtensions": true,
    "rootDir": "src",
    "outDir": "dist",
    "module": "nodenext",
    "moduleResolution": "nodenext",
    "target": "ESNext",
    "lib": ["ESNext"],
    "declaration": true,
    "declarationMap": true,
    "noEmit": false,
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "skipLibCheck": true,
    "useUnknownInCatchVariables": false
  },
  "include": ["src"]
}
```

- Always use "rootDir": "src"
- Add `"DOM"` to `lib` only when browser globals are needed.
- Use `.ts` and `.tsx` extensions in source imports. `tsc` rewrites them to
  `.js` in the emitted `dist/` output automatically via
  `rewriteRelativeImportExtensions`. This means source code works directly in
  runtimes like `tsx`, `bun`, and frameworks like Next.js that expect `.ts`
  extensions, while the published `dist/` has correct `.js` imports that Node.js
  and other consumers resolve without issues.
  ```ts
  // source (src/index.ts) — use .ts/.tsx extensions
  import { helper } from './utils.ts'
  import { Button } from './button.tsx'

  // emitted output (dist/index.js) — tsc rewrites to .js
  // import { helper } from './utils.js'
  // import { Button } from './button.js'
  ```
- Only relative imports are rewritten. Path aliases (`paths` in tsconfig) are
  not supported by `rewriteRelativeImportExtensions` — this is fine since npm
  packages should use relative imports anyway.
- Requires TypeScript 5.7+.
- Install `@types/node` as a dev dependency whenever Node APIs are used.
- If generation is required, keep generators in `scripts/*.ts` and invoke them
  from package scripts before build/publish.

> IMPORTANT! always use rootDir src. if there are other root level folders that should be type checked you should create other tsconfig.json files inside those folder. DO NOT add other folders inside src or the dist/ will contain dist/src, dist/other-folder. which breaks imports. the tsconfig.json inside these other folders can be minimal, using noEmit true, declaration false. Because usually these folders do not need to be emitted or compiled. just type checked. tests should still be put inside src. other folders can be things like `scripts` or `fixtures`.

## Preferred exports template

```json
{
  "type": "module",
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    "./package.json": "./package.json",
    ".": {
      "types": "./dist/index.d.ts",
      "default": "./dist/index.js"
    },
    "./src": {
      "types": "./src/index.ts",
      "default": "./src/index.ts"
    },
    "./src/*": {
      "types": "./src/*.ts",
      "default": "./src/*.ts" // or .tsx for packages that export React components. if so all files should end with .tsx
    }
  }
}
```


## Package.json `imports` map (internal `#` aliases)

Use `imports` when you need a package to swap between different implementations
based on runtime (Node vs Bun vs browser vs SQLite vs better-sqlite3, etc.).
Internal imports are `#`-prefixed, scoped to the package itself, and never
leak to consumers. Consumers resolve through `exports`, not `imports`.

### Point `types` at `dist`, not `src`

The TypeScript docs are explicit about this:

> If the package.json is part of the local project, an additional remapping
> step is performed in order to find the **input** TypeScript implementation
> file... This remapping uses the `outDir`/`declarationDir` and `rootDir`
> from the tsconfig.json, so using `"imports"` usually requires an explicit
> `rootDir` to be set.
>
> This variation allows package authors to write `"imports"` and `"exports"`
> fields that reference only the compilation outputs that will be published
> to npm, while still allowing local development to use the original
> TypeScript source files.

In other words, TypeScript automatically walks from `./dist/foo.d.ts` back
to `./src/foo.ts` using `outDir` → `rootDir` during compilation. You do not
need to point `types` at `src` manually — **let TypeScript remap it**.

```json
{
  "imports": {
    "#sqlite": {
      "bun": "./src/platform/bun/sqlite.ts",
      "node": {
        "types": "./dist/platform/node/sqlite.d.ts",
        "default": "./dist/platform/node/sqlite.js"
      },
      "default": {
        "types": "./dist/platform/node/sqlite.d.ts",
        "default": "./dist/platform/node/sqlite.js"
      }
    }
  }
}
```

Resolution flow when `tsc` sees `import db from '#sqlite'`:

1. `imports["#sqlite"].node.types` → `./dist/platform/node/sqlite.d.ts`
2. package.json is in the local project → apply the remap.
3. Replace `outDir` (`dist`) with `rootDir` (`src`) → `./src/platform/node/sqlite.d.ts`
4. Replace `.d.ts` with the source extension `.ts` → `./src/platform/node/sqlite.ts`
5. Return `./src/platform/node/sqlite.ts` (it exists on a fresh clone, no build needed).
6. Otherwise fall back to `./dist/platform/node/sqlite.d.ts`.

### Why dist-first is correct

- **No chicken-and-egg.** The remap is compile-time, so `tsc` works on a fresh
  clone without `dist/` existing yet.
- **Published map describes shipped files.** Every `imports` entry points at
  something that will actually be in the npm tarball. No stale src paths
  leaking into the published package.json.
- **Works under plain Node.** If the package is loaded by Node without
  TypeScript involvement, Node reads the same `imports` map at runtime and
  resolves to real `dist/*.js` files that exist.
- **Bun / browser runtime conditions can still point at `src`**, because
  those runtimes execute `.ts` directly and skip the build step.

### Requirements

This only works when:

- `moduleResolution` is `node16`, `nodenext`, or `bundler`
- `rootDir` is set explicitly in `tsconfig.json` (the skill's tsconfig rules
  already require `"rootDir": "src"`)
- `outDir` is set (already in the template)
- `resolvePackageJsonImports` is not disabled (it is on by default for the
  supported `moduleResolution` modes)

### Anti-pattern: pointing `types` at `src` manually

```json
{
  "imports": {
    "#sqlite": {
      "node": {
        "types": "./src/platform/node/sqlite.ts",   // ❌ don't do this
        "default": "./dist/platform/node/sqlite.js"
      }
    }
  }
}
```

This works but:

1. The published `package.json` advertises `src/*.ts` paths that may or may
   not exist depending on what you include in `files`.
2. It bypasses TypeScript's built-in remapping, which is the whole point of
   the local-project `imports` feature.
3. It is inconsistent with `default` — mixing source (for types) and dist
   (for runtime) paths in the same entry is easy to get wrong.

Source of truth: [TypeScript Modules Reference — package.json "imports" and self-name imports](https://www.typescriptlang.org/docs/handbook/modules/reference.html#packagejson-imports-and-self-name-imports).

## tests location

test files should be close with the associated source files. for example if you have an utils.ts file you will create utils.test.ts file next to it. with tests, importing from utils. preferred testing framework is vitest (or bun if project already using `bun test` or depends on bun APIs, rare)


## Agent skill

If the package ships an agent skill (SKILL.md for AI coding agents), place it
at:

```
skills/<package-name>/SKILL.md
```

Never put `SKILL.md` at the package root. The `skills/<name>/SKILL.md` layout
matches the convention used by the [`skills`](https://skills.sh) CLI so users
can install it with:

```bash
npx -y skills add owner/repo
```

Add this installation snippet to the README so users know how to get the skill:

```markdown
## Agent Skill

This package ships a skill file that teaches AI coding agents how and when to
use it. Install it with:

\`\`\`bash
npx -y skills add owner/repo
\`\`\`
```

Remember to add `skills` to the `files` array in `package.json` so the skill
directory is included when publishing.

### Keep the SKILL.md thin

The SKILL.md body should be a **few lines**, not a full docs dump. Put all
real documentation in `README.md` (which already lives in `files`) and have
the skill tell the agent to fetch it. This way agents always read the latest
docs and the skill never goes stale.

The body stays thin, but the **frontmatter `description` must be rich**. It
is what the agent sees in its main context, and it is the only signal the
agent uses to decide whether to load the skill. Make it long enough to
cover: what the package is, the core concepts and APIs, concrete trigger
phrases the user might say, and explicit "ALWAYS load this skill when..."
conditions. A one-sentence description is almost always too short. See the
`new-skill` skill for full guidance on writing descriptions.

**CLI package template:**

```md
---
name: mypkg
description: |
  mypkg is <what it does and the core concepts>. It exposes <main commands
  or APIs> and is used for <typical tasks>. ALWAYS load this skill when
  the user mentions mypkg, runs <binary>, edits files that import mypkg,
  or asks about <trigger keywords>. Load it before writing any code that
  touches mypkg so you know the correct usage patterns and gotchas.
---

# mypkg

Every time you use mypkg, you MUST run:

\`\`\`bash
mypkg --help # NEVER pipe to head/tail, read the full output
\`\`\`
```

**Library package template:**

```md
---
name: mypkg
description: |
  mypkg is <what it does and the core concepts>. It exports <main APIs>
  and is used for <typical tasks>. ALWAYS load this skill when the user
  mentions mypkg, imports from mypkg, edits files that depend on it, or
  asks about <trigger keywords>. Load it before writing any code that
  touches mypkg so you know the correct usage patterns and gotchas.
---

# mypkg

Every time you work with mypkg, you MUST fetch the latest README:

\`\`\`bash
curl -s https://raw.githubusercontent.com/owner/repo/main/README.md # NEVER pipe to head/tail
\`\`\`
```

Because the SKILL.md body points at the README, the README must contain
everything the agent needs: API reference, examples, gotchas, and rules.
See the `new-skill` skill for the full pattern.

## pnpm workspaces

When the project is a monorepo, use pnpm workspaces with flat `./*` glob paths
in `pnpm-workspace.yaml`. All packages live at the repo root as siblings, no
nested `packages/` directory:

```yaml
packages:
  - ./*
```

This means the repo looks like:

```
my-monorepo/
  package.json        # root (private: true)
  pnpm-workspace.yaml
  cli/                # workspace package
  website/            # workspace package
  db/                 # workspace package
  errore/             # workspace package (submodule)
```

### Common dev dependencies at root

Install shared dev tooling **only at the root** `package.json` so every
workspace package uses the same version without duplicating installs:

```json
{
  "private": true,
  "devDependencies": {
    "typescript": "^5.9.2",
    "tsx": "^4.20.5",
    "vitest": "^3.2.4",
    "oxfmt": "^0.24.0"
  }
}
```

Packages that need these tools (like `tsc` or `vitest`) will resolve them
from the root `node_modules` via pnpm's hoisting. Do **not** add
`typescript`, `tsx`, `vitest`, or `oxfmt` as devDependencies in individual
workspace packages — only add them at root.

Package-specific dev dependencies (for example `@types/node`, `rimraf`,
`prisma`) still go in each package's own `devDependencies`.

### Cross-workspace dependencies

Use `workspace:^` (not `workspace:*`) for local package versions so that
when published, the dependency resolves to a caret range instead of a pinned
version:

```json
{
  "dependencies": {
    "my-utils": "workspace:^"
  }
}
```

Use `pnpm install package@workspace:^` to add a workspace dependency, or
add it to `package.json` manually with the `workspace:^` protocol.

## CI (GitHub Actions)

Standard CI workflow for pnpm workspace monorepos. Key points:

- **Checkout submodules** with `submodules: recursive` if the repo uses git
  submodules (common for shared libraries like errore).
- **Use `pnpm/action-setup@v4`** with the pnpm version matching your lockfile.
- **Use Node 24** (or latest LTS) via `actions/setup-node@v4` with `cache: pnpm`.
- **Build workspace packages** that export from `dist/` before running tests,
  since submodules and some packages have `dist/` gitignored.
- **Run tests from the package directory**, not root.

Example `.github/workflows/ci.yml`:

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  test:
    name: Tests
    runs-on: ubuntu-latest
    timeout-minutes: 30

    steps:
      - uses: actions/checkout@v4
        with:
          submodules: recursive

      - uses: pnpm/action-setup@v4
        with:
          version: 9

      - uses: actions/setup-node@v4
        with:
          node-version: 24
          cache: pnpm

      - name: Install dependencies
        run: pnpm install

      # Submodules and workspace packages with dist/ gitignored
      # need to be built after checkout before anything can import them.
      - name: Build workspace packages with dist/ exports
        run: |
          pnpm --filter my-lib run build
          pnpm --filter my-utils run build

      - name: Run tests
        run: pnpm test -- --run
        working-directory: cli
```

If the repo has Prisma schemas, add generate steps before tests:

```yaml
      - name: Generate Prisma client
        run: pnpm generate
        working-directory: cli
```

## .gitignore

For non-workspace (standalone) packages, always create a `.gitignore` with:

```
node_modules
dist
*.tsbuildinfo
.DS_Store
```

Workspace packages inside a monorepo inherit the root `.gitignore`, so this only applies to standalone packages.


## common mistakes

- if you need to use zod always use latest version
- always install packages as dev dependencies if used only for scripts, testing or types only
- if the package uses `rimraf` in scripts, install it as a dev dependency instead of relying on platform-specific shell behavior
