/// Comptime CLI builder.
///
/// `cmd()` starts a builder chain. Each `.option()` call returns a new comptime
/// type with one more field in the generated Options struct. `.bind(actionFn)`
/// finalizes the command and checks the action signature at comptime.
///
/// Example:
///   const Serve = zeke.cmd("serve <entry>", "Start server")
///       .option("--port <port>", "Port number")
///       .option("--watch", "Watch mode");
///
///   fn serveAction(args: Serve.Args, opts: Serve.Options) !void { ... }
///
///   const ServeCmd = Serve.bind(serveAction);
const std = @import("std");

// ─── Comptime string utilities ───

/// Replace '-' with '_' at comptime. Returns a sentinel-terminated string
/// suitable for use as a struct field name.
fn kebabToSnake(comptime input: []const u8) [:0]const u8 {
    comptime {
        var buf: [input.len:0]u8 = undefined;
        for (input, 0..) |c, i| {
            buf[i] = if (c == '-') '_' else c;
        }
        const final = buf;
        return &final;
    }
}

fn trimSpaces(comptime s: []const u8) []const u8 {
    comptime {
        var start: usize = 0;
        while (start < s.len and s[start] == ' ') start += 1;
        var end: usize = s.len;
        while (end > start and s[end - 1] == ' ') end -= 1;
        return s[start..end];
    }
}

// ─── Option spec parsing ───

pub const OptionKind = enum {
    flag, // --verbose (bool, no value)
    required, // --port <port> (must have value)
    optional, // --host [host] (value or null)
};

pub const OptionSpec = struct {
    /// Field name in the generated Options struct (snake_case, null-terminated)
    field_name: [:0]const u8,
    /// Long flag name for CLI matching (kebab-case, without --)
    long_name: []const u8,
    /// Short alias character, 0 if none
    short: u8,
    /// Whether this option takes a value and if it's required
    kind: OptionKind,
    /// Description text for help output
    description: []const u8,
    /// Raw option string as passed to .option()
    raw: []const u8,
};

/// Parse an option spec string like "--port <port>", "-p, --port <port>", "--verbose"
fn parseOptionSpec(comptime raw: []const u8, comptime desc: []const u8) OptionSpec {
    comptime {
        var short: u8 = 0;
        var rest_start: usize = 0;

        // Check for short alias: "-p, --port <port>"
        if (raw.len >= 2 and raw[0] == '-' and raw[1] != '-') {
            short = raw[1];
            var i: usize = 2;
            while (i < raw.len and (raw[i] == ',' or raw[i] == ' ')) i += 1;
            rest_start = i;
        }

        const rest = raw[rest_start..];

        // If rest starts with --, it's a long flag: --port, --coord-map, etc.
        // Otherwise, if we already have a short alias and rest is brackets or
        // empty, use the short char as the long name.
        var long_name: []const u8 = undefined;
        var after_name: []const u8 = undefined;

        if (rest.len >= 2 and rest[0] == '-' and rest[1] == '-') {
            // --long-name [value]
            const after_dashes = rest[2..];
            var name_end: usize = 0;
            while (name_end < after_dashes.len and after_dashes[name_end] != ' ') name_end += 1;
            long_name = after_dashes[0..name_end];
            after_name = trimSpaces(after_dashes[name_end..]);
        } else if (short != 0) {
            // Short-only like "-x [x]" → long name is "x", brackets from rest
            long_name = &[1]u8{short};
            after_name = trimSpaces(rest);
        } else {
            // Fallback: strip dashes and parse
            var dash_end: usize = 0;
            while (dash_end < rest.len and rest[dash_end] == '-') dash_end += 1;
            const after_dashes = rest[dash_end..];
            var name_end: usize = 0;
            while (name_end < after_dashes.len and after_dashes[name_end] != ' ') name_end += 1;
            long_name = after_dashes[0..name_end];
            after_name = trimSpaces(after_dashes[name_end..]);
        }

        const field_name = kebabToSnake(long_name);

        const kind: OptionKind = if (after_name.len > 0 and after_name[0] == '<')
            .required
        else if (after_name.len > 0 and after_name[0] == '[')
            .optional
        else
            .flag;

        return .{
            .field_name = field_name,
            .long_name = long_name,
            .short = short,
            .kind = kind,
            .description = desc,
            .raw = raw,
        };
    }
}

