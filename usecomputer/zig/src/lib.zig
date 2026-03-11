// Native N-API module for usecomputer commands on macOS using Zig.
// First implementation step translates CUA macOS click semantics to Quartz
// events: post mouse down/up pairs at absolute coordinates with click state.

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

fn makeOkJson(allocator: std.mem.Allocator, data_json: []const u8) ![]const u8 {
    return std.fmt.allocPrint(allocator, "{{\"ok\":true,\"data\":{s}}}", .{data_json});
}

fn makeErrorJson(allocator: std.mem.Allocator, message: []const u8) ![]const u8 {
    return std.fmt.allocPrint(allocator, "{{\"ok\":false,\"error\":\"{s}\"}}", .{message});
}

fn execute(command: []const u8, payload_json: []const u8) ![]const u8 {
    const allocator = std.heap.c_allocator;

    if (std.mem.eql(u8, command, "click")) {
        return executeClickCommand(allocator, payload_json);
    }
    if (std.mem.eql(u8, command, "mouse-move")) {
        return executeMouseMoveCommand(allocator, payload_json);
    }
    if (std.mem.eql(u8, command, "mouse-down")) {
        return executeMouseDownCommand(allocator, payload_json);
    }
    if (std.mem.eql(u8, command, "mouse-up")) {
        return executeMouseUpCommand(allocator, payload_json);
    }
    if (std.mem.eql(u8, command, "mouse-position")) {
        return executeMousePositionCommand(allocator);
    }
    if (std.mem.eql(u8, command, "hover")) {
        return executeHoverCommand(allocator, payload_json);
    }
    if (std.mem.eql(u8, command, "drag")) {
        return executeDragCommand(allocator, payload_json);
    }

    if (std.mem.eql(u8, command, "display-list")) {
        return makeOkJson(allocator, "[]");
    }
    if (std.mem.eql(u8, command, "clipboard-get")) {
        return makeOkJson(allocator, "{\"text\":\"\"}");
    }
    if (std.mem.eql(u8, command, "screenshot")) {
        return executeScreenshotCommand(allocator, payload_json);
    }

    if (
        std.mem.eql(u8, command, "type-text") or
        std.mem.eql(u8, command, "press") or
        std.mem.eql(u8, command, "scroll") or
        std.mem.eql(u8, command, "clipboard-set")
    ) {
        const message = try std.fmt.allocPrint(allocator, "TODO not implemented: {s}", .{command});
        return makeErrorJson(allocator, message);
    }

    return makeErrorJson(allocator, "unknown command");
}

const ClickPoint = struct {
    x: f64,
    y: f64,
};

const ClickPayload = struct {
    point: ClickPoint,
    button: ?[]const u8 = null,
    count: ?u32 = null,
};

fn executeClickCommand(allocator: std.mem.Allocator, payload_json: []const u8) ![]const u8 {
    if (builtin.target.os.tag != .macos) {
        return makeErrorJson(allocator, "click is only supported on macOS");
    }

    var parsed = std.json.parseFromSlice(ClickPayload, allocator, payload_json, .{
        .ignore_unknown_fields = true,
    }) catch {
        return makeErrorJson(allocator, "invalid click payload json");
    };
    defer parsed.deinit();

    const click_payload = parsed.value;
    const click_count: u32 = if (click_payload.count) |count| blk: {
        if (count == 0) {
            break :blk 1;
        }
        break :blk count;
    } else 1;

    const button_kind = resolveMouseButton(click_payload.button orelse "left") catch {
        return makeErrorJson(allocator, "invalid click button");
    };

    const point: c.CGPoint = .{
        .x = click_payload.point.x,
        .y = click_payload.point.y,
    };

    var index: u32 = 0;
    while (index < click_count) : (index += 1) {
        const click_state = @as(i64, @intCast(index + 1));
        postClickPair(point, button_kind, click_state) catch {
            return makeErrorJson(allocator, "failed to post click event");
        };

        if (index + 1 < click_count) {
            std.Thread.sleep(80 * std.time.ns_per_ms);
        }
    }

    return makeOkJson(allocator, "null");
}

const MouseMovePayload = struct {
    x: f64,
    y: f64,
};

const MouseButtonPayload = struct {
    button: ?[]const u8 = null,
};

const DragPayload = struct {
    from: ClickPoint,
    to: ClickPoint,
    durationMs: ?u64 = null,
    button: ?[]const u8 = null,
};

const ScreenshotRegion = struct {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
};

const ScreenshotPayload = struct {
    path: ?[]const u8 = null,
    display: ?usize = null,
    region: ?ScreenshotRegion = null,
};

fn executeScreenshotCommand(allocator: std.mem.Allocator, payload_json: []const u8) ![]const u8 {
    if (builtin.target.os.tag != .macos) {
        return makeErrorJson(allocator, "screenshot is only supported on macOS");
    }

    var parsed = std.json.parseFromSlice(ScreenshotPayload, allocator, payload_json, .{
        .ignore_unknown_fields = true,
    }) catch {
        return makeErrorJson(allocator, "invalid screenshot payload json");
    };
    defer parsed.deinit();

    const screenshot_payload = parsed.value;
    const output_path = screenshot_payload.path orelse "./screenshot.png";

    const image = createScreenshotImage(.{
        .display_index = screenshot_payload.display,
        .region = screenshot_payload.region,
    }) catch {
        return makeErrorJson(allocator, "failed to capture screenshot image");
    };
    defer c.CFRelease(image);

    writeScreenshotPng(.{
        .image = image,
        .output_path = output_path,
    }) catch {
        return makeErrorJson(allocator, "failed to write screenshot file");
    };

    const path_json = try std.fmt.allocPrint(allocator, "\"{s}\"", .{output_path});
    const payload_json_response = try std.fmt.allocPrint(allocator, "{{\"path\":{s}}}", .{path_json});
    return makeOkJson(allocator, payload_json_response);
}

