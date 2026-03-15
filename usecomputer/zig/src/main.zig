/// Standalone CLI for usecomputer — no Node.js required.
/// Calls the same native functions as the N-API module via lib.zig.
const std = @import("std");
const zeke = @import("zeke");
const lib = @import("usecomputer_lib");

const File = std.fs.File;
const Writer = File.DeprecatedWriter;

fn getStdout() Writer {
    return File.stdout().deprecatedWriter();
}

fn getStderr() Writer {
    return File.stderr().deprecatedWriter();
}

// ─── Helpers ───

fn parseF64(s: []const u8) ?f64 {
    return std.fmt.parseFloat(f64, s) catch null;
}

fn parseRegion(s: []const u8) ?lib.ScreenshotRegion {
    // Parse "x,y,w,h" format
    var iter = std.mem.splitScalar(u8, s, ',');
    const x_str = iter.next() orelse return null;
    const y_str = iter.next() orelse return null;
    const w_str = iter.next() orelse return null;
    const h_str = iter.next() orelse return null;
    return .{
        .x = std.fmt.parseFloat(f64, x_str) catch return null,
        .y = std.fmt.parseFloat(f64, y_str) catch return null,
        .width = std.fmt.parseFloat(f64, w_str) catch return null,
        .height = std.fmt.parseFloat(f64, h_str) catch return null,
    };
}

fn printError(result: anytype) void {
    const stderr = getStderr();
    if (result.@"error") |err| {
        stderr.print("error: {s} ({s})\n", .{ err.message, err.code }) catch {};
    } else {
        stderr.print("error: command failed\n", .{}) catch {};
    }
}

fn printScreenshotJson(data: lib.ScreenshotOutput) void {
    const stdout = getStdout();
    stdout.print(
        "{{\"path\":\"{s}\",\"desktopIndex\":{d:.0},\"captureX\":{d:.0},\"captureY\":{d:.0},\"captureWidth\":{d:.0},\"captureHeight\":{d:.0},\"imageWidth\":{d:.0},\"imageHeight\":{d:.0}}}\n",
        .{ data.path, data.desktopIndex, data.captureX, data.captureY, data.captureWidth, data.captureHeight, data.imageWidth, data.imageHeight },
    ) catch {};
}

// ─── Command definitions ───

const Screenshot = zeke.cmd("screenshot [path]", "Take a screenshot")
    .option("--region [region]", "Capture specific region (x,y,w,h)")
    .option("--display [id]", "Target display")
    .option("--window [id]", "Target window")
    .option("--annotate", "Annotate with grid overlay")
    .option("--json", "Output as JSON");

const Click = zeke.cmd("click [target]", "Click at coordinates or target")
    .option("-x <x>", "X coordinate")
    .option("-y <y>", "Y coordinate")
    .option("--button [button]", "Mouse button: left, right, middle")
    .option("--count [count]", "Click count");

const DebugPoint = zeke.cmd("debug-point [target]", "Validate click coordinates visually")
    .option("-x [x]", "X coordinate")
    .option("-y [y]", "Y coordinate")
    .option("--output [path]", "Save annotated screenshot")
    .option("--json", "Output as JSON");

const TypeText = zeke.cmd("type [text]", "Type text using keyboard")
    .option("--delay [ms]", "Delay between keystrokes in ms");

const Press = zeke.cmd("press <key>", "Press a key or key combination")
    .option("--count [n]", "Number of times to press")
    .option("--delay [ms]", "Delay between presses in ms");

const Scroll = zeke.cmd("scroll <direction> [amount]", "Scroll in a direction")
    .option("--at [coords]", "Scroll at specific coordinates (x,y)");

const Drag = zeke.cmd("drag <from> <to>", "Drag from one point to another")
    .option("--duration [ms]", "Drag duration in ms")
    .option("--button [button]", "Mouse button");

const Hover = zeke.cmd("hover", "Move mouse without clicking")
    .option("-x <x>", "X coordinate")
    .option("-y <y>", "Y coordinate");

const MouseMove = zeke.cmd("mouse move", "Move to absolute coordinates")
    .option("-x <x>", "X coordinate")
    .option("-y <y>", "Y coordinate");

const MouseDown = zeke.cmd("mouse down", "Press and hold mouse button")
    .option("--button [button]", "Mouse button");

const MouseUp = zeke.cmd("mouse up", "Release mouse button")
    .option("--button [button]", "Mouse button");

const MousePosition = zeke.cmd("mouse position", "Print current mouse position")
    .option("--json", "Output as JSON");

