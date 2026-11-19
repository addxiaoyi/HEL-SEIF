import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { test } from "node:test";
import { stageSharedRuntime } from "./package-shared.mjs";

test("staged AI service resolves compiled shared modules without the source tree", async (t) => {
  const stage = await mkdtemp(join(tmpdir(), "helself-shared-runtime-"));
  t.after(() => rm(stage, { recursive: true, force: true }));
  await writeFile(join(stage, "package.json"), '{"type":"module"}');
  const shared = await stageSharedRuntime(resolve(import.meta.dirname, ".."), stage);
  assert.deepEqual(shared.sort(), ["src/lib/messy-intake.ts", "src/lib/work-tidy.ts"]);
  const service = await readFile(join(stage, "electron/services/agent-service.mjs"), "utf8");
  assert.match(service, /src\/lib\/work-tidy\.js/);
  assert.match(service, /src\/lib\/messy-intake\.js/);
  assert.doesNotMatch(service, /from ["'][^"']+\.ts["']/);
  const intake = await import(pathToFileURL(join(stage, "src/lib/messy-intake.js")));
  const tidy = await import(pathToFileURL(join(stage, "src/lib/work-tidy.js")));
  assert.equal(intake.parseMessyText("example.com 到期 2027-01-01").entries[0].kind, "domain");
  assert.equal(typeof tidy.tidyReport, "function");
});

test("Docker runtime imports the self-hosted server after in-place staging without TypeScript sources", async (t) => {
  const root = resolve(import.meta.dirname, "..");
  const stage = await mkdtemp(join(tmpdir(), "helself-docker-runtime-"));
  t.after(() => rm(stage, { recursive: true, force: true }));
  const sharedNames = ["messy-intake", "work-tidy"];
  await cp(join(root, "electron"), join(stage, "electron"), { recursive: true });
  await cp(join(root, "selfhost"), join(stage, "selfhost"), { recursive: true });
  await mkdir(join(stage, "src/lib"), { recursive: true });
  for (const name of sharedNames)
    await cp(join(root, `src/lib/${name}.ts`), join(stage, `src/lib/${name}.ts`));
  await writeFile(
    join(stage, "package.json"),
    JSON.stringify({ type: "module", version: "0.0.0-test" }),
  );
  await symlink(
    join(root, "node_modules"),
    join(stage, "node_modules"),
    process.platform === "win32" ? "junction" : "dir",
  );

  const shared = await stageSharedRuntime(stage, stage);
  assert.deepEqual(
    shared.sort(),
    sharedNames.map((name) => `src/lib/${name}.ts`),
  );
  // The final Docker layer only carries compiled shared modules, never the source tree.
  for (const name of sharedNames) await rm(join(stage, `src/lib/${name}.ts`));
  assert.deepEqual(
    (await readdir(join(stage, "src/lib"))).sort(),
    sharedNames.map((name) => `${name}.js`),
  );

  const service = await readFile(join(stage, "electron/services/agent-service.mjs"), "utf8");
  for (const name of sharedNames) assert.ok(service.includes(`../../src/lib/${name}.js`));
  assert.doesNotMatch(service, /from ["'][^"']+\.ts["']/);
  // Importing must resolve the complete server graph without creating an account or listening.
  const server = await import(pathToFileURL(join(stage, "selfhost/server.mjs")));
  assert.equal(typeof server.createWebServer, "function");
  assert.deepEqual((await readdir(stage)).sort(), [
    "electron",
    "node_modules",
    "package.json",
    "selfhost",
    "src",
  ]);
});