fn createScreenshotImage(input: struct {
    display_index: ?usize,
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

fn resolveDisplayId(display_index: ?usize) !c.CGDirectDisplayID {
    const selected_index = display_index orelse 0;
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

fn executeMouseMoveCommand(allocator: std.mem.Allocator, payload_json: []const u8) ![]const u8 {
    if (builtin.target.os.tag != .macos) {
        return makeErrorJson(allocator, "mouse-move is only supported on macOS");
    }

    var parsed = std.json.parseFromSlice(MouseMovePayload, allocator, payload_json, .{}) catch {
        return makeErrorJson(allocator, "invalid mouse-move payload json");
    };
    defer parsed.deinit();

    const point: c.CGPoint = .{
        .x = parsed.value.x,
        .y = parsed.value.y,
    };
    moveCursorToPoint(point) catch {
        return makeErrorJson(allocator, "failed to move mouse cursor");
    };

    return makeOkJson(allocator, "null");
}

fn executeMouseDownCommand(allocator: std.mem.Allocator, payload_json: []const u8) ![]const u8 {
    return executeMouseButtonCommand(allocator, payload_json, true);
}

fn executeMouseUpCommand(allocator: std.mem.Allocator, payload_json: []const u8) ![]const u8 {
    return executeMouseButtonCommand(allocator, payload_json, false);
}

fn executeMouseButtonCommand(allocator: std.mem.Allocator, payload_json: []const u8, is_down: bool) ![]const u8 {
    if (builtin.target.os.tag != .macos) {
        return makeErrorJson(allocator, "mouse button events are only supported on macOS");
    }

    var parsed = std.json.parseFromSlice(MouseButtonPayload, allocator, payload_json, .{}) catch {
        return makeErrorJson(allocator, "invalid mouse button payload json");
    };
    defer parsed.deinit();

    const button_kind = resolveMouseButton(parsed.value.button orelse "left") catch {
        return makeErrorJson(allocator, "invalid mouse button");
    };

    const point = currentCursorPoint() catch {
        return makeErrorJson(allocator, "failed to read cursor position");
    };

    postMouseButtonEvent(point, button_kind, is_down, 1) catch {
        return makeErrorJson(allocator, "failed to post mouse button event");
    };

    return makeOkJson(allocator, "null");
}

fn executeMousePositionCommand(allocator: std.mem.Allocator) ![]const u8 {
    if (builtin.target.os.tag != .macos) {
        return makeErrorJson(allocator, "mouse-position is only supported on macOS");
    }

    const point = currentCursorPoint() catch {
        return makeErrorJson(allocator, "failed to read cursor position");
    };

    const x = @as(i64, @intFromFloat(std.math.round(point.x)));
    const y = @as(i64, @intFromFloat(std.math.round(point.y)));
    const point_json = try std.fmt.allocPrint(allocator, "{{\"x\":{d},\"y\":{d}}}", .{ x, y });
    return makeOkJson(allocator, point_json);
}

fn executeHoverCommand(allocator: std.mem.Allocator, payload_json: []const u8) ![]const u8 {
    if (builtin.target.os.tag != .macos) {
        return makeErrorJson(allocator, "hover is only supported on macOS");
    }

    var parsed = std.json.parseFromSlice(MouseMovePayload, allocator, payload_json, .{}) catch {
        return makeErrorJson(allocator, "invalid hover payload json");
    };
    defer parsed.deinit();

    const point: c.CGPoint = .{
        .x = parsed.value.x,
        .y = parsed.value.y,
    };

    moveCursorToPoint(point) catch {
        return makeErrorJson(allocator, "failed to move cursor for hover");
    };

    return makeOkJson(allocator, "null");
}

fn executeDragCommand(allocator: std.mem.Allocator, payload_json: []const u8) ![]const u8 {
    if (builtin.target.os.tag != .macos) {
        return makeErrorJson(allocator, "drag is only supported on macOS");
    }

    var parsed = std.json.parseFromSlice(DragPayload, allocator, payload_json, .{}) catch {
        return makeErrorJson(allocator, "invalid drag payload json");
    };
    defer parsed.deinit();

    const drag_payload = parsed.value;
    const button_kind = resolveMouseButton(drag_payload.button orelse "left") catch {
        return makeErrorJson(allocator, "invalid drag button");
    };

    const from: c.CGPoint = .{ .x = drag_payload.from.x, .y = drag_payload.from.y };
    const to: c.CGPoint = .{ .x = drag_payload.to.x, .y = drag_payload.to.y };

    moveCursorToPoint(from) catch {
        return makeErrorJson(allocator, "failed to move cursor to drag origin");
    };

    postMouseButtonEvent(from, button_kind, true, 1) catch {
        return makeErrorJson(allocator, "failed to post drag mouse-down");
    };

    const total_duration_ns = (drag_payload.durationMs orelse 400) * std.time.ns_per_ms;
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
            return makeErrorJson(allocator, "failed during drag cursor movement");
        };

        if (step_duration_ns > 0 and index < step_count) {
            std.Thread.sleep(step_duration_ns);
        }
    }

    postMouseButtonEvent(to, button_kind, false, 1) catch {
        return makeErrorJson(allocator, "failed to post drag mouse-up");
    };

    return makeOkJson(allocator, "null");
}

const MouseButtonKind = enum {
    left,
    right,
    middle,
};

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
    try js.setNamedProperty(exports, "execute", try js.createFunction(execute));
    return exports;
}

comptime {
    if (!builtin.is_test) {
        napigen.defineModule(initModule);
    }
}
