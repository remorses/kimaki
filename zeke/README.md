# zeke

Type-safe CLI framework for Zig. Define commands with a builder chain — each
`.option()` call generates a new comptime type. Action functions receive typed
`Args` and `Options` structs. Accessing a field that doesn't exist is a compile
error, not a runtime crash.

Zero dependencies. Single `@import("zeke")`. Works with Zig 0.15+.

## Install

Add to your `build.zig.zon`:

```zig
.dependencies = .{
    .zeke = .{
        .url = "https://github.com/remorses/zeke/archive/refs/heads/main.tar.gz",
    },
},
```

Then in `build.zig`:

```zig
const zeke_dep = b.dependency("zeke", .{
    .target = target,
    .optimize = optimize,
});
exe.root_module.addImport("zeke", zeke_dep.module("zeke"));
```

## Usage

**Define commands** at comptime with the builder chain:

```zig
const zeke = @import("zeke");

const Serve = zeke.cmd("serve <entry>", "Start the dev server")
    .option("--port <port>", "Port number")
    .option("--host [host]", "Hostname")
    .option("--watch", "Watch mode");
```

**Write typed action functions** — the compiler checks every field access:

```zig
fn serveAction(args: Serve.Args, opts: Serve.Options) !void {
    // args.entry → []const u8  (required, from <entry>)
    // opts.port  → []const u8  (required value)
    // opts.host  → ?[]const u8 (optional, null if absent)
    // opts.watch → bool        (flag)
    // opts.bogus → COMPILE ERROR
    _ = .{ args, opts };
}
```

**Bind and register:**

```zig
const ServeCmd = Serve.bind(serveAction);

pub fn main() !void {
    var gpa = std.heap.GeneralPurposeAllocator(.{}){};
    var app = zeke.App(.{ ServeCmd }).init(gpa.allocator(), "myapp");
    app.setVersion("1.0.0");
    try app.run();
}
```

## How it works

Each `.option()` call returns a **different comptime type** with one more struct
field, built via `@Type`. The chain is fully resolved at compile time — zero
runtime cost for the type machinery.

```
cmd("click [target]", "...")                    → T0  { Args={target:?str}, Options={} }
  .option("-x [x]", "X coordinate")            → T1  { Options={x:?str} }
  .option("--button [button]", "Mouse button") → T2  { Options={x:?str, button:?str} }
  .option("--count [count]", "Click count")    → T3  { Options={x:?str, button:?str, count:?str} }
```

The two-step `.bind(fn)` pattern breaks circular dependencies: define the command
first, write the action using its `.Args`/`.Options` types, then bind.

## Features

- **Comptime type generation** — `.option()` chain builds typed structs via `@Type`
- **Compile-time field checking** — wrong field access = compile error
- **Space-separated subcommands** — `mouse move`, `clipboard get` with longest-match dispatch
- **Short aliases** — `-p, --port <port>` or `-x [x]`
- **Positional args** — `<required>`, `[optional]`, `[...variadic]`
- **Auto help** — `--help` / `-h` with aligned columns and ANSI colors
- **Auto version** — `--version` / `-v`
- **Double-dash** — `--` separator for passthrough args
- **Zero dependencies** — pure Zig, no allocations in the comptime layer

## Option types

| Option string | Field type | Default |
|---|---|---|
| `--port <port>` | `[]const u8` | none (required) |
| `--host [host]` | `?[]const u8` | `null` |
| `--watch` | `bool` | `false` |
| `--coord-map [map]` | `?[]const u8` | `null` (kebab → snake_case) |
| `-p, --port <port>` | `[]const u8` | none, short alias `p` |

## Arg types

| Name string | Generated field |
|---|---|
| `<key>` | `key: []const u8` |
| `[path]` | `path: ?[]const u8` |
| `[...files]` | `files: []const []const u8` |

## Full example

See [`example/main.zig`](example/main.zig) for a usecomputer-style CLI with 9
commands including space-separated subcommands (`mouse move`, `display list`,
`clipboard get/set`).

```
$ myapp --help

usecomputer/0.1.0

Usage:
  $ usecomputer <command> [options]

Commands:
  screenshot [path]            Take a screenshot
    --region [region]          Capture specific region (x,y,w,h)
    --display [id]             Target display
    --annotate                 Annotate with grid overlay
    --json                     Output as JSON
  click [target]               Click at coordinates or target
    -x [x]                     X coordinate
    -y [y]                     Y coordinate
    --button [button]          Mouse button: left, right, middle
  press <key>                  Press a key or key combination
  mouse move [x] [y]          Move to absolute coordinates
  mouse position               Print current mouse position
  display list                 List connected displays
  clipboard get                Print clipboard text
  clipboard set <text>         Set clipboard text

Options:
  -h, --help     Display this message
  -v, --version  Display version number
```

## License

MIT