// ─── Command args parsing ───

pub const ArgSpec = struct {
    /// Field name (null-terminated for struct field)
    name: [:0]const u8,
    /// Whether this arg is required (<...>) vs optional ([...])
    required: bool,
    /// Whether this is variadic ([...args])
    variadic: bool,
};

/// Parse command name string to extract name parts and positional arg specs.
fn parseCommandParts(comptime raw_name: []const u8) struct {
    name_parts: []const []const u8,
    arg_specs: []const ArgSpec,
} {
    comptime {
        var name_parts_buf: [16][]const u8 = undefined;
        var name_count: usize = 0;
        var arg_specs_buf: [16]ArgSpec = undefined;
        var arg_count: usize = 0;

        var i: usize = 0;
        while (i < raw_name.len) {
            while (i < raw_name.len and raw_name[i] == ' ') i += 1;
            if (i >= raw_name.len) break;

            const start = i;
            while (i < raw_name.len and raw_name[i] != ' ') i += 1;
            const token = raw_name[start..i];

            if (token[0] == '<') {
                const inner: []const u8 = token[1 .. token.len - 1];
                var variadic = false;
                var arg_name: []const u8 = inner;
                if (inner.len >= 3 and inner[0] == '.' and inner[1] == '.' and inner[2] == '.') {
                    variadic = true;
                    arg_name = inner[3..];
                }
                arg_specs_buf[arg_count] = .{
                    .name = kebabToSnake(arg_name),
                    .required = true,
                    .variadic = variadic,
                };
                arg_count += 1;
            } else if (token[0] == '[') {
                const inner: []const u8 = token[1 .. token.len - 1];
                var variadic = false;
                var arg_name: []const u8 = inner;
                if (inner.len >= 3 and inner[0] == '.' and inner[1] == '.' and inner[2] == '.') {
                    variadic = true;
                    arg_name = inner[3..];
                }
                arg_specs_buf[arg_count] = .{
                    .name = kebabToSnake(arg_name),
                    .required = false,
                    .variadic = variadic,
                };
                arg_count += 1;
            } else {
                name_parts_buf[name_count] = token;
                name_count += 1;
            }
        }

        // Copy to fixed-size arrays that can be captured
        const name_parts: [name_count][]const u8 = name_parts_buf[0..name_count].*;
        const arg_specs: [arg_count]ArgSpec = arg_specs_buf[0..arg_count].*;
        return .{
            .name_parts = &name_parts,
            .arg_specs = &arg_specs,
        };
    }
}

// ─── Struct generation via @Type ───

/// Create a comptime pointer suitable for StructField.default_value
fn defaultPtr(comptime T: type, comptime val: T) ?*const anyopaque {
    return @ptrCast(&struct {
        const v: T = val;
    }.v);
}

/// Build Args struct from arg specs using @Type
pub fn buildArgsType(comptime arg_specs: []const ArgSpec) type {
    var fields: [arg_specs.len]std.builtin.Type.StructField = undefined;
    for (arg_specs, 0..) |spec, i| {
        if (spec.variadic) {
            fields[i] = .{
                .name = spec.name,
                .type = []const []const u8,
                .default_value_ptr = defaultPtr([]const []const u8, &[_][]const u8{}),
                .is_comptime = false,
                .alignment = @alignOf([]const []const u8),
            };
        } else if (spec.required) {
            fields[i] = .{
                .name = spec.name,
                .type = []const u8,
                .default_value_ptr = null,
                .is_comptime = false,
                .alignment = @alignOf([]const u8),
            };
        } else {
            fields[i] = .{
                .name = spec.name,
                .type = ?[]const u8,
                .default_value_ptr = defaultPtr(?[]const u8, null),
                .is_comptime = false,
                .alignment = @alignOf(?[]const u8),
            };
        }
    }
    const fields_final = fields;
    return @Type(.{ .@"struct" = .{
        .layout = .auto,
        .fields = &fields_final,
        .decls = &.{},
        .is_tuple = false,
    } });
}

