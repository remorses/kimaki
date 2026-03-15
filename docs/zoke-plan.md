---
title: Zoke - CLI Framework in Zig
description: Plan to reimplement goke (TypeScript CLI framework) in Zig as "zoke"
prompt: |
  Read goke source code from discord/node_modules/goke/src/ (goke.ts, mri.ts,
  coerce.ts, index.ts) and create a plan to reimplement it in Zig. Ignore zod
  schema features. Refactor API for Zig idioms (structs + methods instead of
  closures, tagged unions instead of EventEmitter, etc).
---

# Zoke: Reimplementation Plan

Reimplementing goke's core CLI framework in Zig. Dropping all Standard Schema /
Zod coercion (the entire `coerce.ts`). Keeping: arg parsing (mri), command
matching, option parsing, help generation, version output, error formatting.

## Architecture Overview

```
                                ┌──────────────────┐
                                │     Cli (main)    │
                                │  name, commands,  │
                                │  global_options,  │
                                │  global_command   │
                                └────────┬─────────┘
                                         │ owns
                        ┌────────────────┼────────────────┐
                        ▼                ▼                ▼
                   ┌─────────┐     ┌─────────┐      ┌─────────┐
                   │ Command │     │ Command │      │ Command │
                   │ "serve" │     │ "build" │      │ "" (def) │
                   └────┬────┘     └────┬────┘      └────┬────┘
                        │               │                 │
                   ┌────▼────┐     ┌────▼────┐      ┌────▼────┐
                   │ Options │     │ Options │      │ Options │
                   │ --port  │     │ --watch │      │ --env   │
                   │ --host  │     │           │      │         │
                   └─────────┘     └─────────┘      └─────────┘
```

## Goke Features → Zoke Mapping

| goke feature | zoke approach | notes |
|---|---|---|
| `goke('name')` constructor | `Cli.init(allocator, "name")` | explicit allocator |
| `.command(name, desc)` → closures | `cli.command("serve", "desc")` returns `*Command` | no closures, use struct method ptr |
| `.option(raw, desc)` | `cmd.option("--port <port>", "Port number")` | string description only, no schema |
| `.action(callback)` | `cmd.setAction(actionFn)` where `actionFn: *const fn(ActionContext) anyerror!void` | fn pointer + context struct |
| `.parse(argv)` | `cli.parse(argv)` returns `ParseResult` | returns struct, no mutation |
| `.help()` / `.version()` | `cli.enableHelp()` / `cli.setVersion("1.0")` | |
| `EventEmitter` events | not needed, just return matched command | |
| Schema coercion (zod) | **dropped** — all values are strings | |
| Middleware `.use()` | `cli.addMiddleware(fn)` | fn pointer array |
| `picocolors` (ANSI) | inline ANSI escape helpers | zero-dep |
| mri arg parser | rewrite in Zig | |

## Files to Create

All under `zoke/src/`:

### 1. `main.zig` — public entry, exports `Cli`

```
pub const Cli = @import("cli.zig").Cli;
pub const Command = @import("command.zig").Command;
pub const Option = @import("option.zig").Option;
pub const ParseResult = @import("parse_result.zig").ParseResult;
```

### 2. `cli.zig` — main Cli struct (~400 lines)

The equivalent of the `Goke` class. Owns commands, global options, and orchestrates parsing.

```zig
pub const Cli = struct {
    allocator: Allocator,
    name: []const u8,
    commands: ArrayList(*Command),
    global_command: *Command,         // @@global@@
    global_options: ArrayList(*Option),
    middlewares: ArrayList(MiddlewareFn),
    version_str: ?[]const u8,
    help_enabled: bool,
    stdout: Writer,
    stderr: Writer,
    columns: u32,                     // terminal width for help wrapping

    pub fn init(allocator: Allocator, name: []const u8) Cli { ... }
    pub fn deinit(self: *Cli) void { ... }

    pub fn command(self: *Cli, raw_name: []const u8, description: []const u8) *Command { ... }
    pub fn option(self: *Cli, raw_name: []const u8, description: []const u8) *Cli { ... }
    pub fn addMiddleware(self: *Cli, mw: MiddlewareFn) *Cli { ... }

    pub fn enableHelp(self: *Cli) *Cli { ... }
    pub fn setVersion(self: *Cli, version: []const u8) *Cli { ... }

    pub fn parse(self: *Cli, argv: []const []const u8) ParseResult { ... }
    pub fn run(self: *Cli, result: ParseResult) anyerror!void { ... }

    pub fn helpText(self: *Cli) []const u8 { ... }
    pub fn outputHelp(self: *Cli) void { ... }
    pub fn outputVersion(self: *Cli) void { ... }
};

pub const MiddlewareFn = *const fn (ctx: *ActionContext) anyerror!void;
```

**Key difference from goke**: `parse()` is pure — returns a `ParseResult` value.
`run()` is separate and executes the matched command. This replaces goke's
`parse(argv, { run: true })` pattern with explicit two-phase: parse then run.

