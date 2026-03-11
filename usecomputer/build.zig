// Build script for usecomputer Zig N-API native module artifacts.

const std = @import("std");
const napigen = @import("napigen");

const LIB_NAME = "usecomputer";

pub fn build(b: *std.Build) void {
    const target = b.standardTargetOptions(.{});
    const optimize = b.standardOptimizeOption(.{});

    const lib_mod = b.createModule(.{
        .root_source_file = b.path("zig/src/lib.zig"),
        .target = target,
        .optimize = optimize,
    });
    lib_mod.addImport("napigen", b.dependency("napigen", .{}).module("napigen"));
    lib_mod.addImport("objc", b.dependency("zig_objc", .{
        .target = target,
        .optimize = optimize,
    }).module("objc"));

    const lib = b.addLibrary(.{
        .name = LIB_NAME,
        .root_module = lib_mod,
        .linkage = .dynamic,
    });

    if (target.result.os.tag == .macos) {
        lib.root_module.linkFramework("ApplicationServices", .{});
        lib.root_module.linkFramework("CoreFoundation", .{});
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
    const run_test = b.addRunArtifact(test_exe);
    test_step.dependOn(&run_test.step);
}