/// Build Options struct from option specs using @Type.
pub fn buildOptionsType(comptime opt_specs: []const OptionSpec) type {
    var fields: [opt_specs.len]std.builtin.Type.StructField = undefined;
    for (opt_specs, 0..) |spec, i| {
        switch (spec.kind) {
            .flag => {
                fields[i] = .{
                    .name = spec.field_name,
                    .type = bool,
                    .default_value_ptr = defaultPtr(bool, false),
                    .is_comptime = false,
                    .alignment = @alignOf(bool),
                };
            },
            .required => {
                fields[i] = .{
                    .name = spec.field_name,
                    .type = []const u8,
                    .default_value_ptr = null,
                    .is_comptime = false,
                    .alignment = @alignOf([]const u8),
                };
            },
            .optional => {
                fields[i] = .{
                    .name = spec.field_name,
                    .type = ?[]const u8,
                    .default_value_ptr = defaultPtr(?[]const u8, null),
                    .is_comptime = false,
                    .alignment = @alignOf(?[]const u8),
                };
            },
        }
    }
    const fields_final = fields;
    return @Type(.{ .@"struct" = .{
        .layout = .auto,
        .fields = &fields_final,
        .decls = &.{},
        .is_tuple = false,
    } });
}

// ─── CommandBuilder ───

/// Comptime command builder. Returned by `cmd()`, each `.option()` call returns
/// a new type with an additional field. `.bind(fn)` finalizes the command.
pub fn CommandBuilder(
    comptime name_parts: []const []const u8,
    comptime raw_name: []const u8,
    comptime description: []const u8,
    comptime arg_specs: []const ArgSpec,
    comptime opt_specs: []const OptionSpec,
    comptime examples_list: []const []const u8,
) type {
    return struct {
        pub const Args = buildArgsType(arg_specs);
        pub const Options = buildOptionsType(opt_specs);

        pub const command_name_parts = name_parts;
        pub const command_raw_name = raw_name;
        pub const command_description = description;
        pub const command_arg_specs = arg_specs;
        pub const command_opt_specs = opt_specs;
        pub const command_examples = examples_list;

        /// Add an option. Returns a new builder type with the additional field.
        pub fn option(comptime raw: []const u8, comptime desc: []const u8) type {
            const new_spec = comptime parseOptionSpec(raw, desc);
            return CommandBuilder(
                name_parts,
                raw_name,
                description,
                arg_specs,
                opt_specs ++ [1]OptionSpec{new_spec},
                examples_list,
            );
        }

        /// Add an example string for help output.
        pub fn example(comptime ex: []const u8) type {
            return CommandBuilder(
                name_parts,
                raw_name,
                description,
                arg_specs,
                opt_specs,
                examples_list ++ [1][]const u8{ex},
            );
        }

        /// Finalize the command by binding an action function.
        pub fn bind(comptime action_fn: *const fn (Args, Options) anyerror!void) type {
            return BoundCommand(
                name_parts,
                raw_name,
                description,
                arg_specs,
                opt_specs,
                examples_list,
                Args,
                Options,
                action_fn,
            );
        }
    };
}

/// A command with its action bound. Passed to App().
fn BoundCommand(
    comptime name_parts: []const []const u8,
    comptime raw_name: []const u8,
    comptime description: []const u8,
    comptime arg_specs: []const ArgSpec,
    comptime opt_specs: []const OptionSpec,
    comptime examples_list: []const []const u8,
    comptime ArgsType: type,
    comptime OptsType: type,
    comptime action_fn: *const fn (ArgsType, OptsType) anyerror!void,
) type {
    return struct {
        pub const Args = ArgsType;
        pub const Options = OptsType;
        pub const command_name_parts = name_parts;
        pub const command_raw_name = raw_name;
        pub const command_description = description;
        pub const command_arg_specs = arg_specs;
        pub const command_opt_specs = opt_specs;
        pub const command_examples = examples_list;

        pub fn invoke(args: Args, opts: Options) anyerror!void {
            return action_fn(args, opts);
        }
    };
}

// ─── Public API ───

