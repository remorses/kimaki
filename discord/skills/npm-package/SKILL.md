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
7. In every export object, put `types` first and point it to `.d.ts` files
   when emitting build output.
8. Always include `default` in exports.
9. `files` must include at least:
   - `src`
   - `dist`
   - any runtime-required extra files (for example `schema.prisma`)
   - docs like `README.md` and `CHANGELOG.md`
10. `scripts.build` should be only `tsc` and no bundling. Optionall include running scripts with tsx if needed to generate build artifacts.
11. `prepublishOnly` must always run `build` (optionally run generation before
    build when required).

## tsconfig rules

Use Node ESM-compatible compiler settings:

```json
{
  "compilerOptions": {
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

- Add `"DOM"` to `lib` only when browser globals are needed.
- Keep source imports with `.js` extensions in TypeScript ESM files.
- Install `@types/node` as a dev dependency whenever Node APIs are used.
- If generation is required, keep generators in `scripts/*.ts` and invoke them
  from package scripts before build/publish.

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
      "types": "./dist/index.d.ts",
      "default": "./src/index.ts"
    },
    "./src/*": {
      "types": "./dist/*.d.ts",
      "default": "./src/*.ts" // or .tsx for packages that export React components. if so all files should end with .tsx
    }
  }
}
```
