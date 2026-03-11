// Native N-API module for usecomputer commands on macOS using Zig.

const std = @import("std");
const builtin = @import("builtin");
const napigen = if (builtin.is_test) undefined else @import("napigen");

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
    _ = payload_json;
    const allocator = std.heap.c_allocator;

    if (std.mem.eql(u8, command, "mouse-position")) {
        return makeOkJson(allocator, "{\"x\":0,\"y\":0}");
    }
    if (std.mem.eql(u8, command, "display-list")) {
        return makeOkJson(allocator, "[]");
    }
    if (std.mem.eql(u8, command, "clipboard-get")) {
        return makeOkJson(allocator, "{\"text\":\"\"}");
    }
    if (std.mem.eql(u8, command, "screenshot")) {
        return makeOkJson(allocator, "{\"path\":\"./screenshot.png\"}");
    }

    if (
        std.mem.eql(u8, command, "click") or
        std.mem.eql(u8, command, "type-text") or
        std.mem.eql(u8, command, "press") or
        std.mem.eql(u8, command, "scroll") or
        std.mem.eql(u8, command, "drag") or
        std.mem.eql(u8, command, "hover") or
        std.mem.eql(u8, command, "mouse-move") or
        std.mem.eql(u8, command, "mouse-down") or
        std.mem.eql(u8, command, "mouse-up") or
        std.mem.eql(u8, command, "clipboard-set")
    ) {
        return makeOkJson(allocator, "null");
    }

    return makeErrorJson(allocator, "unknown command");
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