/// Start building a command definition.
pub fn cmd(comptime raw_name: []const u8, comptime description: []const u8) type {
    const parsed = comptime parseCommandParts(raw_name);
    return CommandBuilder(
        parsed.name_parts,
        raw_name,
        description,
        parsed.arg_specs,
        &[_]OptionSpec{},
        &[_][]const u8{},
    );
}

// ─── Tests ───

test "parseOptionSpec: flag" {
    const spec = comptime parseOptionSpec("--verbose", "Enable verbose output");
    try std.testing.expectEqualStrings("verbose", spec.field_name);
    try std.testing.expectEqualStrings("verbose", spec.long_name);
    try std.testing.expectEqual(OptionKind.flag, spec.kind);
    try std.testing.expectEqual(@as(u8, 0), spec.short);
}

test "parseOptionSpec: required value" {
    const spec = comptime parseOptionSpec("--port <port>", "Port number");
    try std.testing.expectEqualStrings("port", spec.field_name);
    try std.testing.expectEqualStrings("port", spec.long_name);
    try std.testing.expectEqual(OptionKind.required, spec.kind);
}

test "parseOptionSpec: optional value" {
    const spec = comptime parseOptionSpec("--host [host]", "Hostname");
    try std.testing.expectEqualStrings("host", spec.field_name);
    try std.testing.expectEqual(OptionKind.optional, spec.kind);
}

test "parseOptionSpec: kebab-case to snake_case" {
    const spec = comptime parseOptionSpec("--coord-map [map]", "Mapping");
    try std.testing.expectEqualStrings("coord_map", spec.field_name);
    try std.testing.expectEqualStrings("coord-map", spec.long_name);
}

test "parseOptionSpec: short alias" {
    const spec = comptime parseOptionSpec("-p, --port <port>", "Port");
    try std.testing.expectEqualStrings("port", spec.field_name);
    try std.testing.expectEqual(@as(u8, 'p'), spec.short);
    try std.testing.expectEqual(OptionKind.required, spec.kind);
}

test "parseOptionSpec: short only" {
    const spec = comptime parseOptionSpec("-x [x]", "X coord");
    try std.testing.expectEqualStrings("x", spec.field_name);
    try std.testing.expectEqual(OptionKind.optional, spec.kind);
}

test "parseCommandParts: simple command" {
    const parsed = comptime parseCommandParts("serve");
    try std.testing.expectEqual(@as(usize, 1), parsed.name_parts.len);
    try std.testing.expectEqualStrings("serve", parsed.name_parts[0]);
    try std.testing.expectEqual(@as(usize, 0), parsed.arg_specs.len);
}

test "parseCommandParts: command with required arg" {
    const parsed = comptime parseCommandParts("press <key>");
    try std.testing.expectEqual(@as(usize, 1), parsed.name_parts.len);
    try std.testing.expectEqualStrings("press", parsed.name_parts[0]);
    try std.testing.expectEqual(@as(usize, 1), parsed.arg_specs.len);
    try std.testing.expectEqualStrings("key", parsed.arg_specs[0].name);
    try std.testing.expect(parsed.arg_specs[0].required);
}

test "parseCommandParts: space-separated subcommand" {
    const parsed = comptime parseCommandParts("mouse move [x] [y]");
    try std.testing.expectEqual(@as(usize, 2), parsed.name_parts.len);
    try std.testing.expectEqualStrings("mouse", parsed.name_parts[0]);
    try std.testing.expectEqualStrings("move", parsed.name_parts[1]);
    try std.testing.expectEqual(@as(usize, 2), parsed.arg_specs.len);
    try std.testing.expect(!parsed.arg_specs[0].required);
}

test "parseCommandParts: variadic arg" {
    const parsed = comptime parseCommandParts("lint [...files]");
    try std.testing.expectEqual(@as(usize, 1), parsed.arg_specs.len);
    try std.testing.expectEqualStrings("files", parsed.arg_specs[0].name);
    try std.testing.expect(parsed.arg_specs[0].variadic);
    try std.testing.expect(!parsed.arg_specs[0].required);
}

