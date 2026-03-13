// Native N-API module for usecomputer desktop automation commands.
// Exports direct typed methods (no string command dispatcher) so TS can call
// high-level native functions and receive structured error objects.

const std = @import("std");
const builtin = @import("builtin");
const scroll_impl = @import("scroll.zig");
const window = @import("window.zig");
const napigen = if (builtin.is_test) undefined else @import("napigen");
const c_macos = if (builtin.target.os.tag == .macos) @cImport({
    @cInclude("CoreGraphics/CoreGraphics.h");
    @cInclude("CoreFoundation/CoreFoundation.h");
    @cInclude("ImageIO/ImageIO.h");
}) else struct {};

const c_windows = if (builtin.target.os.tag == .windows) @cImport({
    @cInclude("windows.h");
}) else struct {};

const c_x11 = if (builtin.target.os.tag == .linux) @cImport({
    @cInclude("X11/Xlib.h");
    @cInclude("X11/Xutil.h");
    @cInclude("X11/keysym.h");
    @cInclude("X11/extensions/XShm.h");
    @cInclude("X11/extensions/XTest.h");
    @cInclude("sys/ipc.h");
    @cInclude("sys/shm.h");
    @cInclude("png.h");
}) else struct {};

const c = c_macos;
const screenshot_max_long_edge_px: f64 = 1568;

const mac_keycode = struct {
    const a = 0x00;
    const s = 0x01;
    const d = 0x02;
    const f = 0x03;
    const h = 0x04;
    const g = 0x05;
    const z = 0x06;
    const x = 0x07;
    const c = 0x08;
    const v = 0x09;
    const b = 0x0B;
    const q = 0x0C;
    const w = 0x0D;
    const e = 0x0E;
    const r = 0x0F;
    const y = 0x10;
    const t = 0x11;
    const one = 0x12;
    const two = 0x13;
    const three = 0x14;
    const four = 0x15;
    const six = 0x16;
    const five = 0x17;
    const equal = 0x18;
    const nine = 0x19;
    const seven = 0x1A;
    const minus = 0x1B;
    const eight = 0x1C;
    const zero = 0x1D;
    const right_bracket = 0x1E;
    const o = 0x1F;
    const u = 0x20;
    const left_bracket = 0x21;
    const i = 0x22;
    const p = 0x23;
    const l = 0x25;
    const j = 0x26;
    const quote = 0x27;
    const k = 0x28;
    const semicolon = 0x29;
    const backslash = 0x2A;
    const comma = 0x2B;
    const slash = 0x2C;
    const n = 0x2D;
    const m = 0x2E;
    const period = 0x2F;
    const tab = 0x30;
    const space = 0x31;
    const grave = 0x32;
    const delete = 0x33;
    const enter = 0x24;
    const escape = 0x35;
    const command = 0x37;
    const shift = 0x38;
    const option = 0x3A;
    const control = 0x3B;
    const fn_key = 0x3F;
    const f1 = 0x7A;
    const f2 = 0x78;
    const f3 = 0x63;
    const f4 = 0x76;
    const f5 = 0x60;
    const f6 = 0x61;
    const f7 = 0x62;
    const f8 = 0x64;
    const f9 = 0x65;
    const f10 = 0x6D;
    const f11 = 0x67;
    const f12 = 0x6F;
    const home = 0x73;
    const page_up = 0x74;
    const forward_delete = 0x75;
    const end = 0x77;
    const page_down = 0x79;
    const left_arrow = 0x7B;
    const right_arrow = 0x7C;
    const down_arrow = 0x7D;
    const up_arrow = 0x7E;
};

pub const std_options: std.Options = .{
    .log_level = .err,
};

const DisplayInfoOutput = struct {
    id: u32,
    index: u32,
    name: []const u8,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    scale: f64,
    isPrimary: bool,
};

const WindowInfoOutput = struct {
    id: u32,
    ownerPid: i32,
    ownerName: []const u8,
    title: []const u8,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    desktopIndex: u32,
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
    window: ?f64 = null,
    region: ?ScreenshotRegion = null,
    annotate: ?bool = null,
};

const ScreenshotOutput = struct {
    path: []const u8,
    desktopIndex: f64,
    captureX: f64,
    captureY: f64,
    captureWidth: f64,
    captureHeight: f64,
    imageWidth: f64,
    imageHeight: f64,
};

const SelectedDisplay = if (builtin.target.os.tag == .macos) struct {
    id: c.CGDirectDisplayID,
    index: usize,
    bounds: c.CGRect,
} else struct {
    id: u32,
    index: usize,
    bounds: struct {
        x: f64,
        y: f64,
        width: f64,
        height: f64,
    },
};

const ScreenshotCapture = if (builtin.target.os.tag == .macos) struct {
    image: c.CGImageRef,
    capture_x: f64,
    capture_y: f64,
    capture_width: f64,
    capture_height: f64,
    desktop_index: usize,
} else struct {
    image: RawRgbaImage,
    capture_x: f64,
    capture_y: f64,
    capture_width: f64,
    capture_height: f64,
    desktop_index: usize,
};

const ScaledScreenshotImage = if (builtin.target.os.tag == .macos) struct {
    image: c.CGImageRef,
    width: f64,
    height: f64,
} else struct {
    image: RawRgbaImage,
    width: f64,
    height: f64,
};

const RawRgbaImage = struct {
    pixels: []u8,
    width: usize,
    height: usize,
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
    _ = input.annotate;
    const output_path = input.path orelse "./screenshot.png";

    if (builtin.target.os.tag == .linux) {
        if (input.window != null) {
            return failData(ScreenshotOutput, "screenshot", "UNSUPPORTED_INPUT", "window screenshots are not supported on Linux yet");
        }

        const capture = createLinuxScreenshotImage(.{
            .display_index = input.display,
            .region = input.region,
        }) catch |err| {
            return failData(ScreenshotOutput, "screenshot", linuxScreenshotErrorCode(err), linuxScreenshotErrorMessage(err));
        };
        defer std.heap.c_allocator.free(capture.image.pixels);

        const scaled_image = scaleLinuxScreenshotImageIfNeeded(capture.image) catch {
            return failData(ScreenshotOutput, "screenshot", "SCALE_FAILED", "failed to scale screenshot image");
        };
        defer std.heap.c_allocator.free(scaled_image.image.pixels);

        writeLinuxScreenshotPng(.{
            .image = scaled_image.image,
            .output_path = output_path,
        }) catch {
            return failData(ScreenshotOutput, "screenshot", "WRITE_FAILED", "failed to write screenshot file");
        };

        return okData(ScreenshotOutput, .{
            .path = output_path,
            .desktopIndex = @as(f64, @floatFromInt(capture.desktop_index)),
            .captureX = capture.capture_x,
            .captureY = capture.capture_y,
            .captureWidth = capture.capture_width,
            .captureHeight = capture.capture_height,
            .imageWidth = scaled_image.width,
            .imageHeight = scaled_image.height,
        });
    }

    if (builtin.target.os.tag != .macos) {
        return failData(ScreenshotOutput, "screenshot", "UNSUPPORTED_PLATFORM", "screenshot is only supported on macOS and Linux X11");
    }

    const capture = createScreenshotImage(.{
        .display_index = input.display,
        .window_id = input.window,
        .region = input.region,
    }) catch {
        return failData(ScreenshotOutput, "screenshot", "CAPTURE_FAILED", "failed to capture screenshot image");
    };
    defer c.CFRelease(capture.image);

    const scaled_image = scaleScreenshotImageIfNeeded(capture.image) catch {
        return failData(ScreenshotOutput, "screenshot", "SCALE_FAILED", "failed to scale screenshot image");
    };
    defer c.CFRelease(scaled_image.image);

    writeScreenshotPng(.{
        .image = scaled_image.image,
        .output_path = output_path,
    }) catch {
        return failData(ScreenshotOutput, "screenshot", "WRITE_FAILED", "failed to write screenshot file");
    };

    return okData(ScreenshotOutput, .{
        .path = output_path,
        .desktopIndex = @as(f64, @floatFromInt(capture.desktop_index)),
        .captureX = capture.capture_x,
        .captureY = capture.capture_y,
        .captureWidth = capture.capture_width,
        .captureHeight = capture.capture_height,
        .imageWidth = scaled_image.width,
        .imageHeight = scaled_image.height,
    });
}

