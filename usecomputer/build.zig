// Build script for usecomputer — produces both:
// 1. Dynamic library (.node) for N-API consumption from Node.js
// 2. Standalone executable CLI (no Node.js required, uses zeke)

const std = @import("std");
const napigen = @import("napigen");

const LIB_NAME = "usecomputer";

/// Link platform-specific libraries needed by the native core.
fn linkPlatformDeps(mod: *std.Build.Module, target_os: std.Target.Os.Tag) void {
    if (target_os == .macos) {
        mod.linkFramework("CoreGraphics", .{});
        mod.linkFramework("CoreFoundation", .{});
        mod.linkFramework("ImageIO", .{});
    }
    if (target_os == .linux) {
        mod.linkSystemLibrary("X11", .{});
        mod.linkSystemLibrary("Xext", .{});
        mod.linkSystemLibrary("Xtst", .{});
        mod.linkSystemLibrary("png", .{});
    }
    if (target_os == .windows) {
        mod.linkSystemLibrary("user32", .{});
    }
}

pub fn build(b: *std.Build) void {
    const target = b.standardTargetOptions(.{});
    const optimize = b.standardOptimizeOption(.{});
    const target_os = target.result.os.tag;

    // ── N-API dynamic library (.node) ──

    // Build options for lib.zig: enable_napigen controls N-API glue
    const lib_options = b.addOptions();
    lib_options.addOption(bool, "enable_napigen", true);
    const lib_options_mod = lib_options.createModule();

    const lib_mod = b.createModule(.{
        .root_source_file = b.path("zig/src/lib.zig"),
        .target = target,
        .optimize = optimize,
    });
    lib_mod.addImport("build_options", lib_options_mod);
    lib_mod.addImport("napigen", b.dependency("napigen", .{}).module("napigen"));
    if (target_os == .macos) {
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
    linkPlatformDeps(lib.root_module, target_os);

    napigen.setup(lib);
    b.installArtifact(lib);

    const copy_node_step = b.addInstallLibFile(lib.getEmittedBin(), LIB_NAME ++ ".node");
    b.getInstallStep().dependOn(&copy_node_step.step);

    // ── Standalone executable CLI ──
    //
    // Uses a separate copy of lib.zig WITHOUT napigen so the executable
    // doesn't try to link N-API symbols (those only exist in Node.js).

    const exe_options = b.addOptions();
    exe_options.addOption(bool, "enable_napigen", false);
    const exe_options_mod = exe_options.createModule();

    const exe_lib_mod = b.createModule(.{
        .root_source_file = b.path("zig/src/lib.zig"),
        .target = target,
        .optimize = optimize,
    });
    exe_lib_mod.addImport("build_options", exe_options_mod);
    if (target_os == .macos) {
        if (b.lazyDependency("zig_objc", .{
            .target = target,
            .optimize = optimize,
        })) |dep| {
            exe_lib_mod.addImport("objc", dep.module("objc"));
        }
    }

    const exe_mod = b.createModule(.{
        .root_source_file = b.path("zig/src/main.zig"),
        .target = target,
        .optimize = optimize,
    });
    exe_mod.addImport("usecomputer_lib", exe_lib_mod);
    exe_mod.addImport("zeke", b.dependency("zeke", .{
        .target = target,
        .optimize = optimize,
    }).module("zeke"));

    const exe = b.addExecutable(.{
        .name = LIB_NAME,
        .root_module = exe_mod,
    });
    linkPlatformDeps(exe.root_module, target_os);
    // The standalone exe uses c_allocator and system libs that require libc.
    // The N-API .node lib gets this automatically through napigen, but the
    // exe needs it explicitly — otherwise native builds fail with
    // "C allocator is only available when linking against libc".
    exe.root_module.link_libc = true;
    b.installArtifact(exe);

    const run_exe = b.addRunArtifact(exe);
    if (b.args) |args| {
        run_exe.addArgs(args);
    }
    const run_step = b.step("run", "Run the CLI");
    run_step.dependOn(&run_exe.step);

    // ── Tests ──

    const test_options = b.addOptions();
    test_options.addOption(bool, "enable_napigen", false);

    const test_mod = b.createModule(.{
        .root_source_file = b.path("zig/src/lib.zig"),
        .target = target,
        .optimize = optimize,
    });
    test_mod.addImport("build_options", test_options.createModule());

    const test_step = b.step("test", "Run Zig unit tests");
    const test_exe = b.addTest(.{
        .root_module = test_mod,
    });
    linkPlatformDeps(test_exe.root_module, target_os);
    const run_test = b.addRunArtifact(test_exe);
    test_step.dependOn(&run_test.step);
}
