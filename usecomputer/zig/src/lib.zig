// Native N-API module for usecomputer commands on macOS using Zig.
// Exports direct typed methods (no string command dispatcher) so TS can call
// high-level native functions and receive structured error objects.

const std = @import("std");
const builtin = @import("builtin");
const napigen = if (builtin.is_test) undefined else @import("napigen");
const c = if (builtin.target.os.tag == .macos) @cImport({
    @cInclude("CoreGraphics/CoreGraphics.h");
    @cInclude("CoreFoundation/CoreFoundation.h");
    @cInclude("ImageIO/ImageIO.h");
}) else struct {};

pub const std_options: std.Options = .{
    .log_level = .err,
};

const NativeErrorObject = struct {
    code: []const u8,
    message: []const u8,
    command: []const u8,
};

const CommandResult = struct {
    ok: bool,
    @"error": ?NativeErrorObject = null,
};

fn DataResult(comptime T: type) type {
    return struct {
        ok: bool,
        data: ?T = null,
        @"error": ?NativeErrorObject = null,
    };
}

fn okCommand() CommandResult {
    return .{ .ok = true };
}

fn failCommand(command: []const u8, code: []const u8, message: []const u8) CommandResult {
    return .{
        .ok = false,
        .@"error" = .{
            .code = code,
            .message = message,
            .command = command,
        },
    };
}

fn okData(comptime T: type, value: T) DataResult(T) {
    return .{
        .ok = true,
        .data = value,
    };
}

fn failData(comptime T: type, command: []const u8, code: []const u8, message: []const u8) DataResult(T) {
    return .{
        .ok = false,
        .@"error" = .{
            .code = code,
            .message = message,
            .command = command,
        },
    };
}

fn todoNotImplemented(command: []const u8) CommandResult {
    return failCommand(command, "TODO_NOT_IMPLEMENTED", "TODO not implemented");
}

const Point = struct {
    x: f64,
    y: f64,
};

const MouseButtonKind = enum {
    left,
    right,
    middle,
};

const ClickInput = struct {
    point: Point,
    button: ?[]const u8 = null,
    count: ?f64 = null,
};

const MouseMoveInput = Point;

const MouseButtonInput = struct {
    button: ?[]const u8 = null,
};

const DragInput = struct {
    from: Point,
    to: Point,
    durationMs: ?f64 = null,
    button: ?[]const u8 = null,
};

const ScreenshotRegion = struct {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
};

const ScreenshotInput = struct {
    path: ?[]const u8 = null,
    display: ?f64 = null,
    region: ?ScreenshotRegion = null,
    annotate: ?bool = null,
};

const ScreenshotOutput = struct {
    path: []const u8,
};

const TypeTextInput = struct {
    text: []const u8,
    delayMs: ?f64 = null,
};

const PressInput = struct {
    key: []const u8,
    count: ?f64 = null,
    delayMs: ?f64 = null,
};

const ScrollInput = struct {
    direction: []const u8,
    amount: f64,
    at: ?Point = null,
};

const ClipboardSetInput = struct {
    text: []const u8,
};

pub fn screenshot(input: ScreenshotInput) DataResult(ScreenshotOutput) {
    if (builtin.target.os.tag != .macos) {
        return failData(ScreenshotOutput, "screenshot", "UNSUPPORTED_PLATFORM", "screenshot is only supported on macOS");
    }

    _ = input.annotate;
    const output_path = input.path orelse "./screenshot.png";

    const image = createScreenshotImage(.{
        .display_index = input.display,
        .region = input.region,
    }) catch {
        return failData(ScreenshotOutput, "screenshot", "CAPTURE_FAILED", "failed to capture screenshot image");
    };
    defer c.CFRelease(image);

    writeScreenshotPng(.{
        .image = image,
        .output_path = output_path,
    }) catch {
        return failData(ScreenshotOutput, "screenshot", "WRITE_FAILED", "failed to write screenshot file");
    };

    return okData(ScreenshotOutput, .{ .path = output_path });
}

