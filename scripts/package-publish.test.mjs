import assert from "node:assert/strict";
import { test } from "node:test";
import { desktopBuildArguments } from "./package-stage.mjs";

test("local packaging always disables publishing, including repeated flags", () => {
  assert.deepEqual(desktopBuildArguments([]), ["--publish", "never"]);
  assert.deepEqual(
    desktopBuildArguments(["--publish", "never", "--win", "--x64", "--publish", "never"]),
    ["--win", "--x64", "--publish", "never"],
  );
  assert.deepEqual(desktopBuildArguments(["--dir", "--publish=never", "-p", "never"]), [
    "--dir",
    "--publish",
    "never",
  ]);
});

test("local packaging rejects publishing modes and incomplete flags", () => {
  for (const args of [
    ["--publish", "always"],
    ["--publish=onTag"],
    ["--publish"],
    ["-p", "always"],
  ])
    assert.throws(() => desktopBuildArguments(args), /本地打包不允许发布/);
});

test("abbreviated publishing flags and config overrides cannot bypass local-only packaging", () => {
  for (const arg of [
    "-p=always",
    "-palways",
    "--pub",
    "--config.publish.provider=github",
    "--config",
  ])
    assert.throws(() => desktopBuildArguments([arg]), /不支持的本地打包参数/);
});
