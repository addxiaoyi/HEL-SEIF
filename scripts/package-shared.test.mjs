import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
