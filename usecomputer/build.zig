// Build script for usecomputer Zig N-API native module artifacts.

const std = @import("std");
const napigen = @import("napigen");

const LIB_NAME = "usecomputer";

pub fn build(b: *std.Build) void {
    const target = b.standardTargetOptions(.{});
    const optimize = b.standardOptimizeOption(.{});
    const target_os = target.result.os.tag;

    const lib_mod = b.createModule(.{
        .root_source_file = b.path("zig/src/lib.zig"),
        .target = target,
        .optimize = optimize,
    });
    lib_mod.addImport("napigen", b.dependency("napigen", .{}).module("napigen"));
    if (target_os == .macos) {
        // zig_objc is a lazy dependency — only fetched when building for macOS
        if (b.lazyDependency("zig_objc", .{
            .target = target,
            .optimize = optimize,
        })) |dep| {
            lib_mod.addImport("objc", dep.module("objc"));
        }
    }

    const lib = b.addLibrary(.{
        .name = LIB_NAME,
        .root_module = lib_mod,
        .linkage = .dynamic,
    });

    if (target_os == .macos) {
        lib.root_module.linkFramework("CoreGraphics", .{});
        lib.root_module.linkFramework("CoreFoundation", .{});
        lib.root_module.linkFramework("ImageIO", .{});
    }
    if (target_os == .linux) {
        lib.root_module.linkSystemLibrary("X11", .{});
        lib.root_module.linkSystemLibrary("Xext", .{});
        lib.root_module.linkSystemLibrary("Xtst", .{});
        lib.root_module.linkSystemLibrary("png", .{});
    }
    if (target_os == .windows) {
        lib.root_module.linkSystemLibrary("user32", .{});
    }

    napigen.setup(lib);
    b.installArtifact(lib);

    const copy_node_step = b.addInstallLibFile(lib.getEmittedBin(), LIB_NAME ++ ".node");
    b.getInstallStep().dependOn(&copy_node_step.step);

    const test_mod = b.createModule(.{
        .root_source_file = b.path("zig/src/lib.zig"),
        .target = target,
        .optimize = optimize,
    });

    const test_step = b.step("test", "Run Zig unit tests");
    const test_exe = b.addTest(.{
        .root_module = test_mod,
    });
    if (target_os == .linux) {
        test_exe.root_module.linkSystemLibrary("X11", .{});
        test_exe.root_module.linkSystemLibrary("Xext", .{});
        test_exe.root_module.linkSystemLibrary("Xtst", .{});
        test_exe.root_module.linkSystemLibrary("png", .{});
    }
    const run_test = b.addRunArtifact(test_exe);
    test_step.dependOn(&run_test.step);
}