pub fn click(input: ClickInput) CommandResult {
    if (builtin.target.os.tag != .macos) {
        return failCommand("click", "UNSUPPORTED_PLATFORM", "click is only supported on macOS");
    }

    const click_count: u32 = if (input.count) |count| blk: {
        const normalized = @as(i64, @intFromFloat(std.math.round(count)));
        if (normalized <= 0) {
            break :blk 1;
        }
        break :blk @as(u32, @intCast(normalized));
    } else 1;

    const button_kind = resolveMouseButton(input.button orelse "left") catch {
        return failCommand("click", "INVALID_INPUT", "invalid click button");
    };

    const point: c.CGPoint = .{
        .x = input.point.x,
        .y = input.point.y,
    };

    var index: u32 = 0;
    while (index < click_count) : (index += 1) {
        const click_state = @as(i64, @intCast(index + 1));
        postClickPair(point, button_kind, click_state) catch {
            return failCommand("click", "EVENT_POST_FAILED", "failed to post click event");
        };

        if (index + 1 < click_count) {
            std.Thread.sleep(80 * std.time.ns_per_ms);
        }
    }

    return okCommand();
}

pub fn mouseMove(input: MouseMoveInput) CommandResult {
    if (builtin.target.os.tag != .macos) {
        return failCommand("mouse-move", "UNSUPPORTED_PLATFORM", "mouse-move is only supported on macOS");
    }

    const point: c.CGPoint = .{
        .x = input.x,
        .y = input.y,
    };
    moveCursorToPoint(point) catch {
        return failCommand("mouse-move", "EVENT_POST_FAILED", "failed to move mouse cursor");
    };

    return okCommand();
}

pub fn mouseDown(input: MouseButtonInput) CommandResult {
    return handleMouseButtonInput(.{ .input = input, .is_down = true });
}

pub fn mouseUp(input: MouseButtonInput) CommandResult {
    return handleMouseButtonInput(.{ .input = input, .is_down = false });
}

fn handleMouseButtonInput(args: struct {
    input: MouseButtonInput,
    is_down: bool,
}) CommandResult {
    if (builtin.target.os.tag != .macos) {
        return failCommand("mouse-button", "UNSUPPORTED_PLATFORM", "mouse button events are only supported on macOS");
    }

    const button_kind = resolveMouseButton(args.input.button orelse "left") catch {
        return failCommand("mouse-button", "INVALID_INPUT", "invalid mouse button");
    };

    const point = currentCursorPoint() catch {
        return failCommand("mouse-button", "CURSOR_READ_FAILED", "failed to read cursor position");
    };

    postMouseButtonEvent(point, button_kind, args.is_down, 1) catch {
        return failCommand("mouse-button", "EVENT_POST_FAILED", "failed to post mouse button event");
    };

    return okCommand();
}

pub fn mousePosition() DataResult(Point) {
    if (builtin.target.os.tag != .macos) {
        return failData(Point, "mouse-position", "UNSUPPORTED_PLATFORM", "mouse-position is only supported on macOS");
    }

    const point = currentCursorPoint() catch {
        return failData(Point, "mouse-position", "CURSOR_READ_FAILED", "failed to read cursor position");
    };

    return okData(Point, .{ .x = std.math.round(point.x), .y = std.math.round(point.y) });
}

pub fn hover(input: Point) CommandResult {
    return mouseMove(input);
}

pub fn drag(input: DragInput) CommandResult {
    if (builtin.target.os.tag != .macos) {
        return failCommand("drag", "UNSUPPORTED_PLATFORM", "drag is only supported on macOS");
    }

    const button_kind = resolveMouseButton(input.button orelse "left") catch {
        return failCommand("drag", "INVALID_INPUT", "invalid drag button");
    };

    const from: c.CGPoint = .{ .x = input.from.x, .y = input.from.y };
    const to: c.CGPoint = .{ .x = input.to.x, .y = input.to.y };

    moveCursorToPoint(from) catch {
        return failCommand("drag", "EVENT_POST_FAILED", "failed to move cursor to drag origin");
    };

    postMouseButtonEvent(from, button_kind, true, 1) catch {
        return failCommand("drag", "EVENT_POST_FAILED", "failed to post drag mouse-down");
    };

    const duration_ms = if (input.durationMs) |value| blk: {
        const normalized = @as(i64, @intFromFloat(std.math.round(value)));
        if (normalized <= 0) {
            break :blk 400;
        }
        break :blk normalized;
    } else 400;
    const total_duration_ns = @as(u64, @intCast(duration_ms)) * std.time.ns_per_ms;
    const step_count: u64 = 16;
    const step_duration_ns = if (step_count == 0) 0 else total_duration_ns / step_count;

    var index: u64 = 1;
    while (index <= step_count) : (index += 1) {
        const fraction = @as(f64, @floatFromInt(index)) / @as(f64, @floatFromInt(step_count));
        const next_point: c.CGPoint = .{
            .x = from.x + (to.x - from.x) * fraction,
            .y = from.y + (to.y - from.y) * fraction,
        };

        moveCursorToPoint(next_point) catch {
            return failCommand("drag", "EVENT_POST_FAILED", "failed during drag cursor movement");
        };

        if (step_duration_ns > 0 and index < step_count) {
            std.Thread.sleep(step_duration_ns);
        }
    }

    postMouseButtonEvent(to, button_kind, false, 1) catch {
        return failCommand("drag", "EVENT_POST_FAILED", "failed to post drag mouse-up");
    };

    return okCommand();
}