### 3. `command.zig` — Command struct (~200 lines)

```zig
pub const Command = struct {
    raw_name: []const u8,
    name: []const u8,               // removeBrackets(raw_name)
    description: []const u8,
    options: ArrayList(*Option),
    args: ArrayList(CommandArg),     // parsed from brackets
    alias_names: ArrayList([]const u8),
    action_fn: ?ActionFn,
    examples: ArrayList([]const u8),
    usage_text: ?[]const u8,
    config: CommandConfig,
    cli: *Cli,                       // back-reference

    pub fn option(self: *Command, raw: []const u8, desc: []const u8) *Command { ... }
    pub fn setAction(self: *Command, action: ActionFn) *Command { ... }
    pub fn alias(self: *Command, name: []const u8) *Command { ... }
    pub fn example(self: *Command, ex: []const u8) *Command { ... }
    pub fn usage(self: *Command, text: []const u8) *Command { ... }
    pub fn allowUnknownOptions(self: *Command) *Command { ... }

    pub fn isMatched(self: *Command, args: []const []const u8) MatchResult { ... }
    pub fn isDefaultCommand(self: *Command) bool { ... }

    pub fn helpText(self: *Command) []const u8 { ... }

    pub fn checkRequiredArgs(self: *Command, parsed_args: []const []const u8) !void { ... }
    pub fn checkUnknownOptions(self: *Command, parsed_opts: StringHashMap) !void { ... }
    pub fn checkOptionValue(self: *Command, parsed_opts: StringHashMap) !void { ... }
};

pub const ActionFn = *const fn (ctx: *ActionContext) anyerror!void;

pub const ActionContext = struct {
    args: []const []const u8,        // positional args
    options: StringHashMap([]const u8), // parsed option values (all strings)
    double_dash: []const []const u8, // args after --
    cli: *Cli,
};

pub const CommandArg = struct {
    required: bool,
    value: []const u8,
    variadic: bool,
};

pub const MatchResult = struct {
    matched: bool,
    consumed_args: u32,
};
```

**API change**: instead of `action((arg1, arg2, options) => {})` with JS
closures, we use `ActionFn` which receives an `ActionContext` struct. The caller
reads positional args from `ctx.args[0]`, `ctx.args[1]`, etc. and options from
`ctx.options.get("port")`. All values are strings (no coercion).

### 4. `option.zig` — Option struct (~60 lines)

```zig
pub const Option = struct {
    raw_name: []const u8,
    name: []const u8,          // longest name (camelCase not needed in Zig, use kebab)
    names: ArrayList([]const u8),  // all aliases
    description: []const u8,
    default_value: ?[]const u8,
    is_boolean: bool,
    required: bool,            // <...> vs [...]
};
```

**Simplification**: no schema, no StandardJSONSchemaV1, no deprecated field.
Option names stay kebab-case (no camelCase conversion — Zig convention uses
snake_case anyway, and CLI users type kebab-case).

### 5. `mri.zig` — arg parser (~150 lines)

Rewrite of mri.ts. Parses `[]const []const u8` into positional args and options.

```zig
pub const MriOptions = struct {
    aliases: StringHashMap([]const []const u8),
    booleans: ArrayList([]const u8),
};

pub const MriResult = struct {
    positional: ArrayList([]const u8),
    options: StringHashMap(Value),  // Value = string | bool | []string
    double_dash: ArrayList([]const u8),
};

pub const Value = union(enum) {
    string: []const u8,
    boolean: bool,
    list: ArrayList([]const u8),  // repeated flags
};

pub fn parse(allocator: Allocator, args: []const []const u8, opts: MriOptions) MriResult { ... }
```

**Key difference**: uses a tagged union `Value` instead of JS's loose typing.
No auto-number coercion (goke also disabled this).

### 6. `parse_result.zig` — result of parsing (~30 lines)

```zig
pub const ParseResult = struct {
    args: []const []const u8,
    options: StringHashMap(Value),
    matched_command: ?*Command,
    matched_command_name: ?[]const u8,
    should_show_help: bool,
    should_show_version: bool,
};
```

### 7. `help.zig` — help text formatting (~200 lines)

All help rendering logic extracted here. Handles:
- Terminal width wrapping (`wrapLine`, `wrapDescription`)
- ANSI coloring (bold, cyan, blue, dim, green)
- Column alignment (`padRight`, `visibleLength`)
- Section formatting (Usage, Commands, Options, Description, Examples)

```zig
pub fn formatHelp(cli: *Cli, command: *Command) []const u8 { ... }
pub fn formatPrefixHelp(cli: *Cli, prefix: []const u8, commands: []*Command) []const u8 { ... }

// ANSI helpers (no dependency on picocolors)
pub fn bold(text: []const u8) []const u8 { ... }
pub fn cyan(text: []const u8) []const u8 { ... }
pub fn blue(text: []const u8) []const u8 { ... }
pub fn dim(text: []const u8) []const u8 { ... }
pub fn red(text: []const u8) []const u8 { ... }
pub fn green(text: []const u8) []const u8 { ... }
```

