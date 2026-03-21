package lintcn

import (
	"testing"

	"github.com/typescript-eslint/tsgolint/internal/rule_tester"
	"github.com/typescript-eslint/tsgolint/internal/rules/fixtures"
)

func TestNoUnhandledError(t *testing.T) {
	t.Parallel()
	rule_tester.RunRuleTester(fixtures.GetRootDir(), "tsconfig.minimal.json", t, &NoUnhandledErrorRule, []rule_tester.ValidTestCase{
		// Result assigned to variable
		{Code: `
			declare function getUser(id: string): Error | { name: string };
			const user = getUser("id");
		`},
		// Void return — nothing to handle
		{Code: `
			declare function log(msg: string): void;
			log("hello");
		`},
		// Undefined return
		{Code: `
			declare function setup(): undefined;
			setup();
		`},
		// Non-Error return discarded
		{Code: `
			declare function add(a: number, b: number): number;
			add(1, 2);
		`},
		// String return discarded
		{Code: `
			declare function getName(): string;
			getName();
		`},
		// Explicitly discarded with void operator
		{Code: `
			declare function getUser(id: string): Error | { name: string };
			void getUser("id");
		`},
		// Non-call expression — bare identifier with Error type
		{Code: `
			declare const x: Error | string;
			x;
		`},
		// Promise<void> awaited
		{Code: `
			declare function sendEmail(): Promise<void>;
			await sendEmail();
		`},
		// Returned from function (not expression statement)
		{Code: `
			declare function getUser(id: string): Error | { name: string };
			function wrapper() { return getUser("id"); }
		`},
		// Promise<number> — no Error in resolved type
		{Code: `
			declare function fetchCount(): Promise<number>;
			await fetchCount();
		`},
		// never return
		{Code: `
			declare function throwAlways(): never;
			throwAlways();
		`},
		// Method call returning void
		{Code: `
			declare const arr: number[];
			arr.push(1);
		`},
		// console.log — void return
		{Code: `console.log("hello");`},
		// Assigned via destructuring
		{Code: `
			declare function getResult(): Error | { a: number; b: string };
			const { a } = getResult() as { a: number; b: string };
		`},
		// Used in ternary (not bare expression statement)
		{Code: `
			declare function getUser(id: string): Error | { name: string };
			const x = getUser("id") instanceof Error ? "err" : "ok";
		`},
		// Chained .catch — returns Promise<void>
		{Code: `
			declare function fetchData(): Promise<string>;
			fetchData().catch(() => {});
		`},
	}, []rule_tester.InvalidTestCase{
		// Error | T return discarded
		{
			Code: `
				declare function getUser(id: string): Error | { name: string };
				getUser("id");
			`,
			Errors: []rule_tester.InvalidTestCaseError{
				{MessageId: "noUnhandledError"},
			},
		},
		// Awaited call with Error in resolved type
		{
			Code: `
				declare function fetchData(url: string): Promise<Error | string>;
				await fetchData("/api");
			`,
			Errors: []rule_tester.InvalidTestCaseError{
				{MessageId: "noUnhandledError"},
			},
		},
		// Error | null return discarded
		{
			Code: `
				declare function validate(): Error | null;
				validate();
			`,
			Errors: []rule_tester.InvalidTestCaseError{
				{MessageId: "noUnhandledError"},
			},
		},
		// Plain Error return discarded
		{
			Code: `
				declare function check(): Error;
				check();
			`,
			Errors: []rule_tester.InvalidTestCaseError{
				{MessageId: "noUnhandledError"},
			},
		},
		// Custom error subclass
		{
			Code: `
				class NotFoundError extends Error {
					constructor(public id: string) { super("not found: " + id); }
				}
				declare function find(id: string): NotFoundError | { data: string };
				find("123");
			`,
			Errors: []rule_tester.InvalidTestCaseError{
				{MessageId: "noUnhandledError"},
			},
		},
		// TypeError in union
		{
			Code: `
				declare function parse(input: string): TypeError | { value: number };
				parse("abc");
			`,
			Errors: []rule_tester.InvalidTestCaseError{
				{MessageId: "noUnhandledError"},
			},
		},
		// Error | undefined return discarded
		{
			Code: `
				declare function tryConnect(): Error | undefined;
				tryConnect();
			`,
			Errors: []rule_tester.InvalidTestCaseError{
				{MessageId: "noUnhandledError"},
			},
		},
		// Multiple calls, only the error-returning one flags
		{
			Code: `
				declare function safe(): void;
				declare function risky(): Error | string;
				safe();
				risky();
			`,
			Errors: []rule_tester.InvalidTestCaseError{
				{MessageId: "noUnhandledError"},
			},
		},
		// Method call returning Error union
		{
			Code: `
				declare const db: { query(sql: string): Error | { rows: any[] } };
				db.query("SELECT 1");
			`,
			Errors: []rule_tester.InvalidTestCaseError{
				{MessageId: "noUnhandledError"},
			},
		},
		// Nested parentheses around discarded call
		{
			Code: `
				declare function getUser(id: string): Error | { name: string };
				(getUser("id"));
			`,
			Errors: []rule_tester.InvalidTestCaseError{
				{MessageId: "noUnhandledError"},
			},
		},
	})
}