pub fn displayList() CommandResult {
    return todoNotImplemented("display-list");
}

pub fn clipboardGet() DataResult([]const u8) {
    return failData([]const u8, "clipboard-get", "TODO_NOT_IMPLEMENTED", "TODO not implemented: clipboard-get");
}

pub fn clipboardSet(input: ClipboardSetInput) CommandResult {
    _ = input;
    return todoNotImplemented("clipboard-set");
}

pub fn typeText(input: TypeTextInput) CommandResult {
    _ = input;
    return todoNotImplemented("type-text");
}

pub fn press(input: PressInput) CommandResult {
    _ = input;
    return todoNotImplemented("press");
}

pub fn scroll(input: ScrollInput) CommandResult {
    _ = input;
    return todoNotImplemented("scroll");
}

fn createScreenshotImage(input: struct {
    display_index: ?f64,
    region: ?ScreenshotRegion,
}) !c.CGImageRef {
    const display_id = resolveDisplayId(input.display_index) catch {
        return error.DisplayResolutionFailed;
    };

    if (input.region) |region| {
        const rect: c.CGRect = .{
            .origin = .{ .x = region.x, .y = region.y },
            .size = .{ .width = region.width, .height = region.height },
        };
        const region_image = c.CGDisplayCreateImageForRect(display_id, rect);
        if (region_image == null) {
            return error.CaptureFailed;
        }
        return region_image;
    }

    const full_image = c.CGDisplayCreateImage(display_id);
    if (full_image == null) {
        return error.CaptureFailed;
    }
    return full_image;
}

fn resolveDisplayId(display_index: ?f64) !c.CGDirectDisplayID {
    const selected_index: usize = if (display_index) |value| blk: {
        const normalized = @as(i64, @intFromFloat(std.math.round(value)));
        if (normalized < 0) {
            return error.InvalidDisplayIndex;
        }
        break :blk @as(usize, @intCast(normalized));
    } else 0;
    var display_ids: [16]c.CGDirectDisplayID = undefined;
    var display_count: u32 = 0;
    const list_result = c.CGGetActiveDisplayList(display_ids.len, &display_ids, &display_count);
    if (list_result != c.kCGErrorSuccess) {
        return error.DisplayQueryFailed;
    }
    if (selected_index >= display_count) {
        return error.InvalidDisplayIndex;
    }
    return display_ids[selected_index];
}

fn writeScreenshotPng(input: struct {
    image: c.CGImageRef,
    output_path: []const u8,
}) !void {
    const path_as_u8: [*]const u8 = @ptrCast(input.output_path.ptr);
    const file_url = c.CFURLCreateFromFileSystemRepresentation(
        null,
        path_as_u8,
        @as(c_long, @intCast(input.output_path.len)),
        0,
    );
    if (file_url == null) {
        return error.FileUrlCreateFailed;
    }
    defer c.CFRelease(file_url);

    const png_type = c.CFStringCreateWithCString(null, "public.png", c.kCFStringEncodingUTF8);
    if (png_type == null) {
        return error.PngTypeCreateFailed;
    }
    defer c.CFRelease(png_type);

    const destination = c.CGImageDestinationCreateWithURL(file_url, png_type, 1, null);
    if (destination == null) {
        return error.ImageDestinationCreateFailed;
    }
    defer c.CFRelease(destination);

    c.CGImageDestinationAddImage(destination, input.image, null);
    const did_finalize = c.CGImageDestinationFinalize(destination);
    if (!did_finalize) {
        return error.ImageDestinationFinalizeFailed;
    }
}

