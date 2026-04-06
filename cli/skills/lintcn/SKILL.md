---
name: lintcn
description: "Write, add, and update type-aware TypeScript lint rules in .lintcn/ Go files. ALWAYS use this skill when creating, editing, or debugging .lintcn/*.go rule files. Covers the tsgolint rule API, AST visitors, type checker, reporting, fixes, testing, and all patterns from the 50+ built-in rules."
---

# lintcn — Writing Custom tsgolint Lint Rules

tsgolint rules are Go functions that listen for TypeScript AST nodes and use the
TypeScript type checker for type-aware analysis. Each rule lives in its own
subfolder under `.lintcn/` and is compiled into a custom tsgolint binary.

**Every rule MUST be in a subfolder** — flat `.go` files in `.lintcn/` root are
not supported. The subfolder name = Go package name = rule identity.

Always run `go build ./...` inside `.lintcn/` to validate rules compile.
Always run `go test -v ./...` inside `.lintcn/` to run tests.

## Directory Layout

Each rule is a subfolder. The Go package name must match the folder name:

```
.lintcn/
    no_floating_promises/
        no_floating_promises.go         ← rule source (committed)
        no_floating_promises_test.go    ← tests (committed)
        options.go                      ← rule options struct
    await_thenable/
        await_thenable.go
        await_thenable_test.go
    my_custom_rule/
        my_custom_rule.go
    .gitignore                          ← ignores generated Go files
    go.mod                              ← generated
    go.work                             ← generated
    .tsgolint/                          ← symlink to cached source (gitignored)
```

## Adding Rules

```bash
# Add a rule folder from tsgolint
npx lintcn add https://github.com/oxc-project/tsgolint/tree/main/internal/rules/no_floating_promises

# Add by file URL (auto-fetches the whole folder)
npx lintcn add https://github.com/oxc-project/tsgolint/blob/main/internal/rules/await_thenable/await_thenable.go

# List installed rules
npx lintcn list

# Remove a rule (deletes the whole subfolder)
npx lintcn remove no-floating-promises

# Lint your project
npx lintcn lint
```

## Rule Anatomy

Every rule is a `rule.Rule` struct with a `Name` and a `Run` function.
`Run` receives a `RuleContext` and returns a `RuleListeners` map — a map from
`ast.Kind` to callback functions. The linter walks the AST and calls your
callback when it encounters a node of that kind.

```go
// .lintcn/my_rule/my_rule.go
package my_rule

import (
    "github.com/microsoft/typescript-go/shim/ast"
    "github.com/typescript-eslint/tsgolint/internal/rule"
)

var MyRule = rule.Rule{
    Name: "my-rule",
    Run: func(ctx rule.RuleContext, options any) rule.RuleListeners {
        return rule.RuleListeners{
            ast.KindCallExpression: func(node *ast.Node) {
                call := node.AsCallExpression()
                // analyze the call...
                ctx.ReportNode(node, rule.RuleMessage{
                    Id:          "myError",
                    Description: "Something is wrong here.",
                })
            },
        }
    },
}
```

### Metadata Comments

Add `// lintcn:` comments at the top for CLI metadata:

```go
// lintcn:name my-rule
// lintcn:severity warn
// lintcn:description Disallow doing X without checking Y
```

Available directives:

| Directive            | Values          | Default     | Description          |
| -------------------- | --------------- | ----------- | -------------------- |
| `lintcn:name`        | kebab-case      | folder name | Rule display name    |
| `lintcn:severity`    | `error`, `warn` | `error`     | Severity level       |
| `lintcn:description` | text            | empty       | One-line description |
| `lintcn:source`      | URL             | empty       | Original source URL  |

### Warning Severity

Rules with `// lintcn:severity warn`:

- Don't fail CI (exit code 0)
- Only show for git-changed/untracked files — unchanged files are skipped
- Use `--all-warnings` to see warnings across the whole codebase

Warnings are for rules that guide agents writing new code without flooding
the output with violations from the rest of the codebase. Examples:

- "Remove `as any`, the actual type is `string`"
- "This `||` fallback is unreachable, the left side is never nullish"
- "Unhandled Error return value, assign to a variable and check it"

### Package Name

Each rule subfolder has its own Go package. The package name must match the
folder name (e.g. `package no_floating_promises` in folder `no_floating_promises/`).
The exported variable name must match the pattern `var XxxRule = rule.Rule{...}`.

