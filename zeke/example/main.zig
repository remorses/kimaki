/// Example CLI built with zeke — a minimal usecomputer-style tool.
const std = @import("std");
const zeke = @import("zeke");

fn getStdout() std.fs.File.DeprecatedWriter {
    return std.fs.File.stdout().deprecatedWriter();
}

// ─── Command definitions ───

const Screenshot = zeke.cmd("screenshot [path]", "Take a screenshot")
    .option("--region [region]", "Capture specific region (x,y,w,h)")
    .option("--display [id]", "Target display")
    .option("--annotate", "Annotate with grid overlay")
    .option("--json", "Output as JSON");

const Click = zeke.cmd("click [target]", "Click at coordinates or target")
    .option("-x [x]", "X coordinate")
    .option("-y [y]", "Y coordinate")
    .option("--button [button]", "Mouse button: left, right, middle")
    .option("--count [count]", "Click count")
    .option("--coord-map [map]", "Coordinate mapping: x1,y1,x2,y2,w,h");

const Press = zeke.cmd("press <key>", "Press a key or key combination")
    .option("--count [count]", "Number of times to press")
    .option("--delay [ms]", "Delay between presses in ms");

const Scroll = zeke.cmd("scroll <direction> [amount]", "Scroll in a direction")
    .option("--at [coords]", "Scroll at specific coordinates (x,y)");

const MouseMove = zeke.cmd("mouse move [x] [y]", "Move to absolute coordinates")
    .option("--coord-map [map]", "Coordinate mapping");

const MousePosition = zeke.cmd("mouse position", "Print current mouse position")
    .option("--json", "Output as JSON");

const DisplayList = zeke.cmd("display list", "List connected displays")
    .option("--json", "Output as JSON");

const ClipboardGet = zeke.cmd("clipboard get", "Print clipboard text");

const ClipboardSet = zeke.cmd("clipboard set <text>", "Set clipboard text");

// ─── Action functions (typed) ───

fn screenshotAction(args: Screenshot.Args, opts: Screenshot.Options) !void {
    const stdout = getStdout();
    if (opts.json) {
        try stdout.print("{{\"action\":\"screenshot\",\"path\":\"{?s}\"}}\n", .{args.path});
    } else {
        try stdout.print("Taking screenshot", .{});
        if (args.path) |p| {
            try stdout.print(" → {s}", .{p});
        }
        if (opts.region) |r| {
            try stdout.print(" (region: {s})", .{r});
        }
        if (opts.annotate) {
            try stdout.print(" [annotated]", .{});
        }
        try stdout.writeByte('\n');
    }
}

fn clickAction(args: Click.Args, opts: Click.Options) !void {
    const stdout = getStdout();
    const button = opts.button orelse "left";
    const count = opts.count orelse "1";
    try stdout.print("Click {s} x{s}", .{ button, count });
    if (opts.x) |x| {
        try stdout.print(" at ({s}", .{x});
        if (opts.y) |y| {
            try stdout.print(",{s})", .{y});
        } else {
            try stdout.print(",?)", .{});
        }
    }
    if (args.target) |t| {
        try stdout.print(" target={s}", .{t});
    }
    try stdout.writeByte('\n');
}

fn pressAction(args: Press.Args, opts: Press.Options) !void {
    const stdout = getStdout();
    const count = opts.count orelse "1";
    try stdout.print("Press '{s}' x{s}\n", .{ args.key, count });
    if (opts.delay) |d| {
        try stdout.print("  delay: {s}ms\n", .{d});
    }
}

fn scrollAction(args: Scroll.Args, opts: Scroll.Options) !void {
    const stdout = getStdout();
    try stdout.print("Scroll {s}", .{args.direction});
    if (args.amount) |a| {
        try stdout.print(" {s}", .{a});
    }
    if (opts.at) |at| {
        try stdout.print(" at ({s})", .{at});
    }
    try stdout.writeByte('\n');
}

fn mouseMoveAction(args: MouseMove.Args, opts: MouseMove.Options) !void {
    const stdout = getStdout();
    try stdout.print("Mouse move", .{});
    if (args.x) |x| {
        try stdout.print(" x={s}", .{x});
    }
    if (args.y) |y| {
        try stdout.print(" y={s}", .{y});
    }
    _ = opts;
    try stdout.writeByte('\n');
}

fn mousePositionAction(_: MousePosition.Args, opts: MousePosition.Options) !void {
    const stdout = getStdout();
    if (opts.json) {
        try stdout.print("{{\"x\":100,\"y\":200}}\n", .{});
    } else {
        try stdout.print("Position: 100, 200\n", .{});
    }
}

fn displayListAction(_: DisplayList.Args, opts: DisplayList.Options) !void {
    const stdout = getStdout();
    if (opts.json) {
        try stdout.print("[{{\"id\":1,\"name\":\"Main\"}}]\n", .{});
    } else {
        try stdout.print("1: Main (2560x1440)\n", .{});
    }
}

fn clipboardGetAction(_: ClipboardGet.Args, _: ClipboardGet.Options) !void {
    const stdout = getStdout();
    try stdout.print("(clipboard contents)\n", .{});
}

fn clipboardSetAction(args: ClipboardSet.Args, _: ClipboardSet.Options) !void {
    const stdout = getStdout();
    try stdout.print("Clipboard set to: {s}\n", .{args.text});
}

// ─── Main ───

pub fn main() !void {
    var gpa = std.heap.GeneralPurposeAllocator(.{}){};
    defer _ = gpa.deinit();

    var app = zeke.App(.{
        Screenshot.bind(screenshotAction),
        Click.bind(clickAction),
        Press.bind(pressAction),
        Scroll.bind(scrollAction),
        MouseMove.bind(mouseMoveAction),
        MousePosition.bind(mousePositionAction),
        DisplayList.bind(displayListAction),
        ClipboardGet.bind(clipboardGetAction),
        ClipboardSet.bind(clipboardSetAction),
    }).init(gpa.allocator(), "usecomputer");

    app.setVersion("0.1.0");
    try app.run();
}