test "buildArgsType: generates correct struct" {
    const specs = [_]ArgSpec{
        .{ .name = "key", .required = true, .variadic = false },
        .{ .name = "value", .required = false, .variadic = false },
    };
    const T = buildArgsType(&specs);
    try std.testing.expect(@TypeOf(@as(T, undefined).key) == []const u8);
    try std.testing.expect(@TypeOf(@as(T, undefined).value) == ?[]const u8);
}

test "buildOptionsType: generates correct struct" {
    const specs = [_]OptionSpec{
        .{ .field_name = "port", .long_name = "port", .short = 0, .kind = .required, .description = "", .raw = "" },
        .{ .field_name = "host", .long_name = "host", .short = 0, .kind = .optional, .description = "", .raw = "" },
        .{ .field_name = "watch", .long_name = "watch", .short = 0, .kind = .flag, .description = "", .raw = "" },
    };
    const T = buildOptionsType(&specs);
    try std.testing.expect(@TypeOf(@as(T, undefined).port) == []const u8);
    try std.testing.expect(@TypeOf(@as(T, undefined).host) == ?[]const u8);
    try std.testing.expect(@TypeOf(@as(T, undefined).watch) == bool);
}

test "cmd builder chain produces correct types" {
    const Serve = cmd("serve <entry>", "Start server")
        .option("--port <port>", "Port number")
        .option("--host [host]", "Hostname")
        .option("--watch", "Watch mode");

    try std.testing.expect(@TypeOf(@as(Serve.Args, undefined).entry) == []const u8);
    try std.testing.expect(@TypeOf(@as(Serve.Options, undefined).port) == []const u8);
    try std.testing.expect(@TypeOf(@as(Serve.Options, undefined).host) == ?[]const u8);
    try std.testing.expect(@TypeOf(@as(Serve.Options, undefined).watch) == bool);

    try std.testing.expectEqual(@as(usize, 1), Serve.command_name_parts.len);
    try std.testing.expectEqualStrings("serve", Serve.command_name_parts[0]);
    try std.testing.expectEqual(@as(usize, 3), Serve.command_opt_specs.len);
}

test "bind validates action signature" {
    const Serve = cmd("serve <entry>", "Start server")
        .option("--port <port>", "Port number")
        .option("--watch", "Watch mode");

    const action = struct {
        fn run(args: Serve.Args, opts: Serve.Options) !void {
            _ = args;
            _ = opts;
        }
    }.run;

    const Bound = Serve.bind(action);
    try std.testing.expect(@TypeOf(Bound.invoke) == fn (Bound.Args, Bound.Options) anyerror!void);
}

test "parseCommandParts: empty name (default command)" {
    const parsed = comptime parseCommandParts("");
    try std.testing.expectEqual(@as(usize, 0), parsed.name_parts.len);
    try std.testing.expectEqual(@as(usize, 0), parsed.arg_specs.len);
}

test "parseCommandParts: three-level subcommand with args" {
    const parsed = comptime parseCommandParts("git remote add <name> <url>");
    try std.testing.expectEqual(@as(usize, 3), parsed.name_parts.len);
    try std.testing.expectEqualStrings("git", parsed.name_parts[0]);
    try std.testing.expectEqualStrings("remote", parsed.name_parts[1]);
    try std.testing.expectEqualStrings("add", parsed.name_parts[2]);
    try std.testing.expectEqual(@as(usize, 2), parsed.arg_specs.len);
    try std.testing.expect(parsed.arg_specs[0].required);
    try std.testing.expect(parsed.arg_specs[1].required);
    try std.testing.expectEqualStrings("name", parsed.arg_specs[0].name);
    try std.testing.expectEqualStrings("url", parsed.arg_specs[1].name);
}

test "parseCommandParts: mixed required and optional args" {
    const parsed = comptime parseCommandParts("convert <input> [output]");
    try std.testing.expectEqual(@as(usize, 1), parsed.name_parts.len);
    try std.testing.expectEqual(@as(usize, 2), parsed.arg_specs.len);
    try std.testing.expect(parsed.arg_specs[0].required);
    try std.testing.expect(!parsed.arg_specs[1].required);
}

test "parseCommandParts: required variadic arg" {
    const parsed = comptime parseCommandParts("rm <...paths>");
    try std.testing.expectEqual(@as(usize, 1), parsed.arg_specs.len);
    try std.testing.expectEqualStrings("paths", parsed.arg_specs[0].name);
    try std.testing.expect(parsed.arg_specs[0].variadic);
    try std.testing.expect(parsed.arg_specs[0].required);
}