## RuleContext

`ctx rule.RuleContext` provides:

| Field                       | Type                       | Description                |
| --------------------------- | -------------------------- | -------------------------- |
| `SourceFile`                | `*ast.SourceFile`          | Current file being linted  |
| `Program`                   | `*compiler.Program`        | Full TypeScript program    |
| `TypeChecker`               | `*checker.Checker`         | TypeScript type checker    |
| `ReportNode`                | `func(node, msg)`          | Report error on a node     |
| `ReportNodeWithFixes`       | `func(node, msg, fixesFn)` | Report with auto-fixes     |
| `ReportNodeWithSuggestions` | `func(node, msg, suggFn)`  | Report with suggestions    |
| `ReportRange`               | `func(range, msg)`         | Report on a text range     |
| `ReportDiagnostic`          | `func(diagnostic)`         | Report with labeled ranges |

## AST Node Listeners

### Most Useful ast.Kind Values

```go
// Statements
ast.KindExpressionStatement      // bare expression: `foo();`
ast.KindReturnStatement          // `return x`
ast.KindThrowStatement           // `throw x`
ast.KindIfStatement              // `if (x) { ... }`
ast.KindVariableDeclaration      // `const x = ...`
ast.KindForInStatement           // `for (x in y)`

// Expressions
ast.KindCallExpression           // `foo()` — most commonly listened
ast.KindNewExpression            // `new Foo()`
ast.KindBinaryExpression         // `a + b`, `a === b`, `a = b`
ast.KindPropertyAccessExpression // `obj.prop`
ast.KindElementAccessExpression  // `obj[key]`
ast.KindAwaitExpression          // `await x`
ast.KindConditionalExpression    // `a ? b : c`
ast.KindPrefixUnaryExpression    // `!x`, `-x`, `typeof x`
ast.KindTemplateExpression       // `hello ${name}`
ast.KindDeleteExpression         // `delete obj.x`
ast.KindVoidExpression           // `void x`

// Declarations
ast.KindFunctionDeclaration
ast.KindArrowFunction
ast.KindMethodDeclaration
ast.KindClassDeclaration
ast.KindEnumDeclaration

// Types
ast.KindUnionType                // `A | B`
ast.KindIntersectionType         // `A & B`
ast.KindAsExpression             // `x as T`
```

### Enter and Exit Listeners

By default, listeners fire when the AST walker **enters** a node.
Use `rule.ListenerOnExit(kind)` to fire when the walker **exits** — useful
for scope tracking:

```go
return rule.RuleListeners{
    // enter function — push scope
    ast.KindFunctionDeclaration: func(node *ast.Node) {
        currentScope = &scopeInfo{upper: currentScope}
    },
    // exit function — pop scope and check
    rule.ListenerOnExit(ast.KindFunctionDeclaration): func(node *ast.Node) {
        if !currentScope.hasAwait {
            ctx.ReportNode(node, msg)
        }
        currentScope = currentScope.upper
    },
}
```

Used by require_await, return_await, consistent_return, prefer_readonly for
tracking state across function bodies with a scope stack.

### Allow/NotAllow Pattern Listeners

For destructuring and assignment contexts:

```go
rule.ListenerOnAllowPattern(ast.KindObjectLiteralExpression)     // inside destructuring
rule.ListenerOnNotAllowPattern(ast.KindArrayLiteralExpression)   // outside destructuring
```

Used by no_unsafe_assignment and unbound_method.

## Type Checker APIs

### Getting Types

```go
// Get the type of any AST node
t := ctx.TypeChecker.GetTypeAtLocation(node)

// Get type with constraint resolution (unwraps type params)
t := utils.GetConstrainedTypeAtLocation(ctx.TypeChecker, node)

// Get the contextual type (what TypeScript expects at this position)
t := checker.Checker_getContextualType(ctx.TypeChecker, node, checker.ContextFlagsNone)

// Get the apparent type (resolves mapped types, intersections)
t := checker.Checker_getApparentType(ctx.TypeChecker, t)

// Get awaited type (unwraps Promise)
t := checker.Checker_getAwaitedType(ctx.TypeChecker, t)

// Get type from a type annotation node
t := checker.Checker_getTypeFromTypeNode(ctx.TypeChecker, typeNode)
```

### Type Flag Checks

TypeFlags are bitmasks — check with `utils.IsTypeFlagSet`:

```go
// Check specific flags
if utils.IsTypeFlagSet(t, checker.TypeFlagsVoid) { return }
if utils.IsTypeFlagSet(t, checker.TypeFlagsUndefined) { return }
if utils.IsTypeFlagSet(t, checker.TypeFlagsNever) { return }
if utils.IsTypeFlagSet(t, checker.TypeFlagsAny) { return }

// Combine flags with |
if utils.IsTypeFlagSet(t, checker.TypeFlagsVoid|checker.TypeFlagsUndefined|checker.TypeFlagsNever) {
    return // skip void, undefined, and never
}

// Convenience helpers
utils.IsTypeAnyType(t)
utils.IsTypeUnknownType(t)
utils.IsObjectType(t)
utils.IsTypeParameter(t)
```

### Union and Intersection Types

**Decomposing unions is the most common pattern** — 58 uses across all rules:

```go
// Iterate over union parts: `Error | string` → [Error, string]
for _, part := range utils.UnionTypeParts(t) {
    if utils.IsErrorLike(ctx.Program, ctx.TypeChecker, part) {
        hasError = true
        break
    }
}

// Check if it's a union type
if utils.IsUnionType(t) { ... }
if utils.IsIntersectionType(t) { ... }

// Iterate intersection parts
for _, part := range utils.IntersectionTypeParts(t) { ... }

// Recursive predicate check across union/intersection
result := utils.TypeRecurser(t, func(t *checker.Type) bool {
    return utils.IsTypeAnyType(t)
})
```

### Built-in Type Checks

```go
// Error types
utils.IsErrorLike(ctx.Program, ctx.TypeChecker, t)
utils.IsReadonlyErrorLike(ctx.Program, ctx.TypeChecker, t)

// Promise types
utils.IsPromiseLike(ctx.Program, ctx.TypeChecker, t)
utils.IsThenableType(ctx.TypeChecker, node, t)

// Array types
checker.Checker_isArrayType(ctx.TypeChecker, t)
checker.IsTupleType(t)
checker.Checker_isArrayOrTupleType(ctx.TypeChecker, t)

// Generic built-in matching
utils.IsBuiltinSymbolLike(ctx.Program, ctx.TypeChecker, t, "Function")
utils.IsBuiltinSymbolLike(ctx.Program, ctx.TypeChecker, t, "RegExp")
utils.IsBuiltinSymbolLike(ctx.Program, ctx.TypeChecker, t, "ReadonlyArray")
```

### Type Properties and Signatures

```go
// Get a named property from a type
prop := checker.Checker_getPropertyOfType(ctx.TypeChecker, t, "then")
if prop != nil {
    propType := ctx.TypeChecker.GetTypeOfSymbolAtLocation(prop, node)
}

// Get all properties
props := checker.Checker_getPropertiesOfType(ctx.TypeChecker, t)

// Get call signatures (for callable types)
sigs := utils.GetCallSignatures(ctx.TypeChecker, t)
// or
sigs := ctx.TypeChecker.GetCallSignatures(t)

// Get signature parameters
params := checker.Signature_parameters(sig)

// Get return type of a signature
returnType := checker.Checker_getReturnTypeOfSignature(ctx.TypeChecker, sig)

// Get type arguments (for generics, arrays, tuples)
typeArgs := checker.Checker_getTypeArguments(ctx.TypeChecker, t)

// Get resolved call signature at a call site
sig := checker.Checker_getResolvedSignature(ctx.TypeChecker, callNode)
```

### Type Assignability

```go
// Check if source is assignable to target
if checker.Checker_isTypeAssignableTo(ctx.TypeChecker, sourceType, targetType) {
    // source extends target
}

// Get base constraint of a type parameter
constraint := checker.Checker_getBaseConstraintOfType(ctx.TypeChecker, t)
```

### Symbols

```go
// Get symbol at a location
symbol := ctx.TypeChecker.GetSymbolAtLocation(node)

// Get declaration for a symbol
decl := utils.GetDeclaration(ctx.TypeChecker, node)

// Get type from symbol
t := checker.Checker_getTypeOfSymbol(ctx.TypeChecker, symbol)
t := checker.Checker_getDeclaredTypeOfSymbol(ctx.TypeChecker, symbol)

// Check if symbol comes from default library
utils.IsSymbolFromDefaultLibrary(ctx.Program, symbol)

// Get the accessed property name (works with computed properties too)
name, ok := checker.Checker_getAccessedPropertyName(ctx.TypeChecker, node)
```

