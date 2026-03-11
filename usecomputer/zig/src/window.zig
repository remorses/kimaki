// Helpers for querying visible macOS windows via stable CoreGraphics APIs.

const std = @import("std");
const builtin = @import("builtin");

const c = if (builtin.target.os.tag == .macos) @cImport({
    @cInclude("CoreGraphics/CoreGraphics.h");
    @cInclude("CoreFoundation/CoreFoundation.h");
}) else struct {};

pub const Rect = struct {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
};

pub const WindowInfo = struct {
    id: u32,
    owner_pid: i32,
    owner_name: []const u8,
    title: []const u8,
    bounds: Rect,
};

pub fn forEachVisibleWindow(
    comptime Context: type,
    context: *Context,
    callback: *const fn (ctx: *Context, info: WindowInfo) anyerror!void,
) !void {
    if (builtin.target.os.tag != .macos) {
        return error.UnsupportedPlatform;
    }

    const options = c.kCGWindowListOptionOnScreenOnly | c.kCGWindowListExcludeDesktopElements;
    const windows = c.CGWindowListCopyWindowInfo(options, c.kCGNullWindowID);
    if (windows == null) {
        return error.WindowQueryFailed;
    }
    defer c.CFRelease(windows);

    const count: usize = @intCast(c.CFArrayGetCount(windows));
    var i: usize = 0;
    while (i < count) : (i += 1) {
        const value = c.CFArrayGetValueAtIndex(windows, @intCast(i));
        if (value == null) {
            continue;
        }

        const dictionary: c.CFDictionaryRef = @ptrCast(value);

        var id_raw: i64 = 0;
        if (!readNumberI64(dictionary, c.kCGWindowNumber, &id_raw)) {
            continue;
        }
        if (id_raw <= 0) {
            continue;
        }

        var owner_pid_raw: i64 = 0;
        if (!readNumberI64(dictionary, c.kCGWindowOwnerPID, &owner_pid_raw)) {
            owner_pid_raw = 0;
        }

        var bounds: c.CGRect = undefined;
        if (!readBoundsRect(dictionary, &bounds)) {
            continue;
        }

        var owner_name_buffer: [256]u8 = undefined;
        const owner_name = readString(dictionary, c.kCGWindowOwnerName, &owner_name_buffer);
        var title_buffer: [256]u8 = undefined;
        const title = readString(dictionary, c.kCGWindowName, &title_buffer);

        try callback(context, .{
            .id = @intCast(id_raw),
            .owner_pid = @intCast(owner_pid_raw),
            .owner_name = owner_name,
            .title = title,
            .bounds = .{
                .x = std.math.round(bounds.origin.x),
                .y = std.math.round(bounds.origin.y),
                .width = std.math.round(bounds.size.width),
                .height = std.math.round(bounds.size.height),
            },
        });
    }
}

fn readNumberI64(dictionary: c.CFDictionaryRef, key: c.CFStringRef, out: *i64) bool {
    const value = c.CFDictionaryGetValue(dictionary, key);
    if (value == null) {
        return false;
    }
    const number: c.CFNumberRef = @ptrCast(value);
    return c.CFNumberGetValue(number, c.kCFNumberSInt64Type, out) != 0;
}

fn readBoundsRect(dictionary: c.CFDictionaryRef, out: *c.CGRect) bool {
    const value = c.CFDictionaryGetValue(dictionary, c.kCGWindowBounds);
    if (value == null) {
        return false;
    }
    const bounds_dictionary: c.CFDictionaryRef = @ptrCast(value);
    return c.CGRectMakeWithDictionaryRepresentation(bounds_dictionary, out);
}

fn readString(
    dictionary: c.CFDictionaryRef,
    key: c.CFStringRef,
    buffer: *[256]u8,
) []const u8 {
    const value = c.CFDictionaryGetValue(dictionary, key);
    if (value == null) {
        return "";
    }
    const str_ref: c.CFStringRef = @ptrCast(value);
    if (c.CFStringGetCString(str_ref, buffer, buffer.len, c.kCFStringEncodingUTF8) == 0) {
        return "";
    }
    const content = std.mem.sliceTo(buffer, 0);
    return content;
}
