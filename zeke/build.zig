const std = @import("std");

pub fn build(b: *std.Build) void {
    const target = b.standardTargetOptions(.{});
    const optimize = b.standardOptimizeOption(.{});

    // Expose as a named module so dependents can do:
    //   b.dependency("zeke", .{}).module("zeke")
    const zeke_mod = b.addModule("zeke", .{
        .root_source_file = b.path("src/root.zig"),
    });

    // Tests
    const test_step = b.step("test", "Run unit tests");
    const unit_tests = b.addTest(.{
        .root_module = b.createModule(.{
            .root_source_file = b.path("src/root.zig"),
            .target = target,
            .optimize = optimize,
        }),
    });
    const run_tests = b.addRunArtifact(unit_tests);
    test_step.dependOn(&run_tests.step);

    // Example executable
    const example_mod = b.createModule(.{
        .root_source_file = b.path("example/main.zig"),
        .target = target,
        .optimize = optimize,
    });
    example_mod.addImport("zeke", zeke_mod);

    const example = b.addExecutable(.{
        .name = "example",
        .root_module = example_mod,
    });
    b.installArtifact(example);

    const run_example = b.addRunArtifact(example);
    if (b.args) |args| {
        run_example.addArgs(args);
    }
    const run_step = b.step("run", "Run the example");
    run_step.dependOn(&run_example.step);
}