fn linuxScreenshotErrorCode(err: anyerror) []const u8 {
    return switch (err) {
        error.InvalidDisplayIndex, error.InvalidRegion, error.RegionOutOfBounds => "INVALID_INPUT",
        error.DisplayOpenFailed, error.MissingDisplayEnv, error.NoScreens, error.XShmUnavailable => "X11_UNAVAILABLE",
        error.CaptureFailed, error.ImageCreateFailed, error.ShmGetFailed, error.ShmAttachFailed, error.ShmAllocFailed => "CAPTURE_FAILED",
        else => "CAPTURE_FAILED",
    };
}

fn linuxScreenshotErrorMessage(err: anyerror) []const u8 {
    return switch (err) {
        error.InvalidDisplayIndex => "Linux screenshots currently support only display 0",
        error.InvalidRegion => "invalid screenshot region",
        error.RegionOutOfBounds => "screenshot region is outside the X11 root window bounds",
        error.MissingDisplayEnv => "DISPLAY is not set; Linux screenshots require an X11 session",
        error.DisplayOpenFailed => "failed to open X11 display",
        error.NoScreens => "X11 display has no screens",
        error.XShmUnavailable => "X11 shared memory extension is unavailable",
        error.ImageCreateFailed, error.ShmAllocFailed, error.ShmAttachFailed, error.ShmGetFailed, error.CaptureFailed => "failed to capture screenshot image",
        else => "failed to capture screenshot image",
    };
}

fn createLinuxScreenshotImage(input: struct {
    display_index: ?f64,
    region: ?ScreenshotRegion,
}) !ScreenshotCapture {
    if (builtin.target.os.tag != .linux) {
        return error.UnsupportedPlatform;
    }
    if (input.display_index) |value| {
        const normalized = @as(i64, @intFromFloat(std.math.round(value)));
        if (normalized != 0) {
            return error.InvalidDisplayIndex;
        }
    }
    if (std.posix.getenv("DISPLAY") == null) {
        return error.MissingDisplayEnv;
    }

    const display = c_x11.XOpenDisplay(null) orelse return error.DisplayOpenFailed;
    defer _ = c_x11.XCloseDisplay(display);

    const screen_index = c_x11.XDefaultScreen(display);
    if (screen_index < 0) {
        return error.NoScreens;
    }
    const root = c_x11.XRootWindow(display, screen_index);
    const screen_width_i = c_x11.XDisplayWidth(display, screen_index);
    const screen_height_i = c_x11.XDisplayHeight(display, screen_index);
    if (screen_width_i <= 0 or screen_height_i <= 0) {
        return error.CaptureFailed;
    }

    const screen_width = @as(usize, @intCast(screen_width_i));
    const screen_height = @as(usize, @intCast(screen_height_i));
    const capture_rect = try resolveLinuxCaptureRect(.{
        .screen_width = screen_width,
        .screen_height = screen_height,
        .region = input.region,
    });

    // Try XShm first (fast), fall back to XGetImage (slow but always works).
    // XShm fails on XWayland when processes don't share SHM namespaces.
    const image = captureWithXShm(display, screen_index, root, capture_rect) orelse
        captureWithXGetImage(display, root, capture_rect) orelse
        return error.CaptureFailed;
    // XDestroyImage is a C macro: ((*((ximage)->f.destroy_image))((ximage)))
    // Zig's @cImport can't translate it, so call the function pointer directly.
    defer _ = image.*.f.destroy_image.?(image);

    const rgba = try convertX11ImageToRgba(image, capture_rect.width, capture_rect.height);
    return .{
        .image = rgba,
        .capture_x = @floatFromInt(capture_rect.x),
        .capture_y = @floatFromInt(capture_rect.y),
        .capture_width = @floatFromInt(capture_rect.width),
        .capture_height = @floatFromInt(capture_rect.height),
        .desktop_index = 0,
    };
}

const LinuxCaptureRect = struct {
    x: usize,
    y: usize,
    width: usize,
    height: usize,
};

// X error handler state for detecting X errors during screenshot capture.
// XSetErrorHandler is process-global, so this is necessarily a global.
var x_capture_error_occurred: bool = false;

fn captureErrorHandler(_: ?*c_x11.Display, _: ?*c_x11.XErrorEvent) callconv(.c) c_int {
    x_capture_error_occurred = true;
    return 0;
}

/// Fast screenshot path using XShm (shared memory). Returns null if XShm is
/// unavailable or fails (common on XWayland with different SHM namespaces).
fn captureWithXShm(
    display: *c_x11.Display,
    screen_index: c_int,
    root: c_x11.Window,
    capture_rect: LinuxCaptureRect,
) ?*c_x11.XImage {
    if (c_x11.XShmQueryExtension(display) == 0) {
        return null;
    }

    const visual = c_x11.XDefaultVisual(display, screen_index);
    const depth = @as(c_uint, @intCast(c_x11.XDefaultDepth(display, screen_index)));
    var shm_info: c_x11.XShmSegmentInfo = undefined;
    shm_info.shmid = -1;
    shm_info.shmaddr = null;
    shm_info.readOnly = 0;

    const image = c_x11.XShmCreateImage(
        display,
        visual,
        depth,
        c_x11.ZPixmap,
        null,
        &shm_info,
        @as(c_uint, @intCast(capture_rect.width)),
        @as(c_uint, @intCast(capture_rect.height)),
    ) orelse return null;

    const bytes_per_image = @as(usize, @intCast(image.*.bytes_per_line)) * capture_rect.height;
    const shmget_result = c_x11.shmget(c_x11.IPC_PRIVATE, bytes_per_image, c_x11.IPC_CREAT | 0o600);
    if (shmget_result < 0) {
        image.*.data = null;
        _ = image.*.f.destroy_image.?(image);
        return null;
    }
    shm_info.shmid = shmget_result;

    const shmaddr = c_x11.shmat(shm_info.shmid, null, 0);
    if (@intFromPtr(shmaddr) == std.math.maxInt(usize)) {
        _ = c_x11.shmctl(shm_info.shmid, c_x11.IPC_RMID, null);
        image.*.data = null;
        _ = image.*.f.destroy_image.?(image);
        return null;
    }
    shm_info.shmaddr = @ptrCast(shmaddr);
    image.*.data = shm_info.shmaddr;

    // Install custom error handler to catch BadAccess from XShmAttach
    // (happens on XWayland when SHM namespaces don't match).
    x_capture_error_occurred = false;
    const old_handler = c_x11.XSetErrorHandler(captureErrorHandler);

    _ = c_x11.XShmAttach(display, &shm_info);
    _ = c_x11.XSync(display, 0);

    if (x_capture_error_occurred) {
        // Restore original handler and clean up
        _ = c_x11.XSetErrorHandler(old_handler);
        _ = c_x11.shmdt(shmaddr);
        _ = c_x11.shmctl(shm_info.shmid, c_x11.IPC_RMID, null);
        image.*.data = null;
        _ = image.*.f.destroy_image.?(image);
        return null;
    }

    if (c_x11.XShmGetImage(
        display,
        root,
        image,
        @as(c_int, @intCast(capture_rect.x)),
        @as(c_int, @intCast(capture_rect.y)),
        c_x11.AllPlanes,
    ) == 0) {
        _ = c_x11.XSetErrorHandler(old_handler);
        _ = c_x11.XShmDetach(display, &shm_info);
        _ = c_x11.shmdt(shmaddr);
        _ = c_x11.shmctl(shm_info.shmid, c_x11.IPC_RMID, null);
        image.*.data = null;
        _ = image.*.f.destroy_image.?(image);
        return null;
    }

    // Copy image data to a separate allocation so we can detach SHM.
    // The caller owns the XImage and will free it via destroy_image.
    const data_copy = std.heap.c_allocator.alloc(u8, bytes_per_image) catch {
        _ = c_x11.XSetErrorHandler(old_handler);
        _ = c_x11.XShmDetach(display, &shm_info);
        _ = c_x11.shmdt(shmaddr);
        _ = c_x11.shmctl(shm_info.shmid, c_x11.IPC_RMID, null);
        image.*.data = null;
        _ = image.*.f.destroy_image.?(image);
        return null;
    };
    @memcpy(data_copy, @as([*]const u8, @ptrCast(shmaddr))[0..bytes_per_image]);
    image.*.data = @ptrCast(data_copy.ptr);

    _ = c_x11.XSetErrorHandler(old_handler);
    _ = c_x11.XShmDetach(display, &shm_info);
    _ = c_x11.shmdt(shmaddr);
    _ = c_x11.shmctl(shm_info.shmid, c_x11.IPC_RMID, null);

    return image;
}