test "parseOptionSpec: short alias with optional value" {
    const spec = comptime parseOptionSpec("-o, --output [path]", "Output path");
    try std.testing.expectEqualStrings("output", spec.field_name);
    try std.testing.expectEqualStrings("output", spec.long_name);
    try std.testing.expectEqual(@as(u8, 'o'), spec.short);
    try std.testing.expectEqual(OptionKind.optional, spec.kind);
}

test "parseOptionSpec: multi-hyphen kebab name" {
    const spec = comptime parseOptionSpec("--no-emit-on-error", "Suppress output on errors");
    try std.testing.expectEqualStrings("no_emit_on_error", spec.field_name);
    try std.testing.expectEqualStrings("no-emit-on-error", spec.long_name);
    try std.testing.expectEqual(OptionKind.flag, spec.kind);
}

test "buildArgsType: variadic arg produces slice type" {
    const specs = [_]ArgSpec{
        .{ .name = "files", .required = false, .variadic = true },
    };
    const T = buildArgsType(&specs);
    try std.testing.expect(@TypeOf(@as(T, undefined).files) == []const []const u8);
}

test "buildOptionsType: empty specs produces empty struct" {
    const specs = [_]OptionSpec{};
    const T = buildOptionsType(&specs);
    const info = @typeInfo(T).@"struct";
    try std.testing.expectEqual(@as(usize, 0), info.fields.len);
}

test "cmd no options produces empty Options struct" {
    const Ping = cmd("ping <host>", "Ping a host");
    const info = @typeInfo(Ping.Options).@"struct";
    try std.testing.expectEqual(@as(usize, 0), info.fields.len);
    // Args should have one required field
    try std.testing.expect(@TypeOf(@as(Ping.Args, undefined).host) == []const u8);
}

test "cmd with example preserves examples" {
    const Serve = cmd("serve", "Start server")
        .option("--port <port>", "Port")
        .example("myapp serve --port 3000")
        .example("myapp serve --port 8080");
    try std.testing.expectEqual(@as(usize, 2), Serve.command_examples.len);
    try std.testing.expectEqualStrings("myapp serve --port 3000", Serve.command_examples[0]);
    try std.testing.expectEqualStrings("myapp serve --port 8080", Serve.command_examples[1]);
}

test "cmd default command has zero name parts" {
    const Root = cmd("", "Default command")
        .option("--verbose", "Verbose");
    try std.testing.expectEqual(@as(usize, 0), Root.command_name_parts.len);
    try std.testing.expectEqualStrings("", Root.command_raw_name);
    try std.testing.expect(@TypeOf(@as(Root.Options, undefined).verbose) == bool);
}

test "cmd preserves description and raw name" {
    const Cmd = cmd("deploy <env>", "Deploy to an environment")
        .option("--force", "Skip confirmation");
    try std.testing.expectEqualStrings("deploy <env>", Cmd.command_raw_name);
    try std.testing.expectEqualStrings("Deploy to an environment", Cmd.command_description);
}

test "bound command preserves all metadata" {
    const Cmd = cmd("mcp login <url>", "Login to MCP server")
        .option("--token [token]", "Auth token")
        .example("myapp mcp login https://example.com");

    const noop = struct {
        fn f(_: Cmd.Args, _: Cmd.Options) !void {}
    }.f;
    const Bound = Cmd.bind(noop);

    try std.testing.expectEqual(@as(usize, 2), Bound.command_name_parts.len);
    try std.testing.expectEqualStrings("mcp", Bound.command_name_parts[0]);
    try std.testing.expectEqualStrings("login", Bound.command_name_parts[1]);
    try std.testing.expectEqual(@as(usize, 1), Bound.command_arg_specs.len);
    try std.testing.expectEqualStrings("url", Bound.command_arg_specs[0].name);
    try std.testing.expectEqual(@as(usize, 1), Bound.command_opt_specs.len);
    try std.testing.expectEqual(@as(usize, 1), Bound.command_examples.len);
}