### Formatting Types for Error Messages

```go
typeName := ctx.TypeChecker.TypeToString(t)
// → "string", "Error | User", "Promise<number>", etc.

// Shorter type name helper
name := utils.GetTypeName(ctx.TypeChecker, t)
```

## AST Navigation

### Node Casting

Every AST node is `*ast.Node`. Use `.AsXxx()` to access specific fields:

```go
call := node.AsCallExpression()
call.Expression    // the callee
call.Arguments     // argument list

binary := node.AsBinaryExpression()
binary.Left
binary.Right
binary.OperatorToken.Kind  // ast.KindEqualsToken, ast.KindPlusToken, etc.

prop := node.AsPropertyAccessExpression()
prop.Expression    // object
prop.Name()        // property name node
```

### Type Predicates

```go
ast.IsCallExpression(node)
ast.IsPropertyAccessExpression(node)
ast.IsIdentifier(node)
ast.IsAccessExpression(node)   // property OR element access
ast.IsBinaryExpression(node)
ast.IsAssignmentExpression(node, includeCompound)  // a = b, a += b
ast.IsVoidExpression(node)
ast.IsAwaitExpression(node)
ast.IsFunctionLike(node)
ast.IsArrowFunction(node)
ast.IsStringLiteral(node)
```

### Skipping Parentheses

Always skip parentheses when analyzing expression content:

```go
expression := ast.SkipParentheses(node.AsExpressionStatement().Expression)
```

### Walking Parents

```go
parent := node.Parent
for parent != nil {
    if ast.IsCallExpression(parent) {
        // node is inside a call expression
        break
    }
    parent = parent.Parent
}
```

## Reporting Errors

### Simple Error

```go
ctx.ReportNode(node, rule.RuleMessage{
    Id:          "myErrorId",    // unique ID for the error
    Description: "Something is wrong.",
    Help:        "Optional longer explanation.",  // shown as help text
})
```

### Error with Auto-Fix

Fixes are applied automatically by the linter:

```go
ctx.ReportNodeWithFixes(node, msg, func() []rule.RuleFix {
    return []rule.RuleFix{
        rule.RuleFixInsertBefore(ctx.SourceFile, node, "await "),
    }
})
```

### Error with Suggestions

Suggestions require user confirmation:

```go
ctx.ReportNodeWithSuggestions(node, msg, func() []rule.RuleSuggestion {
    return []rule.RuleSuggestion{{
        Message:  rule.RuleMessage{Id: "addAwait", Description: "Add await"},
        FixesArr: []rule.RuleFix{
            rule.RuleFixInsertBefore(ctx.SourceFile, node, "await "),
        },
    }}
})
```

### Error with Multiple Labeled Ranges

Highlight multiple code locations:

```go
ctx.ReportDiagnostic(rule.RuleDiagnostic{
    Range:   exprRange,
    Message: rule.RuleMessage{Id: "typeMismatch", Description: "Types are incompatible"},
    LabeledRanges: []rule.RuleLabeledRange{
        {Label: fmt.Sprintf("Type: %v", leftType), Range: leftRange},
        {Label: fmt.Sprintf("Type: %v", rightType), Range: rightRange},
    },
})
```

### Fix Helpers

```go
// Insert text before a node
rule.RuleFixInsertBefore(ctx.SourceFile, node, "await ")

// Insert text after a node
rule.RuleFixInsertAfter(node, ")")

// Replace a node with text
rule.RuleFixReplace(ctx.SourceFile, node, "newCode")

// Remove a node
rule.RuleFixRemove(ctx.SourceFile, node)

// Replace a specific text range
rule.RuleFixReplaceRange(textRange, "replacement")

// Remove a specific text range
rule.RuleFixRemoveRange(textRange)
```

### Getting Token Ranges for Fixes

When you need the exact range of a keyword token (like `void`, `as`, `await`):

```go
import "github.com/microsoft/typescript-go/shim/scanner"

// Get range of token at a position
voidTokenRange := scanner.GetRangeOfTokenAtPosition(ctx.SourceFile, node.Pos())

// Get a scanner to scan forward
s := scanner.GetScannerForSourceFile(ctx.SourceFile, startPos)
tokenRange := s.TokenRange()
```

## Rule Options

Rules can accept configuration via JSON:

