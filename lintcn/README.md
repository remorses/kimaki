# lintcn

The [shadcn](https://ui.shadcn.com) for type-aware TypeScript lint rules. Powered by [tsgolint](https://github.com/oxc-project/tsgolint).

Add rules by URL, own the source, customize freely. Rules are Go files that use the TypeScript type checker for deep analysis — things ESLint can't do.

## Install

```bash
npm install -D lintcn
```

## Usage

```bash
# Add a rule by URL
npx lintcn add https://github.com/user/repo/blob/main/rules/no_unhandled_error.go

# Lint your project
npx lintcn lint

# Lint with a specific tsconfig
npx lintcn lint --tsconfig tsconfig.build.json

# List installed rules
npx lintcn list

# Remove a rule
npx lintcn remove no-unhandled-error
```

## How it works

Rules live as `.go` files in `.lintcn/` at your project root. You own the source — edit, customize, delete.

```
my-project/
├── .lintcn/
│   ├── .gitignore                      ← ignores generated Go files
│   ├── no_unhandled_error.go           ← your rule (committed)
│   └── no_unhandled_error_test.go      ← its tests (committed)
├── src/
│   ├── index.ts
│   └── ...
├── tsconfig.json
└── package.json
```

When you run `npx lintcn lint`, the CLI:

1. Scans `.lintcn/*.go` for rule definitions
2. Generates a Go workspace with all 50+ built-in tsgolint rules + your custom rules
3. Compiles a custom binary (cached — rebuilds only when rules change)
4. Runs the binary against your project

## Writing a rule

Every rule is a Go file with `package lintcn` that exports a `rule.Rule` variable.

Here's a rule that errors when you discard the return value of a function that returns `Error | T` — enforcing the [errore](https://errore.org) pattern:

```go
// lintcn:name no-unhandled-error
// lintcn:description Disallow discarding Error-typed return values

package lintcn

import (
    "github.com/microsoft/typescript-go/shim/ast"
    "github.com/microsoft/typescript-go/shim/checker"
    "github.com/typescript-eslint/tsgolint/internal/rule"
    "github.com/typescript-eslint/tsgolint/internal/utils"
)

var NoUnhandledErrorRule = rule.Rule{
    Name: "no-unhandled-error",
    Run: func(ctx rule.RuleContext, options any) rule.RuleListeners {
        return rule.RuleListeners{
            ast.KindExpressionStatement: func(node *ast.Node) {
                expression := ast.SkipParentheses(node.AsExpressionStatement().Expression)

                if ast.IsVoidExpression(expression) {
                    return // void = intentional discard
                }

                innerExpr := expression
                if ast.IsAwaitExpression(innerExpr) {
                    innerExpr = ast.SkipParentheses(innerExpr.Expression())
                }
                if !ast.IsCallExpression(innerExpr) {
                    return
                }

                t := ctx.TypeChecker.GetTypeAtLocation(expression)

                if utils.IsTypeFlagSet(t, checker.TypeFlagsVoid|checker.TypeFlagsUndefined|checker.TypeFlagsNever) {
                    return
                }

                for _, part := range utils.UnionTypeParts(t) {
                    if utils.IsErrorLike(ctx.Program, ctx.TypeChecker, part) {
                        ctx.ReportNode(node, rule.RuleMessage{
                            Id:          "noUnhandledError",
                            Description: "Error-typed return value is not handled.",
                        })
                        return
                    }
                }
            },
        }
    },
}
```

This catches code like:

```typescript
// error — result discarded, Error not handled
getUser("id")           // returns Error | User
await fetchData("/api") // returns Promise<Error | Data>

// ok — result is checked
const user = getUser("id")
if (user instanceof Error) return user

// ok — explicitly discarded
void getUser("id")
```

## Version pinning

**Pin lintcn in your `package.json`** — do not use `^` or `~`:

```json
{
  "devDependencies": {
    "lintcn": "0.1.0"
  }
}
```

Each lintcn release bundles a specific tsgolint version. Updating lintcn can change the underlying tsgolint API, which may cause your rules to no longer compile. Always update consciously:

1. Check the [changelog](./CHANGELOG.md) for tsgolint version changes
2. Run `npx lintcn build` after updating to verify your rules still compile
3. Fix any compilation errors before committing

You can test against an unreleased tsgolint version without updating lintcn:

```bash
npx lintcn lint --tsgolint-version v0.10.0
```

## Prerequisites

- **Node.js** — for the CLI
- **Go 1.26+** — for compiling rules (`go.dev/dl`)
- **Git** — for cloning tsgolint source on first build

Go is only needed for `lintcn lint` / `lintcn build`. Adding and listing rules works without Go.

## License

MIT