fn resolveMouseButton(button: []const u8) !MouseButtonKind {
    if (std.ascii.eqlIgnoreCase(button, "left")) {
        return .left;
    }
    if (std.ascii.eqlIgnoreCase(button, "right")) {
        return .right;
    }
    if (std.ascii.eqlIgnoreCase(button, "middle")) {
        return .middle;
    }
    return error.InvalidMouseButton;
}

fn postClickPair(point: c.CGPoint, button: MouseButtonKind, click_state: i64) !void {
    try postMouseButtonEvent(point, button, true, click_state);
    try postMouseButtonEvent(point, button, false, click_state);
}

fn postMouseButtonEvent(point: c.CGPoint, button: MouseButtonKind, is_down: bool, click_state: i64) !void {
    const button_code: c.CGMouseButton = switch (button) {
        .left => c.kCGMouseButtonLeft,
        .right => c.kCGMouseButtonRight,
        .middle => c.kCGMouseButtonCenter,
    };

    const event_type: c.CGEventType = switch (button) {
        .left => if (is_down) c.kCGEventLeftMouseDown else c.kCGEventLeftMouseUp,
        .right => if (is_down) c.kCGEventRightMouseDown else c.kCGEventRightMouseUp,
        .middle => if (is_down) c.kCGEventOtherMouseDown else c.kCGEventOtherMouseUp,
    };

    const event = c.CGEventCreateMouseEvent(null, event_type, point, button_code);
    if (event == null) {
        return error.CGEventCreateFailed;
    }
    defer c.CFRelease(event);

    c.CGEventSetIntegerValueField(event, c.kCGMouseEventClickState, click_state);
    c.CGEventPost(c.kCGHIDEventTap, event);
}

fn currentCursorPoint() !c.CGPoint {
    const event = c.CGEventCreate(null);
    if (event == null) {
        return error.CGEventCreateFailed;
    }
    defer c.CFRelease(event);
    return c.CGEventGetLocation(event);
}

fn moveCursorToPoint(point: c.CGPoint) !void {
    const warp_result = c.CGWarpMouseCursorPosition(point);
    if (warp_result != c.kCGErrorSuccess) {
        return error.CGWarpMouseFailed;
    }

    const move_event = c.CGEventCreateMouseEvent(null, c.kCGEventMouseMoved, point, c.kCGMouseButtonLeft);
    if (move_event == null) {
        return error.CGEventCreateFailed;
    }
    defer c.CFRelease(move_event);
    c.CGEventPost(c.kCGHIDEventTap, move_event);
}

fn initModule(js: *napigen.JsContext, exports: napigen.napi_value) !napigen.napi_value {
    try js.setNamedProperty(exports, "screenshot", try js.createFunction(screenshot));
    try js.setNamedProperty(exports, "click", try js.createFunction(click));
    try js.setNamedProperty(exports, "typeText", try js.createFunction(typeText));
    try js.setNamedProperty(exports, "press", try js.createFunction(press));
    try js.setNamedProperty(exports, "scroll", try js.createFunction(scroll));
    try js.setNamedProperty(exports, "drag", try js.createFunction(drag));
    try js.setNamedProperty(exports, "hover", try js.createFunction(hover));
    try js.setNamedProperty(exports, "mouseMove", try js.createFunction(mouseMove));
    try js.setNamedProperty(exports, "mouseDown", try js.createFunction(mouseDown));
    try js.setNamedProperty(exports, "mouseUp", try js.createFunction(mouseUp));
    try js.setNamedProperty(exports, "mousePosition", try js.createFunction(mousePosition));
    try js.setNamedProperty(exports, "displayList", try js.createFunction(displayList));
    try js.setNamedProperty(exports, "clipboardGet", try js.createFunction(clipboardGet));
    try js.setNamedProperty(exports, "clipboardSet", try js.createFunction(clipboardSet));
    return exports;
}

comptime {
    if (!builtin.is_test) {
        napigen.defineModule(initModule);
    }
}
