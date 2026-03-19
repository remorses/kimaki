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
   - docs like `README.md` and `CHANGELOG.md`
   - if tests are inside src and gets included in dist, it's fine. don't try to exclude them
10. `scripts.build` should be `rm -rf dist *.tsbuildinfo && tsc && chmod +x dist/cli.js` (skip the chmod
     if the package has no bin). No bundling. We remove dist to cleanup old transpiled files. Also pass tsbuildinfo to remove also the tsc incremental compilation state. Without that tsc would not generate again files to dist.
     Optionally include running scripts with tsx if needed to generate build artifacts.
11. `prepublishOnly` must always run `build` (optionally run generation before
     build when required). Always add this script:
     ```json
     { "prepublishOnly": "pnpm build" }
     ```
     This ensures `dist/` is fresh before every `npm publish`.

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
already part of the `build` script, so `prepublishOnly: "pnpm build"` handles
it automatically.

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

// e.g. from src/cli.ts → read SKILL.md at the package root
const skillPath = path.resolve(__dirname, "../SKILL.md");

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
- Requires TypeScript 5.7+. Pin the typescript devDependency to at least `5.7.0`.
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


## tests location

test files should be close with the associated source files. for example if you have an utils.ts file you will create utils.test.ts file next to it. with tests, importing from utils. preferred testing framework is vitest (or bun if project already using `bun test` or depends on bun APIs, rare)


## common mistakes

- if you need to use zod always use latest version
- always install packages as dev dependencies if used only for scripts, testing or types only