const DisplayList = zeke.cmd("display list", "List connected displays")
    .option("--json", "Output as JSON");

const WindowList = zeke.cmd("window list", "List open windows")
    .option("--json", "Output as JSON");

const ClipboardGet = zeke.cmd("clipboard get", "Print clipboard text");

const ClipboardSet = zeke.cmd("clipboard set <text>", "Set clipboard text");

// ─── Action functions ───

fn screenshotAction(args: Screenshot.Args, opts: Screenshot.Options) !void {
    const result = lib.screenshot(.{
        .path = args.path,
        .display = if (opts.display) |d| parseF64(d) else null,
        .window = if (opts.window) |w| parseF64(w) else null,
        .region = if (opts.region) |r| parseRegion(r) else null,
        .annotate = opts.annotate,
    });
    if (!result.ok) {
        printError(result);
        return error.CommandFailed;
    }
    if (opts.json) {
        if (result.data) |data| {
            printScreenshotJson(data);
        }
    } else {
        const stdout = getStdout();
        if (result.data) |data| {
            try stdout.print("Screenshot saved to {s} ({d:.0}x{d:.0})\n", .{
                data.path, data.imageWidth, data.imageHeight,
            });
        }
    }
}

fn clickAction(_: Click.Args, opts: Click.Options) !void {
    const x = parseF64(opts.x) orelse return error.InvalidCoordinate;
    const y = parseF64(opts.y) orelse return error.InvalidCoordinate;
    const result = lib.click(.{
        .point = .{ .x = x, .y = y },
        .button = opts.button,
        .count = if (opts.count) |c| parseF64(c) else null,
    });
    if (!result.ok) {
        printError(result);
        return error.CommandFailed;
    }
}

fn debugPointAction(_: DebugPoint.Args, _: DebugPoint.Options) !void {
    const stderr = getStderr();
    try stderr.print("debug-point: TODO\n", .{});
}

fn typeTextAction(args: TypeText.Args, opts: TypeText.Options) !void {
    const text = args.text orelse {
        const stderr = getStderr();
        try stderr.print("error: text argument required\n", .{});
        return error.MissingArgument;
    };
    const result = lib.typeText(.{
        .text = text,
        .delayMs = if (opts.delay) |d| parseF64(d) else null,
    });
    if (!result.ok) {
        printError(result);
        return error.CommandFailed;
    }
}

fn pressAction(args: Press.Args, opts: Press.Options) !void {
    const result = lib.press(.{
        .key = args.key,
        .count = if (opts.count) |c| parseF64(c) else null,
        .delayMs = if (opts.delay) |d| parseF64(d) else null,
    });
    if (!result.ok) {
        printError(result);
        return error.CommandFailed;
    }
}

fn scrollAction(args: Scroll.Args, opts: Scroll.Options) !void {
    const amount: f64 = if (args.amount) |a| (parseF64(a) orelse 3.0) else 3.0;
    var at: ?lib.Point = null;
    if (opts.at) |at_str| {
        var iter = std.mem.splitScalar(u8, at_str, ',');
        const x_str = iter.next() orelse return error.InvalidCoordinate;
        const y_str = iter.next() orelse return error.InvalidCoordinate;
        at = .{
            .x = std.fmt.parseFloat(f64, x_str) catch return error.InvalidCoordinate,
            .y = std.fmt.parseFloat(f64, y_str) catch return error.InvalidCoordinate,
        };
    }
    const result = lib.scroll(.{
        .direction = args.direction,
        .amount = amount,
        .at = at,
    });
    if (!result.ok) {
        printError(result);
        return error.CommandFailed;
    }
}

fn dragAction(args: Drag.Args, opts: Drag.Options) !void {
    // Parse "x,y" format for from and to
    const from = parsePointArg(args.from) orelse return error.InvalidCoordinate;
    const to = parsePointArg(args.to) orelse return error.InvalidCoordinate;
    const result = lib.drag(.{
        .from = from,
        .to = to,
        .durationMs = if (opts.duration) |d| parseF64(d) else null,
        .button = opts.button,
    });
    if (!result.ok) {
        printError(result);
        return error.CommandFailed;
    }
}

fn parsePointArg(s: []const u8) ?lib.Point {
    var iter = std.mem.splitScalar(u8, s, ',');
    const x_str = iter.next() orelse return null;
    const y_str = iter.next() orelse return null;
    return .{
        .x = std.fmt.parseFloat(f64, x_str) catch return null,
        .y = std.fmt.parseFloat(f64, y_str) catch return null,
    };
}

