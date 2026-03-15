/// zeke — type-safe CLI framework for Zig.
///
/// Build CLI commands with a comptime builder chain. Each .option() call
/// returns a new type with an additional field in the generated Options struct.
/// Action functions receive typed Args and Options structs — accessing a
/// non-existent field is a compile error.
///
/// Example:
///   const Serve = zeke.cmd("serve <entry>", "Start server")
///       .option("--port <port>", "Port number")
///       .option("--watch", "Watch mode");
///
///   fn serveAction(args: Serve.Args, opts: Serve.Options) !void {
///       // args.entry → []const u8 (required)
///       // opts.port  → []const u8 (required value)
///       // opts.watch → bool       (flag)
///   }
///
///   const ServeCmd = Serve.bind(serveAction);
///
///   var app = zeke.App(.{ ServeCmd }).init(allocator, "myapp");
///   try app.run();
const builder = @import("builder.zig");
const runtime = @import("runtime.zig");

pub const cmd = builder.cmd;
pub const App = runtime.App;

pub const OptionKind = builder.OptionKind;
pub const OptionSpec = builder.OptionSpec;
pub const ArgSpec = builder.ArgSpec;

test {
    @import("std").testing.refAllDecls(@This());
    _ = builder;
    _ = runtime;
}