/// Slow but reliable fallback: XGetImage copies pixels over the X connection.
/// Works everywhere including XWayland regardless of SHM namespace.
/// Installs a temporary X error handler to catch BadMatch errors (common
/// on XWayland when the capture region doesn't match the root drawable).
fn captureWithXGetImage(
    display: *c_x11.Display,
    root: c_x11.Window,
    capture_rect: LinuxCaptureRect,
) ?*c_x11.XImage {
    x_capture_error_occurred = false;
    const old_handler = c_x11.XSetErrorHandler(captureErrorHandler);
    defer _ = c_x11.XSetErrorHandler(old_handler);

    const image = c_x11.XGetImage(
        display,
        root,
        @as(c_int, @intCast(capture_rect.x)),
        @as(c_int, @intCast(capture_rect.y)),
        @as(c_uint, @intCast(capture_rect.width)),
        @as(c_uint, @intCast(capture_rect.height)),
        c_x11.AllPlanes,
        c_x11.ZPixmap,
    );
    _ = c_x11.XSync(display, 0);

    if (x_capture_error_occurred) {
        if (image) |img| {
            _ = img.*.f.destroy_image.?(img);
        }
        return null;
    }
    return image;
}

fn resolveLinuxCaptureRect(input: struct {
    screen_width: usize,
    screen_height: usize,
    region: ?ScreenshotRegion,
}) !LinuxCaptureRect {
    if (input.region) |region| {
        const x = @as(i64, @intFromFloat(std.math.round(region.x)));
        const y = @as(i64, @intFromFloat(std.math.round(region.y)));
        const width = @as(i64, @intFromFloat(std.math.round(region.width)));
        const height = @as(i64, @intFromFloat(std.math.round(region.height)));
        if (x < 0 or y < 0 or width <= 0 or height <= 0) {
            return error.InvalidRegion;
        }
        const max_x = x + width;
        const max_y = y + height;
        if (max_x > input.screen_width or max_y > input.screen_height) {
            return error.RegionOutOfBounds;
        }
        return .{
            .x = @as(usize, @intCast(x)),
            .y = @as(usize, @intCast(y)),
            .width = @as(usize, @intCast(width)),
            .height = @as(usize, @intCast(height)),
        };
    }

    return .{
        .x = 0,
        .y = 0,
        .width = input.screen_width,
        .height = input.screen_height,
    };
}

fn convertX11ImageToRgba(image: *c_x11.XImage, width: usize, height: usize) !RawRgbaImage {
    const pixels = try std.heap.c_allocator.alloc(u8, width * height * 4);
    errdefer std.heap.c_allocator.free(pixels);

    var y: usize = 0;
    while (y < height) : (y += 1) {
        var x: usize = 0;
        while (x < width) : (x += 1) {
            // XGetPixel is a C macro: ((*((ximage)->f.get_pixel))((ximage), (x), (y)))
            const pixel = image.*.f.get_pixel.?(image, @as(c_int, @intCast(x)), @as(c_int, @intCast(y)));
            const red = normalizeX11Channel(.{ .pixel = pixel, .mask = image.*.red_mask });
            const green = normalizeX11Channel(.{ .pixel = pixel, .mask = image.*.green_mask });
            const blue = normalizeX11Channel(.{ .pixel = pixel, .mask = image.*.blue_mask });
            const offset = (y * width + x) * 4;
            pixels[offset] = red;
            pixels[offset + 1] = green;
            pixels[offset + 2] = blue;
            pixels[offset + 3] = 255;
        }
    }

    return .{ .pixels = pixels, .width = width, .height = height };
}

fn normalizeX11Channel(input: struct {
    pixel: c_ulong,
    mask: c_ulong,
}) u8 {
    if (input.mask == 0) {
        return 0;
    }
    // @ctz returns u7 on 64-bit c_ulong (aarch64-linux), but >> needs u6.
    // The shift can't exceed 63 since mask != 0 and is at most 64 bits.
    const shift: std.math.Log2Int(c_ulong) = @intCast(@ctz(input.mask));
    const bits: std.math.Log2Int(c_ulong) = @intCast(@min(@popCount(input.mask), @bitSizeOf(c_ulong) - 1));
    const raw = (input.pixel & input.mask) >> shift;
    const max_value = (@as(u64, 1) << @intCast(bits)) - 1;
    if (max_value == 0) {
        return 0;
    }
    return @as(u8, @intCast((raw * 255) / max_value));
}

fn scaleLinuxScreenshotImageIfNeeded(image: RawRgbaImage) !ScaledScreenshotImage {
    const image_width = @as(f64, @floatFromInt(image.width));
    const image_height = @as(f64, @floatFromInt(image.height));
    const long_edge = @max(image_width, image_height);
    if (long_edge <= screenshot_max_long_edge_px) {
        const copy = try std.heap.c_allocator.dupe(u8, image.pixels);
        return .{
            .image = .{ .pixels = copy, .width = image.width, .height = image.height },
            .width = image_width,
            .height = image_height,
        };
    }

    const scale = screenshot_max_long_edge_px / long_edge;
    const target_width = @max(1, @as(usize, @intFromFloat(std.math.round(image_width * scale))));
    const target_height = @max(1, @as(usize, @intFromFloat(std.math.round(image_height * scale))));
    const scaled_pixels = try std.heap.c_allocator.alloc(u8, target_width * target_height * 4);
    errdefer std.heap.c_allocator.free(scaled_pixels);

    var y: usize = 0;
    while (y < target_height) : (y += 1) {
        const source_y = @min(image.height - 1, @as(usize, @intFromFloat((@as(f64, @floatFromInt(y)) * image_height) / @as(f64, @floatFromInt(target_height)))));
        var x: usize = 0;
        while (x < target_width) : (x += 1) {
            const source_x = @min(image.width - 1, @as(usize, @intFromFloat((@as(f64, @floatFromInt(x)) * image_width) / @as(f64, @floatFromInt(target_width)))));
            const source_offset = (source_y * image.width + source_x) * 4;
            const target_offset = (y * target_width + x) * 4;
            @memcpy(scaled_pixels[target_offset .. target_offset + 4], image.pixels[source_offset .. source_offset + 4]);
        }
    }

    return .{
        .image = .{ .pixels = scaled_pixels, .width = target_width, .height = target_height },
        .width = @floatFromInt(target_width),
        .height = @floatFromInt(target_height),
    };
}

