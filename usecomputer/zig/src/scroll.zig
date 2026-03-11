// Cross-platform native scroll event helpers for the usecomputer Zig module.

const std = @import("std");
const builtin = @import("builtin");

const c_macos = if (builtin.target.os.tag == .macos) @cImport({
    @cInclude("CoreGraphics/CoreGraphics.h");
    @cInclude("CoreFoundation/CoreFoundation.h");
}) else struct {};

const c_windows = if (builtin.target.os.tag == .windows) @cImport({
    @cInclude("windows.h");
}) else struct {};

const c_x11 = if (builtin.target.os.tag == .linux) @cImport({
    @cInclude("X11/Xlib.h");
    @cInclude("X11/extensions/XTest.h");
}) else struct {};

pub const ScrollArgs = struct {
    direction: []const u8,
    amount: f64,
    at_x: ?f64 = null,
    at_y: ?f64 = null,
};

const ScrollDirection = enum {
    up,
    down,
    left,
    right,
};

pub fn scroll(args: ScrollArgs) !void {
    const direction = try parseDirection(args.direction);
    const steps = try normalizeAmount(args.amount);

    switch (builtin.target.os.tag) {
        .macos => {
            try scrollMacos(.{ .direction = direction, .steps = steps, .at_x = args.at_x, .at_y = args.at_y });
        },
        .windows => {
            try scrollWindows(.{ .direction = direction, .steps = steps, .at_x = args.at_x, .at_y = args.at_y });
        },
        .linux => {
            try scrollX11(.{ .direction = direction, .steps = steps, .at_x = args.at_x, .at_y = args.at_y });
        },
        else => {
            return error.UnsupportedPlatform;
        },
    }
}

fn parseDirection(direction: []const u8) !ScrollDirection {
    if (std.ascii.eqlIgnoreCase(direction, "up")) {
        return .up;
    }
    if (std.ascii.eqlIgnoreCase(direction, "down")) {
        return .down;
    }
    if (std.ascii.eqlIgnoreCase(direction, "left")) {
        return .left;
    }
    if (std.ascii.eqlIgnoreCase(direction, "right")) {
        return .right;
    }
    return error.InvalidDirection;
}

fn normalizeAmount(amount: f64) !i32 {
    if (!std.math.isFinite(amount)) {
        return error.InvalidAmount;
    }
    const rounded = @as(i64, @intFromFloat(std.math.round(amount)));
    if (rounded <= 0) {
        return error.InvalidAmount;
    }
    if (rounded > std.math.maxInt(i32)) {
        return error.AmountTooLarge;
    }
    return @as(i32, @intCast(rounded));
}

fn scrollMacos(args: struct {
    direction: ScrollDirection,
    steps: i32,
    at_x: ?f64,
    at_y: ?f64,
}) !void {
    if (args.at_x != null and args.at_y != null) {
        const point: c_macos.CGPoint = .{ .x = args.at_x.?, .y = args.at_y.? };
        const warp_result = c_macos.CGWarpMouseCursorPosition(point);
        if (warp_result != c_macos.kCGErrorSuccess) {
            return error.CGWarpMouseFailed;
        }
    }

    var delta_y: i32 = 0;
    var delta_x: i32 = 0;
    switch (args.direction) {
        .up => {
            delta_y = args.steps;
        },
        .down => {
            delta_y = -args.steps;
        },
        .left => {
            delta_x = -args.steps;
        },
        .right => {
            delta_x = args.steps;
        },
    }

    const event = c_macos.CGEventCreateScrollWheelEvent(
        null,
        c_macos.kCGScrollEventUnitLine,
        2,
        delta_y,
        delta_x,
    );
    if (event == null) {
        return error.CGEventCreateFailed;
    }
    defer c_macos.CFRelease(event);

    if (args.at_x != null and args.at_y != null) {
        const location: c_macos.CGPoint = .{ .x = args.at_x.?, .y = args.at_y.? };
        c_macos.CGEventSetLocation(event, location);
    }

    c_macos.CGEventPost(c_macos.kCGHIDEventTap, event);
}

fn scrollWindows(args: struct {
    direction: ScrollDirection,
    steps: i32,
    at_x: ?f64,
    at_y: ?f64,
}) !void {
    if (args.at_x != null and args.at_y != null) {
        const x = @as(i64, @intFromFloat(std.math.round(args.at_x.?)));
        const y = @as(i64, @intFromFloat(std.math.round(args.at_y.?)));
        if (x < std.math.minInt(i32) or x > std.math.maxInt(i32) or y < std.math.minInt(i32) or y > std.math.maxInt(i32)) {
            return error.InvalidPoint;
        }
        _ = c_windows.SetCursorPos(@as(c_int, @intCast(x)), @as(c_int, @intCast(y)));
    }

    var flags: u32 = 0;
    var delta: i32 = 0;
    switch (args.direction) {
        .up => {
            flags = c_windows.MOUSEEVENTF_WHEEL;
            delta = args.steps;
        },
        .down => {
            flags = c_windows.MOUSEEVENTF_WHEEL;
            delta = -args.steps;
        },
        .left => {
            flags = c_windows.MOUSEEVENTF_HWHEEL;
            delta = -args.steps;
        },
        .right => {
            flags = c_windows.MOUSEEVENTF_HWHEEL;
            delta = args.steps;
        },
    }

    var event = std.mem.zeroes(c_windows.INPUT);
    event.type = c_windows.INPUT_MOUSE;
    event.Anonymous.mi.dwFlags = flags;
    event.Anonymous.mi.mouseData = @as(c_uint, @intCast(delta * c_windows.WHEEL_DELTA));
    const sent = c_windows.SendInput(1, &event, @sizeOf(c_windows.INPUT));
    if (sent == 0) {
        return error.EventPostFailed;
    }
}

fn scrollX11(args: struct {
    direction: ScrollDirection,
    steps: i32,
    at_x: ?f64,
    at_y: ?f64,
}) !void {
    const display = c_x11.XOpenDisplay(null) orelse return error.XOpenDisplayFailed;
    defer _ = c_x11.XCloseDisplay(display);

    if (args.at_x != null and args.at_y != null) {
        const x = @as(i64, @intFromFloat(std.math.round(args.at_x.?)));
        const y = @as(i64, @intFromFloat(std.math.round(args.at_y.?)));
        if (x < std.math.minInt(i32) or x > std.math.maxInt(i32) or y < std.math.minInt(i32) or y > std.math.maxInt(i32)) {
            return error.InvalidPoint;
        }
        _ = c_x11.XWarpPointer(display, 0, c_x11.XDefaultRootWindow(display), 0, 0, 0, 0, @as(c_int, @intCast(x)), @as(c_int, @intCast(y)));
    }

    const button_code: c_uint = switch (args.direction) {
        .up => 4,
        .down => 5,
        .left => 6,
        .right => 7,
    };

    const repeat_count: u32 = @as(u32, @intCast(args.steps));
    var index: u32 = 0;
    while (index < repeat_count) : (index += 1) {
        _ = c_x11.XTestFakeButtonEvent(display, button_code, c_x11.True, c_x11.CurrentTime);
        _ = c_x11.XTestFakeButtonEvent(display, button_code, c_x11.False, c_x11.CurrentTime);
    }
    _ = c_x11.XFlush(display);
}
