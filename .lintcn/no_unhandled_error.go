// lintcn:name no-unhandled-error
// lintcn:description Disallow discarding expressions that are subtypes of Error. Enforces the errore pattern where errors are values that must be checked.

package lintcn

import (
	"github.com/microsoft/typescript-go/shim/ast"
	"github.com/microsoft/typescript-go/shim/checker"
	"github.com/typescript-eslint/tsgolint/internal/rule"
	"github.com/typescript-eslint/tsgolint/internal/utils"
)

// NoUnhandledErrorRule errors when an expression statement evaluates to a type
// assignable to Error and the result is discarded. This enforces the errore
// convention: functions return Error | T unions, callers must check instanceof
// Error before proceeding. Discarding an Error-typed expression means the
// caller forgot to handle the error.
//
// Examples of incorrect code:
//
//	getUser(id)              // returns Error | User, result discarded
//	await fetchData(url)     // returns Error | Data, result discarded
//
// Examples of correct code:
//
//	const user = getUser(id)
//	if (user instanceof Error) return user
//
//	void getUser(id)         // explicitly ignored with void
var NoUnhandledErrorRule = rule.Rule{
	Name: "no-unhandled-error",
	Run: func(ctx rule.RuleContext, options any) rule.RuleListeners {
		return rule.RuleListeners{
			ast.KindExpressionStatement: func(node *ast.Node) {
				exprStatement := node.AsExpressionStatement()
				expression := ast.SkipParentheses(exprStatement.Expression)

				// void expressions are intentional discards, skip them
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

				// get the type of the full expression (after await if present)
				t := ctx.TypeChecker.GetTypeAtLocation(expression)

				// skip void, undefined, and never — these have no meaningful value
				if utils.IsTypeFlagSet(t, checker.TypeFlagsVoid|checker.TypeFlagsVoidLike|checker.TypeFlagsUndefined|checker.TypeFlagsNever) {
					return
				}

				// check if any union constituent is Error-like (Error | T → report)
				for _, part := range utils.UnionTypeParts(t) {
					if utils.IsErrorLike(ctx.Program, ctx.TypeChecker, part) {
						ctx.ReportNode(node, rule.RuleMessage{
							Id:          "noUnhandledError",
							Description: "Error-typed return value is not handled. Check with `instanceof Error` or assign to a variable.",
						})
						return
					}
				}
			},
		}
	},
}