```go
var MyRule = rule.Rule{
    Name: "my-rule",
    Run: func(ctx rule.RuleContext, options any) rule.RuleListeners {
        opts := utils.UnmarshalOptions[MyRuleOptions](options, "my-rule")
        // opts is now typed
    },
}

type MyRuleOptions struct {
    IgnoreVoid    bool     `json:"ignoreVoid"`
    AllowedTypes  []string `json:"allowedTypes"`
}
```

For lintcn rules, define the options struct directly in your rule file or
in a separate `options.go` file in the same subfolder.

## State Tracking (Scope Stacks)

When you need to track state across function boundaries (like "does this
function contain an await?"), use enter/exit listener pairs with a linked
list as a stack:

```go
type scopeInfo struct {
    hasAwait bool
    upper    *scopeInfo
}
var currentScope *scopeInfo

enterFunc := func(node *ast.Node) {
    currentScope = &scopeInfo{upper: currentScope}
}

exitFunc := func(node *ast.Node) {
    if !currentScope.hasAwait {
        ctx.ReportNode(node, msg)
    }
    currentScope = currentScope.upper
}

return rule.RuleListeners{
    ast.KindFunctionDeclaration:                      enterFunc,
    rule.ListenerOnExit(ast.KindFunctionDeclaration): exitFunc,
    ast.KindArrowFunction:                            enterFunc,
    rule.ListenerOnExit(ast.KindArrowFunction):       exitFunc,
    ast.KindAwaitExpression: func(node *ast.Node) {
        currentScope.hasAwait = true
    },
}
```

## Testing

Tests use `rule_tester.RunRuleTester` which creates a TypeScript program from
inline code and runs the rule against it. The test file must use the same
package name as the rule:

```go
// .lintcn/my_rule/my_rule_test.go
package my_rule

import (
    "testing"
    "github.com/typescript-eslint/tsgolint/internal/rule_tester"
    "github.com/typescript-eslint/tsgolint/internal/rules/fixtures"
)

func TestMyRule(t *testing.T) {
    t.Parallel()
    rule_tester.RunRuleTester(
        fixtures.GetRootDir(),
        "tsconfig.minimal.json",
        t,
        &MyRule,
        validCases,
        invalidCases,
    )
}
```

### Valid Test Cases (should NOT trigger)

```go
var validCases = []rule_tester.ValidTestCase{
    {Code: `const x = getUser("id");`},
    {Code: `void dangerousCall();`},
    // tsx support
    {Code: `<div onClick={() => {}} />`, Tsx: true},
    // custom filename
    {Code: `import x from './foo'`, FileName: "index.ts"},
    // with rule options
    {Code: `getUser("id");`, Options: MyRuleOptions{IgnoreVoid: true}},
    // with extra files for multi-file tests
    {
        Code: `import { x } from './helper';`,
        Files: map[string]string{
            "helper.ts": `export const x = 1;`,
        },
    },
}
```

### Invalid Test Cases (SHOULD trigger)

```go
var invalidCases = []rule_tester.InvalidTestCase{
    // Basic — just check the error fires
    {
        Code: `
            declare function getUser(id: string): Error | { name: string };
            getUser("id");
        `,
        Errors: []rule_tester.InvalidTestCaseError{
            {MessageId: "noUnhandledError"},
        },
    },
    // With exact position
    {
        Code: `getUser("id");`,
        Errors: []rule_tester.InvalidTestCaseError{
            {MessageId: "noUnhandledError", Line: 1, Column: 1, EndColumn: 15},
        },
    },
    // With suggestions
    {
        Code: `
            declare const arr: number[];
            delete arr[0];
        `,
        Errors: []rule_tester.InvalidTestCaseError{
            {
                MessageId: "noArrayDelete",
                Suggestions: []rule_tester.InvalidTestCaseSuggestion{
                    {
                        MessageId: "useSplice",
                        Output: `
            declare const arr: number[];
             arr.splice(0, 1);
        `,
                    },
                },
            },
        },
    },
    // With auto-fix output (code after fix applied)
    {
        Code: `const x = foo as any;`,
        Output: []string{`const x = foo;`},
        Errors: []rule_tester.InvalidTestCaseError{
            {MessageId: "unsafeAssertion"},
        },
    },
}
```

### Important Test Details

- **MessageId** must match the `Id` field in your `rule.RuleMessage`
- **Line/Column** are 1-indexed, optional (omit for flexibility)
- **Output** is the code after ALL auto-fixes are applied (iterates up to 10 times)
- **Suggestions** check the output of each individual suggestion fix
- Tests run in parallel by default (`t.Parallel()`)
- Use `Only: true` on a test case to run only that test (like `.only` in vitest)
- Use `Skip: true` to skip a test case

### Running Tests

```bash
cd .lintcn
go test -v ./...              # all tests
go test -v -run TestMyRule    # specific test
go test -count=1 ./...        # bypass test cache
```

### Snapshots

Tests generate snapshot files with the full diagnostic output — message text,
annotated source code, and underlined ranges. Run with `UPDATE_SNAPS=true` to
create or update them:

```bash
# From the build workspace (found via `lintcn build` output path)
UPDATE_SNAPS=true go test -run TestMyRule -count=1 ./rules/my_rule/
```

Snapshots are written to `internal/rule_tester/__snapshots__/{rule-name}.snap`
inside the cached tsgolint source. Copy them into your rule folder for reference:

```
.lintcn/my_rule/__snapshots__/my-rule.snap
```

**Always read the snapshot after writing tests** — it shows the exact messages
your rule produces, which is how you verify the output makes sense. Example
snapshot from `no-type-assertion`:

```
[TestNoTypeAssertion/invalid-7 - 1]
Diagnostic 1: typeAssertion (4:14 - 4:22)
Message: Type assertion `as User ({ name: string; age: number })`.
  The expression type is `Error | User`. Try removing the assertion
  or narrowing the type instead.
   3 |             declare const x: User | Error;
   4 |             const y = x as User;
     |                       ~~~~~~~~~
   5 |
---

[TestNoTypeAssertion/invalid-8 - 1]
Diagnostic 1: typeAssertion (4:14 - 4:24)
Message: Type assertion `as Config ({ host: string; port: number })`.
  The expression type is `Config | null`. Try removing the assertion
  or narrowing the type instead.
   3 |             declare const x: Config | null;
   4 |             const y = x as Config;
     |                       ~~~~~~~~~~~
   5 |
---
```

This shows: the message ID, position, full description text, and the source
code with the flagged range underlined. Use this to verify your error messages
are helpful and include enough type information for agents to act on.

## Complete Rule Example: no-unhandled-error

A real rule that enforces the errore pattern — errors when a call expression
returns a type containing `Error` and the result is discarded:

```go
// .lintcn/no_unhandled_error/no_unhandled_error.go

// lintcn:name no-unhandled-error
// lintcn:description Disallow discarding expressions that are subtypes of Error

package no_unhandled_error

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
                exprStatement := node.AsExpressionStatement()
                expression := ast.SkipParentheses(exprStatement.Expression)

                // void expressions are intentional discards
                if ast.IsVoidExpression(expression) {
                    return
                }

                // only check call expressions and await expressions wrapping calls
                innerExpr := expression
                if ast.IsAwaitExpression(innerExpr) {
                    innerExpr = ast.SkipParentheses(innerExpr.Expression())
                }
                if !ast.IsCallExpression(innerExpr) {
                    return
                }

                t := ctx.TypeChecker.GetTypeAtLocation(expression)

                // skip void, undefined, never
                if utils.IsTypeFlagSet(t,
                    checker.TypeFlagsVoid|checker.TypeFlagsVoidLike|
                    checker.TypeFlagsUndefined|checker.TypeFlagsNever) {
                    return
                }

                // check if any union part is Error-like
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

## Go Workspace Setup

`.lintcn/` needs these generated files (created by `lintcn add` automatically):

**go.mod** — module name MUST be a child path of tsgolint for `internal/`
package access:

```
module github.com/typescript-eslint/tsgolint/lintcn-rules

go 1.26
```

**go.work** — workspace linking to cached tsgolint source:

```
go 1.26

use (
    .
    ./.tsgolint
    ./.tsgolint/typescript-go
)

replace (
    github.com/microsoft/typescript-go/shim/ast => ./.tsgolint/shim/ast
    github.com/microsoft/typescript-go/shim/checker => ./.tsgolint/shim/checker
    // ... all 14 shim modules
)
```

**.tsgolint/** — symlink to cached tsgolint clone (gitignored).

With this setup, gopls provides full autocomplete and go-to-definition on all
tsgolint and typescript-go APIs.