fn hoverAction(_: Hover.Args, opts: Hover.Options) !void {
    const x = parseF64(opts.x) orelse return error.InvalidCoordinate;
    const y = parseF64(opts.y) orelse return error.InvalidCoordinate;
    const result = lib.hover(.{ .x = x, .y = y });
    if (!result.ok) {
        printError(result);
        return error.CommandFailed;
    }
}

fn mouseMoveAction(_: MouseMove.Args, opts: MouseMove.Options) !void {
    const x = parseF64(opts.x) orelse return error.InvalidCoordinate;
    const y = parseF64(opts.y) orelse return error.InvalidCoordinate;
    const result = lib.mouseMove(.{ .x = x, .y = y });
    if (!result.ok) {
        printError(result);
        return error.CommandFailed;
    }
}

fn mouseDownAction(_: MouseDown.Args, opts: MouseDown.Options) !void {
    const result = lib.mouseDown(.{ .button = opts.button });
    if (!result.ok) {
        printError(result);
        return error.CommandFailed;
    }
}

fn mouseUpAction(_: MouseUp.Args, opts: MouseUp.Options) !void {
    const result = lib.mouseUp(.{ .button = opts.button });
    if (!result.ok) {
        printError(result);
        return error.CommandFailed;
    }
}

fn mousePositionAction(_: MousePosition.Args, opts: MousePosition.Options) !void {
    const result = lib.mousePosition();
    if (!result.ok) {
        printError(result);
        return error.CommandFailed;
    }
    if (result.data) |pos| {
        const stdout = getStdout();
        if (opts.json) {
            try stdout.print("{{\"x\":{d:.0},\"y\":{d:.0}}}\n", .{ pos.x, pos.y });
        } else {
            try stdout.print("{d:.0}, {d:.0}\n", .{ pos.x, pos.y });
        }
    }
}

fn displayListAction(_: DisplayList.Args, opts: DisplayList.Options) !void {
    const result = lib.displayList();
    if (!result.ok) {
        printError(result);
        return error.CommandFailed;
    }
    if (result.data) |data| {
        const stdout = getStdout();
        if (opts.json) {
            try stdout.print("{s}\n", .{data});
        } else {
            try stdout.print("{s}\n", .{data});
        }
    }
}

fn windowListAction(_: WindowList.Args, opts: WindowList.Options) !void {
    const result = lib.windowList();
    if (!result.ok) {
        printError(result);
        return error.CommandFailed;
    }
    if (result.data) |data| {
        const stdout = getStdout();
        if (opts.json) {
            try stdout.print("{s}\n", .{data});
        } else {
            try stdout.print("{s}\n", .{data});
        }
    }
}

fn clipboardGetAction(_: ClipboardGet.Args, _: ClipboardGet.Options) !void {
    const result = lib.clipboardGet();
    if (!result.ok) {
        printError(result);
        return error.CommandFailed;
    }
    if (result.data) |data| {
        const stdout = getStdout();
        try stdout.print("{s}\n", .{data});
    }
}

fn clipboardSetAction(args: ClipboardSet.Args, _: ClipboardSet.Options) !void {
    const result = lib.clipboardSet(.{ .text = args.text });
    if (!result.ok) {
        printError(result);
        return error.CommandFailed;
    }
}

// ─── Main ───

pub fn main() !void {
    var gpa = std.heap.GeneralPurposeAllocator(.{}){};
    defer _ = gpa.deinit();

    var app = zeke.App(.{
        Screenshot.bind(screenshotAction),
        Click.bind(clickAction),
        DebugPoint.bind(debugPointAction),
        TypeText.bind(typeTextAction),
        Press.bind(pressAction),
        Scroll.bind(scrollAction),
        Drag.bind(dragAction),
        Hover.bind(hoverAction),
        MouseMove.bind(mouseMoveAction),
        MouseDown.bind(mouseDownAction),
        MouseUp.bind(mouseUpAction),
        MousePosition.bind(mousePositionAction),
        DisplayList.bind(displayListAction),
        WindowList.bind(windowListAction),
        ClipboardGet.bind(clipboardGetAction),
        ClipboardSet.bind(clipboardSetAction),
    }).init(gpa.allocator(), "usecomputer");

    app.setVersion("0.0.4");
    app.run() catch |err| {
        switch (err) {
            error.CommandFailed, error.InvalidCoordinate, error.MissingArgument => {},
            else => {
                const stderr = getStderr();
                stderr.print("error: {s}\n", .{@errorName(err)}) catch {};
            },
        }
        std.process.exit(1);
    };
}