fn writeLinuxScreenshotPng(input: struct {
    image: RawRgbaImage,
    output_path: []const u8,
}) !void {
    var png: c_x11.png_image = std.mem.zeroes(c_x11.png_image);
    png.version = c_x11.PNG_IMAGE_VERSION;
    png.width = @as(c_x11.png_uint_32, @intCast(input.image.width));
    png.height = @as(c_x11.png_uint_32, @intCast(input.image.height));
    png.format = c_x11.PNG_FORMAT_RGBA;

    const output_path_z = try std.heap.c_allocator.dupeZ(u8, input.output_path);
    defer std.heap.c_allocator.free(output_path_z);

    const write_result = c_x11.png_image_write_to_file(
        &png,
        output_path_z.ptr,
        0,
        input.image.pixels.ptr,
        @as(c_int, @intCast(input.image.width * 4)),
        null,
    );
    if (write_result == 0) {
        c_x11.png_image_free(&png);
        return error.PngWriteFailed;
    }
    c_x11.png_image_free(&png);
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

pub fn displayList() DataResult([]const u8) {
    if (builtin.target.os.tag != .macos) {
        return failData([]const u8, "display-list", "UNSUPPORTED_PLATFORM", "display-list is only supported on macOS");
    }

    var display_ids: [16]c.CGDirectDisplayID = undefined;
    var display_count: u32 = 0;
    const list_result = c.CGGetActiveDisplayList(display_ids.len, &display_ids, &display_count);
    if (list_result != c.kCGErrorSuccess) {
        return failData([]const u8, "display-list", "DISPLAY_QUERY_FAILED", "failed to query active displays");
    }

    var write_buffer: [32 * 1024]u8 = undefined;
    var stream = std.io.fixedBufferStream(&write_buffer);
    const writer = stream.writer();

    writer.writeByte('[') catch {
        return failData([]const u8, "display-list", "SERIALIZE_FAILED", "failed to serialize display list");
    };

    var i: usize = 0;
    while (i < display_count) : (i += 1) {
        if (i > 0) {
            writer.writeByte(',') catch {
                return failData([]const u8, "display-list", "SERIALIZE_FAILED", "failed to serialize display list");
            };
        }

        const display_id = display_ids[i];
        const bounds = c.CGDisplayBounds(display_id);
        var name_buffer: [64]u8 = undefined;
        const fallback_name = std.fmt.bufPrint(&name_buffer, "Display {d}", .{display_id}) catch "Display";
        const item = DisplayInfoOutput{
            .id = display_id,
            .index = @intCast(i),
            .name = fallback_name,
            .x = std.math.round(bounds.origin.x),
            .y = std.math.round(bounds.origin.y),
            .width = std.math.round(bounds.size.width),
            .height = std.math.round(bounds.size.height),
            .scale = 1,
            .isPrimary = c.CGDisplayIsMain(display_id) != 0,
        };

        writer.print("{f}", .{std.json.fmt(item, .{})}) catch {
            return failData([]const u8, "display-list", "SERIALIZE_FAILED", "failed to serialize display list");
        };
    }

    writer.writeByte(']') catch {
        return failData([]const u8, "display-list", "SERIALIZE_FAILED", "failed to serialize display list");
    };

    // TODO: Add Mission Control desktop/space enumeration via private SkyLight APIs.
    const payload = std.heap.c_allocator.dupe(u8, stream.getWritten()) catch {
        return failData([]const u8, "display-list", "ALLOC_FAILED", "failed to allocate display list response");
    };
    return okData([]const u8, payload);
}

pub fn windowList() DataResult([]const u8) {
    if (builtin.target.os.tag != .macos) {
        return failData([]const u8, "window-list", "UNSUPPORTED_PLATFORM", "window-list is only supported on macOS");
    }

    const payload = serializeWindowListJson() catch {
        return failData([]const u8, "window-list", "WINDOW_QUERY_FAILED", "failed to query visible windows");
    };
    return okData([]const u8, payload);
}

pub fn clipboardGet() DataResult([]const u8) {
    return failData([]const u8, "clipboard-get", "TODO_NOT_IMPLEMENTED", "TODO not implemented: clipboard-get");
}

pub fn clipboardSet(input: ClipboardSetInput) CommandResult {
    _ = input;
    return todoNotImplemented("clipboard-set");
}

pub fn typeText(input: TypeTextInput) CommandResult {
    switch (builtin.target.os.tag) {
        .macos => {
            typeTextMacos(input) catch |err| {
                return failCommand("type-text", "EVENT_POST_FAILED", @errorName(err));
            };
            return okCommand();
        },
        .windows => {
            typeTextWindows(input) catch |err| {
                return failCommand("type-text", "EVENT_POST_FAILED", @errorName(err));
            };
            return okCommand();
        },
        .linux => {
            typeTextX11(input) catch |err| {
                return failCommand("type-text", "EVENT_POST_FAILED", @errorName(err));
            };
            return okCommand();
        },
        else => {
            return failCommand("type-text", "UNSUPPORTED_PLATFORM", "type-text is unsupported on this platform");
        },
    }
}

pub fn press(input: PressInput) CommandResult {
    switch (builtin.target.os.tag) {
        .macos => {
            pressMacos(input) catch |err| {
                return failCommand("press", "EVENT_POST_FAILED", @errorName(err));
            };
            return okCommand();
        },
        .windows => {
            pressWindows(input) catch |err| {
                return failCommand("press", "EVENT_POST_FAILED", @errorName(err));
            };
            return okCommand();
        },
        .linux => {
            pressX11(input) catch |err| {
                return failCommand("press", "EVENT_POST_FAILED", @errorName(err));
            };
            return okCommand();
        },
        else => {
            return failCommand("press", "UNSUPPORTED_PLATFORM", "press is unsupported on this platform");
        },
    }
}

pub fn scroll(input: ScrollInput) CommandResult {
    scroll_impl.scroll(.{
        .direction = input.direction,
        .amount = input.amount,
        .at_x = if (input.at) |point| point.x else null,
        .at_y = if (input.at) |point| point.y else null,
    }) catch |err| {
        const error_name = @errorName(err);
        if (std.mem.eql(u8, error_name, "InvalidDirection") or
            std.mem.eql(u8, error_name, "InvalidAmount") or
            std.mem.eql(u8, error_name, "AmountTooLarge") or
            std.mem.eql(u8, error_name, "InvalidPoint"))
        {
            return failCommand("scroll", "INVALID_INPUT", error_name);
        }
        return failCommand("scroll", "EVENT_POST_FAILED", error_name);
    };
    return okCommand();
}

const ParsedPress = struct {
    key: []const u8,
    cmd: bool = false,
    alt: bool = false,
    ctrl: bool = false,
    shift: bool = false,
    fn_key: bool = false,
};

fn parsePressKey(key_input: []const u8) !ParsedPress {
    var parsed: ParsedPress = .{ .key = "" };
    var saw_key = false;
    var parts = std.mem.splitScalar(u8, key_input, '+');
    while (parts.next()) |part| {
        const trimmed = std.mem.trim(u8, part, " \t\r\n");
        if (trimmed.len == 0) {
            continue;
        }

        if (std.ascii.eqlIgnoreCase(trimmed, "cmd") or std.ascii.eqlIgnoreCase(trimmed, "command") or std.ascii.eqlIgnoreCase(trimmed, "meta")) {
            parsed.cmd = true;
            continue;
        }
        if (std.ascii.eqlIgnoreCase(trimmed, "alt") or std.ascii.eqlIgnoreCase(trimmed, "option")) {
            parsed.alt = true;
            continue;
        }
        if (std.ascii.eqlIgnoreCase(trimmed, "ctrl") or std.ascii.eqlIgnoreCase(trimmed, "control")) {
            parsed.ctrl = true;
            continue;
        }
        if (std.ascii.eqlIgnoreCase(trimmed, "shift")) {
            parsed.shift = true;
            continue;
        }
        if (std.ascii.eqlIgnoreCase(trimmed, "fn")) {
            parsed.fn_key = true;
            continue;
        }

        if (saw_key) {
            return error.MultipleMainKeys;
        }
        parsed.key = trimmed;
        saw_key = true;
    }

    if (!saw_key) {
        return error.MissingMainKey;
    }
    return parsed;
}

fn normalizedCount(value: ?f64) u32 {
    if (value) |count| {
        const rounded = @as(i64, @intFromFloat(std.math.round(count)));
        if (rounded > 0) {
            return @as(u32, @intCast(rounded));
        }
    }
    return 1;
}

fn normalizedDelayNs(value: ?f64) u64 {
    if (value) |delay_ms| {
        const rounded = @as(i64, @intFromFloat(std.math.round(delay_ms)));
        if (rounded > 0) {
            return @as(u64, @intCast(rounded)) * std.time.ns_per_ms;
        }
    }
    return 0;
}

fn codepointToUtf16(codepoint: u21) !struct { units: [2]u16, len: usize } {
    if (codepoint <= 0xD7FF or (codepoint >= 0xE000 and codepoint <= 0xFFFF)) {
        return .{ .units = .{ @as(u16, @intCast(codepoint)), 0 }, .len = 1 };
    }
    if (codepoint >= 0x10000 and codepoint <= 0x10FFFF) {
        const value = codepoint - 0x10000;
        const high = @as(u16, @intCast(0xD800 + (value >> 10)));
        const low = @as(u16, @intCast(0xDC00 + (value & 0x3FF)));
        return .{ .units = .{ high, low }, .len = 2 };
    }
    return error.InvalidCodepoint;
}

fn typeTextMacos(input: TypeTextInput) !void {
    const delay_ns = normalizedDelayNs(input.delayMs);
    var view = try std.unicode.Utf8View.init(input.text);
    var iterator = view.iterator();
    while (iterator.nextCodepoint()) |codepoint| {
        const utf16 = try codepointToUtf16(codepoint);
        const down = c_macos.CGEventCreateKeyboardEvent(null, 0, true) orelse return error.CGEventCreateFailed;
        defer c_macos.CFRelease(down);
        c_macos.CGEventSetFlags(down, 0);
        c_macos.CGEventKeyboardSetUnicodeString(down, @as(c_macos.UniCharCount, @intCast(utf16.len)), @ptrCast(&utf16.units[0]));
        c_macos.CGEventPost(c_macos.kCGHIDEventTap, down);

        const up = c_macos.CGEventCreateKeyboardEvent(null, 0, false) orelse return error.CGEventCreateFailed;
        defer c_macos.CFRelease(up);
        c_macos.CGEventSetFlags(up, 0);
        c_macos.CGEventKeyboardSetUnicodeString(up, @as(c_macos.UniCharCount, @intCast(utf16.len)), @ptrCast(&utf16.units[0]));
        c_macos.CGEventPost(c_macos.kCGHIDEventTap, up);

        if (delay_ns > 0) {
            std.Thread.sleep(delay_ns);
        }
    }
}

fn keyCodeForMacosKey(key_name: []const u8) !c_macos.CGKeyCode {
    if (key_name.len == 1) {
        const ch = std.ascii.toLower(key_name[0]);
        return switch (ch) {
            'a' => mac_keycode.a,
            'b' => mac_keycode.b,
            'c' => mac_keycode.c,
            'd' => mac_keycode.d,
            'e' => mac_keycode.e,
            'f' => mac_keycode.f,
            'g' => mac_keycode.g,
            'h' => mac_keycode.h,
            'i' => mac_keycode.i,
            'j' => mac_keycode.j,
            'k' => mac_keycode.k,
            'l' => mac_keycode.l,
            'm' => mac_keycode.m,
            'n' => mac_keycode.n,
            'o' => mac_keycode.o,
            'p' => mac_keycode.p,
            'q' => mac_keycode.q,
            'r' => mac_keycode.r,
            's' => mac_keycode.s,
            't' => mac_keycode.t,
            'u' => mac_keycode.u,
            'v' => mac_keycode.v,
            'w' => mac_keycode.w,
            'x' => mac_keycode.x,
            'y' => mac_keycode.y,
            'z' => mac_keycode.z,
            '0' => mac_keycode.zero,
            '1' => mac_keycode.one,
            '2' => mac_keycode.two,
            '3' => mac_keycode.three,
            '4' => mac_keycode.four,
            '5' => mac_keycode.five,
            '6' => mac_keycode.six,
            '7' => mac_keycode.seven,
            '8' => mac_keycode.eight,
            '9' => mac_keycode.nine,
            '=' => mac_keycode.equal,
            '-' => mac_keycode.minus,
            '[' => mac_keycode.left_bracket,
            ']' => mac_keycode.right_bracket,
            ';' => mac_keycode.semicolon,
            '\'' => mac_keycode.quote,
            '\\' => mac_keycode.backslash,
            ',' => mac_keycode.comma,
            '.' => mac_keycode.period,
            '/' => mac_keycode.slash,
            '`' => mac_keycode.grave,
            else => error.UnknownKey,
        };
    }

    if (std.ascii.eqlIgnoreCase(key_name, "enter") or std.ascii.eqlIgnoreCase(key_name, "return")) return mac_keycode.enter;
    if (std.ascii.eqlIgnoreCase(key_name, "tab")) return mac_keycode.tab;
    if (std.ascii.eqlIgnoreCase(key_name, "space")) return mac_keycode.space;
    if (std.ascii.eqlIgnoreCase(key_name, "escape") or std.ascii.eqlIgnoreCase(key_name, "esc")) return mac_keycode.escape;
    if (std.ascii.eqlIgnoreCase(key_name, "backspace")) return mac_keycode.delete;
    if (std.ascii.eqlIgnoreCase(key_name, "delete")) return mac_keycode.forward_delete;
    if (std.ascii.eqlIgnoreCase(key_name, "left")) return mac_keycode.left_arrow;
    if (std.ascii.eqlIgnoreCase(key_name, "right")) return mac_keycode.right_arrow;
    if (std.ascii.eqlIgnoreCase(key_name, "up")) return mac_keycode.up_arrow;
    if (std.ascii.eqlIgnoreCase(key_name, "down")) return mac_keycode.down_arrow;
    if (std.ascii.eqlIgnoreCase(key_name, "home")) return mac_keycode.home;
    if (std.ascii.eqlIgnoreCase(key_name, "end")) return mac_keycode.end;
    if (std.ascii.eqlIgnoreCase(key_name, "pageup")) return mac_keycode.page_up;
    if (std.ascii.eqlIgnoreCase(key_name, "pagedown")) return mac_keycode.page_down;
    if (std.ascii.eqlIgnoreCase(key_name, "f1")) return mac_keycode.f1;
    if (std.ascii.eqlIgnoreCase(key_name, "f2")) return mac_keycode.f2;
    if (std.ascii.eqlIgnoreCase(key_name, "f3")) return mac_keycode.f3;
    if (std.ascii.eqlIgnoreCase(key_name, "f4")) return mac_keycode.f4;
    if (std.ascii.eqlIgnoreCase(key_name, "f5")) return mac_keycode.f5;
    if (std.ascii.eqlIgnoreCase(key_name, "f6")) return mac_keycode.f6;
    if (std.ascii.eqlIgnoreCase(key_name, "f7")) return mac_keycode.f7;
    if (std.ascii.eqlIgnoreCase(key_name, "f8")) return mac_keycode.f8;
    if (std.ascii.eqlIgnoreCase(key_name, "f9")) return mac_keycode.f9;
    if (std.ascii.eqlIgnoreCase(key_name, "f10")) return mac_keycode.f10;
    if (std.ascii.eqlIgnoreCase(key_name, "f11")) return mac_keycode.f11;
    if (std.ascii.eqlIgnoreCase(key_name, "f12")) return mac_keycode.f12;

    return error.UnknownKey;
}

fn postMacosKey(key_code: c_macos.CGKeyCode, is_down: bool, flags: c_macos.CGEventFlags) !void {
    const event = c_macos.CGEventCreateKeyboardEvent(null, key_code, is_down) orelse return error.CGEventCreateFailed;
    defer c_macos.CFRelease(event);
    c_macos.CGEventSetFlags(event, flags);
    c_macos.CGEventPost(c_macos.kCGHIDEventTap, event);
}

fn pressMacos(input: PressInput) !void {
    const parsed = try parsePressKey(input.key);
    const key_code = try keyCodeForMacosKey(parsed.key);
    const repeat_count = normalizedCount(input.count);
    const delay_ns = normalizedDelayNs(input.delayMs);

    var flags: c_macos.CGEventFlags = 0;
    if (parsed.cmd) flags |= c_macos.kCGEventFlagMaskCommand;
    if (parsed.alt) flags |= c_macos.kCGEventFlagMaskAlternate;
    if (parsed.ctrl) flags |= c_macos.kCGEventFlagMaskControl;
    if (parsed.shift) flags |= c_macos.kCGEventFlagMaskShift;
    if (parsed.fn_key) flags |= c_macos.kCGEventFlagMaskSecondaryFn;

    var index: u32 = 0;
    while (index < repeat_count) : (index += 1) {
        if (parsed.cmd) try postMacosKey(mac_keycode.command, true, flags);
        if (parsed.alt) try postMacosKey(mac_keycode.option, true, flags);
        if (parsed.ctrl) try postMacosKey(mac_keycode.control, true, flags);
        if (parsed.shift) try postMacosKey(mac_keycode.shift, true, flags);
        if (parsed.fn_key) try postMacosKey(mac_keycode.fn_key, true, flags);

        try postMacosKey(key_code, true, flags);
        try postMacosKey(key_code, false, flags);

        if (parsed.fn_key) try postMacosKey(mac_keycode.fn_key, false, flags);
        if (parsed.shift) try postMacosKey(mac_keycode.shift, false, flags);
        if (parsed.ctrl) try postMacosKey(mac_keycode.control, false, flags);
        if (parsed.alt) try postMacosKey(mac_keycode.option, false, flags);
        if (parsed.cmd) try postMacosKey(mac_keycode.command, false, flags);

        if (delay_ns > 0 and index + 1 < repeat_count) {
            std.Thread.sleep(delay_ns);
        }
    }
}

fn typeTextWindows(input: TypeTextInput) !void {
    const delay_ns = normalizedDelayNs(input.delayMs);
    var view = try std.unicode.Utf8View.init(input.text);
    var iterator = view.iterator();
    while (iterator.nextCodepoint()) |codepoint| {
        const utf16 = try codepointToUtf16(codepoint);
        var unit_index: usize = 0;
        while (unit_index < utf16.len) : (unit_index += 1) {
            const unit = utf16.units[unit_index];
            var down = std.mem.zeroes(c_windows.INPUT);
            down.type = c_windows.INPUT_KEYBOARD;
            down.Anonymous.ki.wVk = 0;
            down.Anonymous.ki.wScan = unit;
            down.Anonymous.ki.dwFlags = c_windows.KEYEVENTF_UNICODE;
            _ = c_windows.SendInput(1, &down, @sizeOf(c_windows.INPUT));

            var up = down;
            up.Anonymous.ki.dwFlags = c_windows.KEYEVENTF_UNICODE | c_windows.KEYEVENTF_KEYUP;
            _ = c_windows.SendInput(1, &up, @sizeOf(c_windows.INPUT));
        }

        if (delay_ns > 0) {
            std.Thread.sleep(delay_ns);
        }
    }
}

fn keyCodeForWindowsKey(key_name: []const u8) !u16 {
    if (key_name.len == 1) {
        const ch = std.ascii.toUpper(key_name[0]);
        if ((ch >= 'A' and ch <= 'Z') or (ch >= '0' and ch <= '9')) {
            return ch;
        }
        return switch (key_name[0]) {
            '=' => c_windows.VK_OEM_PLUS,
            '-' => c_windows.VK_OEM_MINUS,
            '[' => c_windows.VK_OEM_4,
            ']' => c_windows.VK_OEM_6,
            ';' => c_windows.VK_OEM_1,
            '\'' => c_windows.VK_OEM_7,
            '\\' => c_windows.VK_OEM_5,
            ',' => c_windows.VK_OEM_COMMA,
            '.' => c_windows.VK_OEM_PERIOD,
            '/' => c_windows.VK_OEM_2,
            '`' => c_windows.VK_OEM_3,
            else => error.UnknownKey,
        };
    }

    if (std.ascii.eqlIgnoreCase(key_name, "enter") or std.ascii.eqlIgnoreCase(key_name, "return")) return c_windows.VK_RETURN;
    if (std.ascii.eqlIgnoreCase(key_name, "tab")) return c_windows.VK_TAB;
    if (std.ascii.eqlIgnoreCase(key_name, "space")) return c_windows.VK_SPACE;
    if (std.ascii.eqlIgnoreCase(key_name, "escape") or std.ascii.eqlIgnoreCase(key_name, "esc")) return c_windows.VK_ESCAPE;
    if (std.ascii.eqlIgnoreCase(key_name, "backspace")) return c_windows.VK_BACK;
    if (std.ascii.eqlIgnoreCase(key_name, "delete")) return c_windows.VK_DELETE;
    if (std.ascii.eqlIgnoreCase(key_name, "left")) return c_windows.VK_LEFT;
    if (std.ascii.eqlIgnoreCase(key_name, "right")) return c_windows.VK_RIGHT;
    if (std.ascii.eqlIgnoreCase(key_name, "up")) return c_windows.VK_UP;
    if (std.ascii.eqlIgnoreCase(key_name, "down")) return c_windows.VK_DOWN;
    if (std.ascii.eqlIgnoreCase(key_name, "home")) return c_windows.VK_HOME;
    if (std.ascii.eqlIgnoreCase(key_name, "end")) return c_windows.VK_END;
    if (std.ascii.eqlIgnoreCase(key_name, "pageup")) return c_windows.VK_PRIOR;
    if (std.ascii.eqlIgnoreCase(key_name, "pagedown")) return c_windows.VK_NEXT;
    if (std.ascii.eqlIgnoreCase(key_name, "f1")) return c_windows.VK_F1;
    if (std.ascii.eqlIgnoreCase(key_name, "f2")) return c_windows.VK_F2;
    if (std.ascii.eqlIgnoreCase(key_name, "f3")) return c_windows.VK_F3;
    if (std.ascii.eqlIgnoreCase(key_name, "f4")) return c_windows.VK_F4;
    if (std.ascii.eqlIgnoreCase(key_name, "f5")) return c_windows.VK_F5;
    if (std.ascii.eqlIgnoreCase(key_name, "f6")) return c_windows.VK_F6;
    if (std.ascii.eqlIgnoreCase(key_name, "f7")) return c_windows.VK_F7;
    if (std.ascii.eqlIgnoreCase(key_name, "f8")) return c_windows.VK_F8;
    if (std.ascii.eqlIgnoreCase(key_name, "f9")) return c_windows.VK_F9;
    if (std.ascii.eqlIgnoreCase(key_name, "f10")) return c_windows.VK_F10;
    if (std.ascii.eqlIgnoreCase(key_name, "f11")) return c_windows.VK_F11;
    if (std.ascii.eqlIgnoreCase(key_name, "f12")) return c_windows.VK_F12;

    return error.UnknownKey;
}

fn postWindowsVirtualKey(virtual_key: u16, is_down: bool) void {
    var event = std.mem.zeroes(c_windows.INPUT);
    event.type = c_windows.INPUT_KEYBOARD;
    event.Anonymous.ki.wVk = virtual_key;
    event.Anonymous.ki.wScan = 0;
    event.Anonymous.ki.dwFlags = if (is_down) 0 else c_windows.KEYEVENTF_KEYUP;
    _ = c_windows.SendInput(1, &event, @sizeOf(c_windows.INPUT));
}

fn pressWindows(input: PressInput) !void {
    const parsed = try parsePressKey(input.key);
    const key_code = try keyCodeForWindowsKey(parsed.key);
    const repeat_count = normalizedCount(input.count);
    const delay_ns = normalizedDelayNs(input.delayMs);

    var index: u32 = 0;
    while (index < repeat_count) : (index += 1) {
        if (parsed.cmd) postWindowsVirtualKey(c_windows.VK_LWIN, true);
        if (parsed.alt) postWindowsVirtualKey(c_windows.VK_MENU, true);
        if (parsed.ctrl) postWindowsVirtualKey(c_windows.VK_CONTROL, true);
        if (parsed.shift) postWindowsVirtualKey(c_windows.VK_SHIFT, true);

        postWindowsVirtualKey(key_code, true);
        postWindowsVirtualKey(key_code, false);

        if (parsed.shift) postWindowsVirtualKey(c_windows.VK_SHIFT, false);
        if (parsed.ctrl) postWindowsVirtualKey(c_windows.VK_CONTROL, false);
        if (parsed.alt) postWindowsVirtualKey(c_windows.VK_MENU, false);
        if (parsed.cmd) postWindowsVirtualKey(c_windows.VK_LWIN, false);

        if (delay_ns > 0 and index + 1 < repeat_count) {
            std.Thread.sleep(delay_ns);
        }
    }
}

fn typeTextX11(input: TypeTextInput) !void {
    const delay_ns = normalizedDelayNs(input.delayMs);
    const display = c_x11.XOpenDisplay(null) orelse return error.XOpenDisplayFailed;
    defer _ = c_x11.XCloseDisplay(display);

    for (input.text) |byte| {
        if (byte >= 0x80) {
            return error.NonAsciiUnsupported;
        }
        var key_name = [_:0]u8{ byte, 0 };
        const key_sym = c_x11.XStringToKeysym(&key_name);
        if (key_sym == 0) {
            return error.UnknownKey;
        }
        const key_code = c_x11.XKeysymToKeycode(display, @intCast(key_sym));
        _ = c_x11.XTestFakeKeyEvent(display, key_code, c_x11.True, c_x11.CurrentTime);
        _ = c_x11.XTestFakeKeyEvent(display, key_code, c_x11.False, c_x11.CurrentTime);
        _ = c_x11.XFlush(display);
        if (delay_ns > 0) {
            std.Thread.sleep(delay_ns);
        }
    }
}

fn keySymForX11Key(key_name: []const u8) !c_ulong {
    if (key_name.len == 1) {
        var key_buffer = [_:0]u8{ key_name[0], 0 };
        const key_sym = c_x11.XStringToKeysym(&key_buffer);
        if (key_sym == 0) return error.UnknownKey;
        return @intCast(key_sym);
    }

    if (std.ascii.eqlIgnoreCase(key_name, "enter") or std.ascii.eqlIgnoreCase(key_name, "return")) return c_x11.XK_Return;
    if (std.ascii.eqlIgnoreCase(key_name, "tab")) return c_x11.XK_Tab;
    if (std.ascii.eqlIgnoreCase(key_name, "space")) return c_x11.XK_space;
    if (std.ascii.eqlIgnoreCase(key_name, "escape") or std.ascii.eqlIgnoreCase(key_name, "esc")) return c_x11.XK_Escape;
    if (std.ascii.eqlIgnoreCase(key_name, "backspace")) return c_x11.XK_BackSpace;
    if (std.ascii.eqlIgnoreCase(key_name, "delete")) return c_x11.XK_Delete;
    if (std.ascii.eqlIgnoreCase(key_name, "left")) return c_x11.XK_Left;
    if (std.ascii.eqlIgnoreCase(key_name, "right")) return c_x11.XK_Right;
    if (std.ascii.eqlIgnoreCase(key_name, "up")) return c_x11.XK_Up;
    if (std.ascii.eqlIgnoreCase(key_name, "down")) return c_x11.XK_Down;
    if (std.ascii.eqlIgnoreCase(key_name, "home")) return c_x11.XK_Home;
    if (std.ascii.eqlIgnoreCase(key_name, "end")) return c_x11.XK_End;
    if (std.ascii.eqlIgnoreCase(key_name, "pageup")) return c_x11.XK_Page_Up;
    if (std.ascii.eqlIgnoreCase(key_name, "pagedown")) return c_x11.XK_Page_Down;
    return error.UnknownKey;
}

fn postX11Key(display: *c_x11.Display, key_sym: c_ulong, is_down: bool) !void {
    const key_code = c_x11.XKeysymToKeycode(display, @intCast(key_sym));
    if (key_code == 0) {
        return error.UnknownKey;
    }
    _ = c_x11.XTestFakeKeyEvent(display, key_code, if (is_down) c_x11.True else c_x11.False, c_x11.CurrentTime);
    _ = c_x11.XFlush(display);
}

fn pressX11(input: PressInput) !void {
    const parsed = try parsePressKey(input.key);
    const key_sym = try keySymForX11Key(parsed.key);
    const repeat_count = normalizedCount(input.count);
    const delay_ns = normalizedDelayNs(input.delayMs);

    const display = c_x11.XOpenDisplay(null) orelse return error.XOpenDisplayFailed;
    defer _ = c_x11.XCloseDisplay(display);

    var index: u32 = 0;
    while (index < repeat_count) : (index += 1) {
        if (parsed.cmd) try postX11Key(display, c_x11.XK_Super_L, true);
        if (parsed.alt) try postX11Key(display, c_x11.XK_Alt_L, true);
        if (parsed.ctrl) try postX11Key(display, c_x11.XK_Control_L, true);
        if (parsed.shift) try postX11Key(display, c_x11.XK_Shift_L, true);

        try postX11Key(display, key_sym, true);
        try postX11Key(display, key_sym, false);

        if (parsed.shift) try postX11Key(display, c_x11.XK_Shift_L, false);
        if (parsed.ctrl) try postX11Key(display, c_x11.XK_Control_L, false);
        if (parsed.alt) try postX11Key(display, c_x11.XK_Alt_L, false);
        if (parsed.cmd) try postX11Key(display, c_x11.XK_Super_L, false);

        if (delay_ns > 0 and index + 1 < repeat_count) {
            std.Thread.sleep(delay_ns);
        }
    }
}

fn createScreenshotImage(input: struct {
    display_index: ?f64,
    window_id: ?f64,
    region: ?ScreenshotRegion,
}) !ScreenshotCapture {
    if (input.window_id != null and input.region != null) {
        return error.InvalidScreenshotInput;
    }

    if (input.window_id) |window_id| {
        const normalized_window_id = normalizeWindowId(window_id) catch {
            return error.InvalidWindowId;
        };
        const window_bounds = findWindowBoundsById(normalized_window_id) catch {
            return error.WindowNotFound;
        };
        const selected_display = resolveDisplayForRect(window_bounds) catch {
            return error.DisplayResolutionFailed;
        };

        const window_image = c.CGDisplayCreateImageForRect(selected_display.id, window_bounds);
        if (window_image == null) {
            return error.CaptureFailed;
        }
        return .{
            .image = window_image,
            .capture_x = window_bounds.origin.x,
            .capture_y = window_bounds.origin.y,
            .capture_width = window_bounds.size.width,
            .capture_height = window_bounds.size.height,
            .desktop_index = selected_display.index,
        };
    }

    const selected_display = resolveDisplayId(input.display_index) catch {
        return error.DisplayResolutionFailed;
    };

    if (input.region) |region| {
        const rect: c.CGRect = .{
            .origin = .{
                .x = selected_display.bounds.origin.x + region.x,
                .y = selected_display.bounds.origin.y + region.y,
            },
            .size = .{ .width = region.width, .height = region.height },
        };
        const region_image = c.CGDisplayCreateImageForRect(selected_display.id, rect);
        if (region_image == null) {
            return error.CaptureFailed;
        }
        return .{
            .image = region_image,
            .capture_x = rect.origin.x,
            .capture_y = rect.origin.y,
            .capture_width = rect.size.width,
            .capture_height = rect.size.height,
            .desktop_index = selected_display.index,
        };
    }

    const full_image = c.CGDisplayCreateImage(selected_display.id);
    if (full_image == null) {
        return error.CaptureFailed;
    }
    return .{
        .image = full_image,
        .capture_x = selected_display.bounds.origin.x,
        .capture_y = selected_display.bounds.origin.y,
        .capture_width = selected_display.bounds.size.width,
        .capture_height = selected_display.bounds.size.height,
        .desktop_index = selected_display.index,
    };
}

fn normalizeWindowId(raw_id: f64) !u32 {
    const normalized = @as(i64, @intFromFloat(std.math.round(raw_id)));
    if (normalized <= 0) {
        return error.InvalidWindowId;
    }
    return @intCast(normalized);
}

fn findWindowBoundsById(target_window_id: u32) !c.CGRect {
    const Context = struct {
        target_id: u32,
        bounds: ?c.CGRect = null,
    };

    var context = Context{ .target_id = target_window_id };
    window.forEachVisibleWindow(Context, &context, struct {
        fn callback(ctx: *Context, info: window.WindowInfo) !void {
            if (info.id != ctx.target_id) {
                return;
            }
            ctx.bounds = .{
                .origin = .{ .x = info.bounds.x, .y = info.bounds.y },
                .size = .{ .width = info.bounds.width, .height = info.bounds.height },
            };
            return error.Found;
        }
    }.callback) catch |err| {
        if (err != error.Found) {
            return err;
        }
    };

    if (context.bounds) |bounds| {
        return bounds;
    }
    return error.WindowNotFound;
}

fn resolveDisplayForRect(rect: c.CGRect) !SelectedDisplay {
    var display_ids: [16]c.CGDirectDisplayID = undefined;
    var display_count: u32 = 0;
    const list_result = c.CGGetActiveDisplayList(display_ids.len, &display_ids, &display_count);
    if (list_result != c.kCGErrorSuccess or display_count == 0) {
        return error.DisplayQueryFailed;
    }

    var best_index: usize = 0;
    var best_overlap: f64 = -1;
    var i: usize = 0;
    while (i < display_count) : (i += 1) {
        const bounds = c.CGDisplayBounds(display_ids[i]);
        const overlap = intersectionArea(rect, bounds);
        if (overlap > best_overlap) {
            best_overlap = overlap;
            best_index = i;
        }
    }

    const id = display_ids[best_index];
    return .{
        .id = id,
        .index = best_index,
        .bounds = c.CGDisplayBounds(id),
    };
}

fn intersectionArea(a: c.CGRect, b: c.CGRect) f64 {
    const left = @max(a.origin.x, b.origin.x);
    const top = @max(a.origin.y, b.origin.y);
    const right = @min(a.origin.x + a.size.width, b.origin.x + b.size.width);
    const bottom = @min(a.origin.y + a.size.height, b.origin.y + b.size.height);
    if (right <= left or bottom <= top) {
        return 0;
    }
    return (right - left) * (bottom - top);
}

fn serializeWindowListJson() ![]u8 {
    const Context = struct {
        stream: *std.io.FixedBufferStream([]u8),
        first: bool,
    };

    var write_buffer: [64 * 1024]u8 = undefined;
    var stream = std.io.fixedBufferStream(&write_buffer);

    try stream.writer().writeByte('[');
    var context = Context{ .stream = &stream, .first = true };

    try window.forEachVisibleWindow(Context, &context, struct {
        fn callback(ctx: *Context, info: window.WindowInfo) !void {
            const rect: c.CGRect = .{
                .origin = .{ .x = info.bounds.x, .y = info.bounds.y },
                .size = .{ .width = info.bounds.width, .height = info.bounds.height },
            };
            const selected_display = resolveDisplayForRect(rect) catch {
                return;
            };
            const item = WindowInfoOutput{
                .id = info.id,
                .ownerPid = info.owner_pid,
                .ownerName = info.owner_name,
                .title = info.title,
                .x = info.bounds.x,
                .y = info.bounds.y,
                .width = info.bounds.width,
                .height = info.bounds.height,
                .desktopIndex = @intCast(selected_display.index),
            };

            if (!ctx.first) {
                try ctx.stream.writer().writeByte(',');
            }
            ctx.first = false;
            try ctx.stream.writer().print("{f}", .{std.json.fmt(item, .{})});
        }
    }.callback);

    try stream.writer().writeByte(']');
    return std.heap.c_allocator.dupe(u8, stream.getWritten());
}

fn scaleScreenshotImageIfNeeded(image: c.CGImageRef) !ScaledScreenshotImage {
    const image_width = @as(f64, @floatFromInt(c.CGImageGetWidth(image)));
    const image_height = @as(f64, @floatFromInt(c.CGImageGetHeight(image)));
    const long_edge = @max(image_width, image_height);
    if (long_edge <= screenshot_max_long_edge_px) {
        _ = c.CFRetain(image);
        return .{
            .image = image,
            .width = image_width,
            .height = image_height,
        };
    }

    const scale = screenshot_max_long_edge_px / long_edge;
    const target_width = @max(1, @as(usize, @intFromFloat(std.math.round(image_width * scale))));
    const target_height = @max(1, @as(usize, @intFromFloat(std.math.round(image_height * scale))));

    const color_space = c.CGColorSpaceCreateDeviceRGB();
    if (color_space == null) {
        return error.ScaleFailed;
    }
    defer c.CFRelease(color_space);

    const bitmap_info: c.CGBitmapInfo = c.kCGImageAlphaPremultipliedLast;
    const context = c.CGBitmapContextCreate(
        null,
        target_width,
        target_height,
        8,
        0,
        color_space,
        bitmap_info,
    );
    if (context == null) {
        return error.ScaleFailed;
    }
    defer c.CFRelease(context);

    c.CGContextSetInterpolationQuality(context, c.kCGInterpolationHigh);
    const draw_rect: c.CGRect = .{
        .origin = .{ .x = 0, .y = 0 },
        .size = .{
            .width = @as(c.CGFloat, @floatFromInt(target_width)),
            .height = @as(c.CGFloat, @floatFromInt(target_height)),
        },
    };
    c.CGContextDrawImage(context, draw_rect, image);

    const scaled = c.CGBitmapContextCreateImage(context);
    if (scaled == null) {
        return error.ScaleFailed;
    }
    return .{
        .image = scaled,
        .width = @as(f64, @floatFromInt(target_width)),
        .height = @as(f64, @floatFromInt(target_height)),
    };
}

fn resolveDisplayId(display_index: ?f64) !SelectedDisplay {
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
    const selected_id = display_ids[selected_index];
    const bounds = c.CGDisplayBounds(selected_id);
    return .{
        .id = selected_id,
        .index = selected_index,
        .bounds = bounds,
    };
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
    try js.setNamedProperty(exports, "windowList", try js.createFunction(windowList));
    try js.setNamedProperty(exports, "clipboardGet", try js.createFunction(clipboardGet));
    try js.setNamedProperty(exports, "clipboardSet", try js.createFunction(clipboardSet));
    return exports;
}

comptime {
    if (!builtin.is_test) {
        napigen.defineModule(initModule);
    }
}
