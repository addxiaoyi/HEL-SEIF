import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import { parseReleases, renderChangelog } from "./write-changelog.mjs";

const runNode = promisify(execFile);
const root = resolve(import.meta.dirname, "..");
const release = {
  version: "1.2.3",
  date: "2026-11-19",
  title: 'Quotes "and" [brackets]',
  changes: ["Keep [nested [brackets]] and ] delimiters.", 'Keep "quotes", \\slashes and 中文.'],
};
const sourceFor = (entries, spacing) =>
  `export const RELEASES: Release[] = ${JSON.stringify(entries, null, spacing)};`;

test("single-line and multiline release arrays retain escaped strings and bracket content", () => {
  for (const spacing of [undefined, 2, 4]) {
    const source = sourceFor([release], spacing).replaceAll("\n", "\r\n");
    assert.deepEqual(parseReleases(source), [release]);
  }
  const singleQuoted =
    "export const RELEASES = [{ version: '1.2.3', date: '2026-11-19', title: 'Title', changes: ['It\\'s [safe]'] }];";
  assert.equal(parseReleases(singleQuoted)[0].changes[0], "It's [safe]");
});

test("the current single-line v1.12.2 entry retains every change in the Markdown", async () => {
  const entries = parseReleases(await readFile(join(root, "src/lib/changelog.ts"), "utf8"));
  const legacy = entries.find((entry) => entry.version === "1.12.2");
  assert.ok(legacy);
  assert.ok(legacy.changes.length > 0);
  const markdown = renderChangelog(entries);
  for (const change of legacy.changes) assert.ok(markdown.includes(`- ${change}\n`));
});

test("Markdown keeps the established release heading, date and bullet layout", () => {
  const markdown = renderChangelog([release]);
  assert.match(markdown, /^# 更新日志\n\n/);
  assert.ok(
    markdown.endsWith(
      `## ${release.version} — ${release.title}\n\n_${release.date}_\n\n${release.changes.map((change) => `- ${change}`).join("\n")}\n`,
    ),
  );
});

test("missing, empty, malformed or executable RELEASES values fail explicitly", () => {
  const invalid = [
    "",
    "export const OTHER = [];",
    "export const RELEASES = [];",
    "export const RELEASES = [",
    "export let RELEASES = [];",
    "export const RELEASES = loadReleases();",
    "export const RELEASES = [null];",
    "export const RELEASES = [{...release}];",
    sourceFor([{ ...release, date: null }]),
    sourceFor([{ ...release, changes: [] }]),
    sourceFor([{ ...release, changes: ["valid", 2] }]),
    sourceFor([{ ...release, changes: [""] }]),
    sourceFor([release]).replace('"changes":', '"version": "duplicate", "changes":'),
    "export const RELEASES = [{version: '1.2.3', date: '2026-11-19', title: 'Title', changes: [(() => { throw new Error('executed'); })()]}];",
  ];
  for (const source of invalid) assert.throws(() => parseReleases(source), /RELEASES/);
});

test("import is inert, while CLI validates before writing and preserves the output on failure", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "helself-changelog-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(join(directory, "scripts"));
  await mkdir(join(directory, "src/lib"), { recursive: true });
  const script = join(directory, "scripts/write-changelog.mjs");
  const source = join(directory, "src/lib/changelog.ts");
  const output = join(directory, "CHANGELOG.md");
  await cp(join(root, "scripts/write-changelog.mjs"), script);
  await symlink(
    join(root, "node_modules"),
    join(directory, "node_modules"),
    process.platform === "win32" ? "junction" : "dir",
  );
  await writeFile(source, "export const RELEASES = [];");
  await writeFile(output, "preserve existing changelog\n");
  const imported = await runNode(process.execPath, [
    "--input-type=module",
    "-e",
    `await import(${JSON.stringify(pathToFileURL(script).href)});`,
  ]);
  assert.equal(imported.stdout, "");
  assert.equal(await readFile(output, "utf8"), "preserve existing changelog\n");

  await writeFile(source, sourceFor([release]));
  const generated = await runNode(process.execPath, [script]);
  assert.match(generated.stdout, /CHANGELOG\.md written \(1 release\)/);
  assert.equal(await readFile(output, "utf8"), renderChangelog([release]));

  await writeFile(source, "export const RELEASES = [];");
  await assert.rejects(runNode(process.execPath, [script]), /RELEASES/);
  assert.equal(await readFile(output, "utf8"), renderChangelog([release]));
});