### 8. `errors.zig` — error types (~20 lines)

```zig
pub const CliError = error{
    UnknownOption,
    MissingOptionValue,
    MissingRequiredArg,
    InvalidValue,
};

pub const CliErrorPayload = struct {
    kind: CliError,
    message: []const u8,
};
```

### 9. `tests/` — test files

- `test_mri.zig` — mri parser tests
- `test_cli.zig` — full CLI integration tests
- `test_help.zig` — help output snapshot tests

## Dropped Features (vs goke)

1. **Schema coercion** (entire `coerce.ts`) — no Zod, no Standard Schema, no
   JSON Schema. All option values are raw strings. Users parse them in their
   action fn.
2. **EventEmitter** — no `on('command:*')`. Instead `ParseResult` tells you
   what matched. Caller decides what to do.
3. **camelCase conversion** — Zig uses snake_case. Options stay as-is
   (kebab-case). The user accesses `ctx.options.get("dry-run")`.
4. **Dot-nested options** (`--config.port 3000` → `{ config: { port: ... } }`)
   — dropped. Options are flat `StringHashMap`. If needed, users can implement
   nesting themselves.
5. **Async middleware** — Zig has no async runtime needed here. Middleware is
   synchronous `anyerror!void`.

## Implementation Order

1. **`mri.zig`** — standalone, testable first. Port the arg splitting logic.
2. **`option.zig`** — simple struct, bracket parsing from raw name.
3. **`errors.zig`** — error types.
4. **`help.zig`** — ANSI helpers + formatting. Can test independently.
5. **`command.zig`** — depends on option + help.
6. **`cli.zig`** — ties everything together. Depends on mri + command.
7. **`parse_result.zig`** — trivial struct.
8. **`main.zig`** — public API re-exports.
9. **Tests** — port goke's test cases, adapted for string-only values.

## Build

```
zoke/
├── build.zig
├── build.zig.zon
└── src/
    ├── main.zig
    ├── cli.zig
    ├── command.zig
    ├── option.zig
    ├── mri.zig
    ├── help.zig
    ├── errors.zig
    ├── parse_result.zig
    └── tests/
        ├── test_mri.zig
        ├── test_cli.zig
        └── test_help.zig
```

Standard `zig build` with `build.zig` exposing a library module. No external
dependencies.

## Usage Example (Zig)

```zig
const std = @import("std");
const zoke = @import("zoke");

fn serveAction(ctx: *zoke.ActionContext) !void {
    const port = ctx.options.get("port") orelse "3000";
    const host = ctx.options.get("host") orelse "localhost";
    std.debug.print("Serving on {s}:{s}\n", .{ host, port });
}

fn buildAction(ctx: *zoke.ActionContext) !void {
    const entry = if (ctx.args.len > 0) ctx.args[0] else "src/main.zig";
    const watch = ctx.options.get("watch") != null;
    std.debug.print("Building {s} (watch={any})\n", .{ entry, watch });
}

pub fn main() !void {
    var gpa = std.heap.GeneralPurposeAllocator(.{}){};
    defer _ = gpa.deinit();
    const allocator = gpa.allocator();

    var cli = zoke.Cli.init(allocator, "myapp");
    defer cli.deinit();

    _ = cli.command("serve", "Start the dev server")
        .option("--port <port>", "Port number")
        .option("--host [host]", "Hostname")
        .setAction(serveAction);

    _ = cli.command("build [entry]", "Build the project")
        .option("--watch", "Watch mode")
        .setAction(buildAction);

    _ = cli.enableHelp();
    _ = cli.setVersion("1.0.0");

    const result = cli.parse(std.os.argv[1..]);

    if (result.should_show_help) {
        cli.outputHelp();
        return;
    }
    if (result.should_show_version) {
        cli.outputVersion();
        return;
    }

    try cli.run(result);
}
```

## Key API Differences Summary

| goke (TypeScript) | zoke (Zig) | reason |
|---|---|---|
| `cli.command('serve', 'desc').action((opts) => {})` | `cmd.setAction(serveFn)` | no closures in Zig |
| `options.port` (number) | `ctx.options.get("port")` → `?[]const u8` | no coercion, all strings |
| `options.dryRun` (camelCase) | `ctx.options.get("dry-run")` (kebab) | no camelCase transform |
| `cli.parse()` parses + runs | `cli.parse()` returns result, `cli.run(result)` executes | explicit two-phase |
| `options['--']` array | `ctx.double_dash` slice | named field |
| `.use((opts) => {})` middleware | `.addMiddleware(fn)` | fn pointer |
| EventEmitter `on('command:*')` | check `result.matched_command == null` | no events |
